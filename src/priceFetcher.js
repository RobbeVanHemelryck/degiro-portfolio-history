/**
 * Fetch historical price data from Yahoo Finance.
 */
let yahooFinance;
async function getYahoo() {
  if (!yahooFinance) {
    const mod = await import('yahoo-finance2');
    const YahooFinance = mod.default;
    yahooFinance = new YahooFinance({ queue: { concurrency: 1 } });
  }
  return yahooFinance;
}
const { getDb } = require('./database');
const { getTickerForStock } = require('./tickerResolver');

// Simple rate limiter
let lastRequestTime = 0;
const MIN_INTERVAL = 5000; // 5 seconds between requests

async function rateLimitWait() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL - elapsed));
  }
  lastRequestTime = Date.now();
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 10000; // 10 seconds base delay for retries

/**
 * Fetch historical prices for a stock and store them in the database.
 * Returns the number of new price records added.
 */
async function fetchStockPrices(stock) {
  let ticker = stock.yahoo_ticker || await getTickerForStock(stock.isin, stock.name, stock.currency);
  if (!ticker) return 0;

  const db = getDb();

  // Incremental updates: if we already have daily history, fetch only a recent window
  // to backfill missed days and absorb minor provider corrections.
  const latestDaily = db.prepare(
    'SELECT date FROM stock_prices WHERE stock_id = ? AND date GLOB ? ORDER BY date DESC LIMIT 1'
  ).get(stock.id, '????-??-??');

  let startDate;
  if (latestDaily?.date) {
    startDate = new Date(`${latestDaily.date}T00:00:00Z`);
    startDate.setUTCDate(startDate.getUTCDate() - 7);
  } else {
    const earliest = db.prepare(
      'SELECT MIN(date) as min_date FROM transactions WHERE stock_id = ?'
    ).get(stock.id);
    startDate = earliest?.min_date
      ? new Date(earliest.min_date)
      : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  }

  const endDate = new Date();

  const tickersToTry = [ticker];

  for (const currentTicker of tickersToTry) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await rateLimitWait();

      try {
        const yf = await getYahoo();
        const result = await yf.chart(currentTicker, {
          period1: startDate,
          period2: endDate,
          interval: '1d',
        });

        if (!result?.quotes?.length) break; // try next ticker

        // Try to get actual currency from the result metadata
        let actualCurrency = stock.currency;
        if (result.meta?.currency) {
          actualCurrency = result.meta.currency;
        }

        const insert = db.prepare(`
          INSERT OR IGNORE INTO stock_prices (stock_id, date, open, high, low, close, volume, currency)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = db.transaction((quotes) => {
          let count = 0;
          for (const q of quotes) {
            if (q.close == null) continue;
            const dateStr = q.date.toISOString().split('T')[0];

            // Check if already exists
            const existing = db.prepare(
              'SELECT id FROM stock_prices WHERE stock_id = ? AND date = ?'
            ).get(stock.id, dateStr);

            if (!existing) {
              insert.run(
                stock.id, dateStr,
                q.open, q.high, q.low, q.close,
                q.volume || 0, actualCurrency
              );
              count++;
            }
          }
          return count;
        });

        const count = insertMany(result.quotes);

        // Update ticker if we used a fallback
        if (currentTicker !== ticker) {
          db.prepare('UPDATE stocks SET yahoo_ticker = ? WHERE id = ?').run(currentTicker, stock.id);
          console.log(`Updated ticker for ${stock.name}: ${ticker} -> ${currentTicker}`);
        }

        // Update data provider
        if (stock.data_provider !== 'yahoo') {
          db.prepare('UPDATE stocks SET data_provider = ? WHERE id = ?').run('yahoo', stock.id);
        }

        return count;
      } catch (err) {
        const isRateLimit = err.message && (err.message.includes('Too Many Requests') || err.message.includes('429'));
        if (isRateLimit && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY * (attempt + 1);
          console.warn(`Rate limited fetching ${stock.name} (${currentTicker}), retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        const isDelisted = err.message && (err.message.includes('No data found') || err.message.includes('delisted'));
        if (isDelisted && tickersToTry.length === 1 && stock.isin) {
          // Try to find an alternative ticker by searching Yahoo with the ISIN
          console.warn(`Ticker ${currentTicker} failed for ${stock.name}, searching by ISIN ${stock.isin}...`);
          const altTicker = await searchTickerByIsin(stock.isin);
          if (altTicker && altTicker !== currentTicker) {
            console.log(`Found alternative ticker for ${stock.name}: ${altTicker}`);
            tickersToTry.push(altTicker);
          }
        }

        console.error(`Error fetching prices for ${stock.name} (${currentTicker}):`, err.message);
        break; // move to next ticker
      }
    }
  }
  return 0;
}

/**
 * Search Yahoo Finance for a ticker by ISIN as a fallback.
 */
async function searchTickerByIsin(isin) {
  try {
    await rateLimitWait();
    const yf = await getYahoo();
    const result = await yf.search(isin);
    if (result?.quotes?.length) {
      const match = result.quotes.find((q) => q.isYahooFinance);
      return match?.symbol || null;
    }
  } catch (err) {
    console.error(`Error searching for ISIN ${isin}:`, err.message);
  }
  return null;
}

/**
 * Fetch index historical data.
 */
async function fetchIndexPrices(symbol, indexId, period = '5y') {
  const db = getDb();

  await rateLimitWait();

  try {
    const endDate = new Date();
    const startDate = new Date();
    if (period === '5y') startDate.setFullYear(startDate.getFullYear() - 5);
    else if (period === '7d') startDate.setDate(startDate.getDate() - 7);

    const yf = await getYahoo();
    const result = await yf.chart(symbol, {
      period1: startDate,
      period2: endDate,
      interval: '1d',
    });

    if (!result?.quotes?.length) return 0;

    const insert = db.prepare(`
      INSERT OR IGNORE INTO index_prices (index_id, date, close)
      VALUES (?, ?, ?)
    `);

    let count = 0;
    const insertMany = db.transaction((quotes) => {
      for (const q of quotes) {
        if (q.close == null) continue;
        const dateStr = q.date.toISOString().split('T')[0];
        const existing = db.prepare(
          'SELECT id FROM index_prices WHERE index_id = ? AND date = ?'
        ).get(indexId, dateStr);
        if (!existing) {
          insert.run(indexId, dateStr, q.close);
          count++;
        }
      }
    });

    insertMany(result.quotes);
    return count;
  } catch (err) {
    console.error(`Error fetching index ${symbol}:`, err.message);
    return 0;
  }
}

/**
 * Fetch a live quote for a single ticker.
 */
async function fetchLiveQuote(ticker) {
  await rateLimitWait();
  try {
    const yf = await getYahoo();
    const quote = await yf.quote(ticker);
    if (!quote) return null;
    return {
      price: quote.regularMarketPrice,
      change: quote.regularMarketChange,
      change_percent: quote.regularMarketChangePercent,
      open: quote.regularMarketOpen,
      high: quote.regularMarketDayHigh,
      low: quote.regularMarketDayLow,
      volume: quote.regularMarketVolume,
      timestamp: quote.regularMarketTime ? new Date(quote.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
      currency: quote.currency,
    };
  } catch (err) {
    console.error(`Error fetching quote for ${ticker}:`, err.message);
    return null;
  }
}

module.exports = { fetchStockPrices, fetchIndexPrices, fetchLiveQuote, rateLimitWait };
