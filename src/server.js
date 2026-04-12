const express = require('express');
const path = require('path');
const multer = require('multer');
const { config } = require('./config');
const { getDb, initDb } = require('./database');
const { resolveTickerFromIsin } = require('./tickerResolver');
const { fetchStockPrices, fetchIndexPrices, fetchLiveQuote } = require('./priceFetcher');
const { processTransactionFile, processAccountFile } = require('./importData');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const SERVER_START_TIME = Date.now();

// Serve static files
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(express.json());

// ─── Health ──────────────────────────────────────────────────────────
app.get('/api/ping', (_req, res) => {
  const uptimeMs = Date.now() - SERVER_START_TIME;
  const s = Math.floor(uptimeMs / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  let uptime = `${sec}s`;
  if (m) uptime = `${m}m ${uptime}`;
  if (h) uptime = `${h}h ${uptime}`;
  if (d) uptime = `${d}d ${uptime}`;

  res.json({
    status: 'ok',
    server: 'DEGIRO Portfolio',
    version: '0.5.4',
    started: new Date(SERVER_START_TIME).toISOString(),
    uptime_seconds: s,
    uptime,
  });
});

// ─── Root ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// ─── Holdings ────────────────────────────────────────────────────────
app.get('/api/holdings', (_req, res) => {
  const db = getDb();
  const holdings = db.prepare(`
    SELECT s.*, SUM(t.quantity) as total_qty, COUNT(t.id) as trans_count
    FROM stocks s JOIN transactions t ON s.id = t.stock_id
    GROUP BY s.id HAVING total_qty > 0
  `).all();

  if (!holdings.length) return res.json({ holdings: [] });

  const stockIds = holdings.map((h) => h.id);
  const idPlaceholders = stockIds.map(() => '?').join(',');

  // Latest prices
  const latestPrices = db.prepare(`
    SELECT sp.* FROM stock_prices sp
    INNER JOIN (
      SELECT stock_id, MAX(date) as max_date FROM stock_prices
      WHERE stock_id IN (${idPlaceholders}) GROUP BY stock_id
    ) sub ON sp.stock_id = sub.stock_id AND sp.date = sub.max_date
  `).all(...stockIds);

  const latestByStock = {};
  for (const p of latestPrices) latestByStock[p.stock_id] = p;

  // Previous prices (for change %)
  const prevPrices = db.prepare(`
    SELECT sp.* FROM stock_prices sp
    INNER JOIN (
      SELECT stock_id, MAX(date) as max_date FROM stock_prices
      WHERE stock_id IN (${idPlaceholders})
        AND date < (SELECT MAX(date) FROM stock_prices sp2 WHERE sp2.stock_id = stock_prices.stock_id)
      GROUP BY stock_id
    ) sub ON sp.stock_id = sub.stock_id AND sp.date = sub.max_date
  `).all(...stockIds);

  const prevByStock = {};
  for (const p of prevPrices) prevByStock[p.stock_id] = p;

  const result = holdings.map((h) => {
    const latest = latestByStock[h.id];
    const prev = prevByStock[h.id];
    let priceChangePct = null;
    if (latest?.close && prev?.close && prev.close > 0) {
      priceChangePct = ((latest.close - prev.close) / prev.close) * 100;
    }

    return {
      id: h.id,
      symbol: h.symbol,
      name: h.name,
      isin: h.isin,
      currency: latest?.currency || h.currency,
      degiro_currency: h.currency,
      shares: h.total_qty,
      transactions_count: h.trans_count,
      latest_price: latest?.close ?? null,
      price_change_pct: priceChangePct,
      price_date: latest?.date ?? null,
      exchange: h.exchange,
      yahoo_ticker: h.yahoo_ticker,
    };
  });

  res.json({ holdings: result });
});

// ─── Market data status ──────────────────────────────────────────────
app.get('/api/market-data-status', (_req, res) => {
  const db = getDb();
  const latest = db.prepare('SELECT date FROM stock_prices ORDER BY date DESC LIMIT 1').get();
  res.json({
    latest_date: latest?.date ?? null,
    has_data: !!latest,
  });
});

// ─── Exchange rates ──────────────────────────────────────────────────
app.get('/api/exchange-rates', async (_req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const currencies = ['USD', 'GBP', 'SEK'];
  const rates = { EUR: 1.0 };
  const fallbacks = { USD: 0.85, SEK: 0.093, GBP: 1.18 };

  for (const c of currencies) {
    const cached = db.prepare(
      'SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ? AND date >= ?'
    ).get(c, 'EUR', today);

    if (cached) {
      rates[c] = cached.rate;
    } else {
      try {
        const YahooFinance = (await import('yahoo-finance2')).default;
        const yf = new YahooFinance();
        const quote = await yf.quote(`${c}EUR=X`);
        if (quote?.regularMarketPrice) {
          rates[c] = quote.regularMarketPrice;
          db.prepare('INSERT INTO exchange_rates (date, from_currency, to_currency, rate) VALUES (?, ?, ?, ?)')
            .run(today, c, 'EUR', rates[c]);
        } else {
          rates[c] = fallbacks[c] || 1.0;
        }
      } catch {
        rates[c] = fallbacks[c] || 1.0;
      }
    }
  }

  res.json({ success: true, rates });
});

// ─── Stock prices ────────────────────────────────────────────────────
app.get('/api/stock/:stockId/prices', (req, res) => {
  const db = getDb();
  const stock = db.prepare('SELECT * FROM stocks WHERE id = ?').get(req.params.stockId);
  if (!stock) return res.status(404).json({ error: 'Stock not found' });

  const prices = db.prepare('SELECT * FROM stock_prices WHERE stock_id = ? ORDER BY date').all(stock.id);

  res.json({
    stock: { id: stock.id, name: stock.name, symbol: stock.symbol, currency: stock.currency },
    prices: prices.map((p) => ({
      date: p.date, open: p.open, high: p.high, low: p.low, close: p.close, volume: p.volume, currency: p.currency,
    })),
  });
});

// ─── Stock transactions ──────────────────────────────────────────────
app.get('/api/stock/:stockId/transactions', (req, res) => {
  const db = getDb();
  const stock = db.prepare('SELECT * FROM stocks WHERE id = ?').get(req.params.stockId);
  if (!stock) return res.status(404).json({ error: 'Stock not found' });

  const transactions = db.prepare('SELECT * FROM transactions WHERE stock_id = ? ORDER BY date').all(stock.id);

  res.json({
    stock: { id: stock.id, name: stock.name, symbol: stock.symbol, currency: stock.currency },
    transactions: transactions.map((t) => ({
      id: t.id,
      date: t.date,
      quantity: t.quantity,
      price: t.price,
      currency: t.currency,
      total_eur: t.total_eur,
      fees_eur: t.fees_eur || 0,
      transaction_type: t.quantity > 0 ? 'buy' : 'sell',
    })),
  });
});

// ─── Chart data ──────────────────────────────────────────────────────
app.get('/api/stock/:stockId/chart-data', (req, res) => {
  const db = getDb();
  const stock = db.prepare('SELECT * FROM stocks WHERE id = ?').get(req.params.stockId);
  if (!stock) return res.status(404).json({ error: 'Stock not found' });

  const prices = db.prepare(
    'SELECT * FROM stock_prices WHERE stock_id = ? AND close IS NOT NULL ORDER BY date'
  ).all(stock.id);

  const transactions = db.prepare(
    'SELECT * FROM transactions WHERE stock_id = ? ORDER BY date'
  ).all(stock.id);

  // Running position
  let totalShares = 0;
  const runningPosition = transactions.map((t) => {
    totalShares += t.quantity;
    return {
      date: t.date?.split('T')[0] || t.date,
      shares: totalShares,
      transaction_type: t.quantity > 0 ? 'buy' : 'sell',
      quantity: Math.abs(t.quantity),
      price: t.price,
      currency: t.currency,
    };
  });

  // Index comparison
  const indicesData = [];
  if (prices.length) {
    const startDate = prices[0].date;
    const endDate = prices[prices.length - 1].date;
    const indices = db.prepare('SELECT * FROM indices').all();

    for (const index of indices) {
      const indexPrices = db.prepare(
        'SELECT * FROM index_prices WHERE index_id = ? AND date >= ? AND date <= ? ORDER BY date'
      ).all(index.id, startDate, endDate);

      if (indexPrices.length) {
        const basePrice = indexPrices[0].close;
        if (basePrice && basePrice > 0) {
          indicesData.push({
            name: index.name,
            symbol: index.symbol,
            data: indexPrices.map((ip) => ({
              date: ip.date,
              normalized: ((ip.close - basePrice) / basePrice) * 100,
            })),
          });
        }
      }
    }
  }

  // Stock normalized performance
  let stockNormalized = [];
  const validPrices = prices.filter((p) => p.close != null);
  if (validPrices.length && validPrices[0].close > 0) {
    const base = validPrices[0].close;
    stockNormalized = validPrices.map((p) => ({
      date: p.date,
      normalized: ((p.close - base) / base) * 100,
    }));
  }

  // Position percentage
  const positionPercentage = [];
  if (prices.length && transactions.length) {
    const sortedTrans = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
    let transIdx = 0;
    let cumShares = 0;
    let netInvested = 0;

    const exchangeRateByDate = {};
    let lastRate = null;
    for (const t of sortedTrans) {
      if (t.exchange_rate) lastRate = t.exchange_rate;
      exchangeRateByDate[(t.date || '').split('T')[0]] = lastRate;
    }

    for (const price of prices) {
      const priceDate = price.date;
      while (transIdx < sortedTrans.length && (sortedTrans[transIdx].date || '').localeCompare(priceDate + 'Z') <= 0) {
        const t = sortedTrans[transIdx];
        cumShares += t.quantity;
        netInvested += t.quantity > 0 ? Math.abs(t.total_eur) : -Math.abs(t.total_eur);
        transIdx++;
      }

      if (netInvested > 0 && cumShares > 0 && price.close != null) {
        let priceEur = price.close;
        if (price.currency && price.currency !== 'EUR') {
          let exchangeRate = null;
          for (const td of Object.keys(exchangeRateByDate).sort().reverse()) {
            if (td <= priceDate && exchangeRateByDate[td]) {
              exchangeRate = exchangeRateByDate[td];
              break;
            }
          }
          if (exchangeRate) {
            priceEur = price.close / exchangeRate;
          } else {
            // Fallback: use exchange_rates table
            const rateRow = db.prepare(
              'SELECT rate FROM exchange_rates WHERE from_currency = ? ORDER BY date DESC LIMIT 1'
            ).get(price.currency);
            if (rateRow) priceEur = price.close * rateRow.rate;
          }
        }
        const currentValue = priceEur * cumShares;
        positionPercentage.push({
          date: priceDate,
          percentage: (currentValue / netInvested) * 100,
          invested: netInvested,
          value: currentValue,
        });
      }
    }
  }

  res.json({
    stock: {
      id: stock.id, name: stock.name, symbol: stock.symbol,
      currency: stock.currency, data_provider: stock.data_provider || 'unknown',
    },
    prices: prices.map((p) => ({
      date: p.date, close: p.close, high: p.high, low: p.low, open: p.open, currency: p.currency,
    })),
    transactions: runningPosition,
    indices: indicesData,
    stock_normalized: stockNormalized,
    position_percentage: positionPercentage,
  });
});

// ─── Portfolio summary ───────────────────────────────────────────────
app.get('/api/portfolio-summary', (_req, res) => {
  const db = getDb();

  const holdings = db.prepare(`
    SELECT s.id, s.currency, SUM(t.quantity) as total_qty
    FROM stocks s JOIN transactions t ON s.id = t.stock_id
    GROUP BY s.id HAVING total_qty > 0
  `).all();

  // Cash movements (deposits / withdrawals)
  const cashMovements = db.prepare('SELECT * FROM cash_movements').all();
  const totalDeposited = cashMovements
    .filter((m) => m.type === 'deposit')
    .reduce((s, m) => s + m.amount, 0);
  const totalWithdrawals = cashMovements
    .filter((m) => m.type === 'withdrawal')
    .reduce((s, m) => s + Math.abs(m.amount), 0);
  const netDeposited = totalDeposited - totalWithdrawals;

  if (!holdings.length) {
    return res.json({
      total_holdings: 0, net_invested: 0, current_value: 0, gain_loss: 0, gain_loss_percent: 0,
      total_deposited: Math.round(totalDeposited * 100) / 100,
      total_withdrawals: Math.round(totalWithdrawals * 100) / 100,
      net_deposited: Math.round(netDeposited * 100) / 100,
      total_profit_loss: 0, total_profit_loss_percent: 0,
    });
  }

  let totalNetInvested = 0;
  for (const h of holdings) {
    const trans = db.prepare('SELECT quantity, total_eur FROM transactions WHERE stock_id = ?').all(h.id);
    const buys = trans.filter((t) => t.quantity > 0).reduce((s, t) => s + Math.abs(t.total_eur), 0);
    const sells = trans.filter((t) => t.quantity < 0).reduce((s, t) => s + Math.abs(t.total_eur), 0);
    totalNetInvested += buys - sells;
  }

  const stockIds = holdings.map((h) => h.id);
  const idPlaceholders = stockIds.map(() => '?').join(',');
  const latestPrices = db.prepare(`
    SELECT sp.* FROM stock_prices sp
    INNER JOIN (
      SELECT stock_id, MAX(date) as max_date FROM stock_prices
      WHERE stock_id IN (${idPlaceholders}) AND close IS NOT NULL GROUP BY stock_id
    ) sub ON sp.stock_id = sub.stock_id AND sp.date = sub.max_date
  `).all(...stockIds);

  const priceByStock = {};
  for (const p of latestPrices) priceByStock[p.stock_id] = p;

  // Exchange rates
  const rateRows = db.prepare('SELECT * FROM exchange_rates').all();
  const exchangeRates = { EUR: 1.0 };
  for (const r of rateRows) exchangeRates[r.from_currency] = r.rate;

  const fallbacks = { USD: 0.85, SEK: 0.093, GBP: 1.18 };

  let currentValue = 0;
  for (const h of holdings) {
    const pr = priceByStock[h.id];
    if (pr?.close) {
      const currency = pr.currency || h.currency;
      const rate = exchangeRates[currency] ?? fallbacks[currency] ?? 1.0;
      currentValue += h.total_qty * pr.close * rate;
    }
  }

  const gainLoss = currentValue - totalNetInvested;
  const gainLossPercent = totalNetInvested > 0 ? (gainLoss / totalNetInvested) * 100 : 0;
  const totalProfitLoss = currentValue - netDeposited;
  const totalProfitLossPercent = netDeposited > 0 ? (totalProfitLoss / netDeposited) * 100 : 0;

  res.json({
    total_holdings: holdings.length,
    net_invested: Math.round(totalNetInvested * 100) / 100,
    current_value: Math.round(currentValue * 100) / 100,
    gain_loss: Math.round(gainLoss * 100) / 100,
    gain_loss_percent: Math.round(gainLossPercent * 100) / 100,
    total_deposited: Math.round(totalDeposited * 100) / 100,
    total_withdrawals: Math.round(totalWithdrawals * 100) / 100,
    net_deposited: Math.round(netDeposited * 100) / 100,
    total_profit_loss: Math.round(totalProfitLoss * 100) / 100,
    total_profit_loss_percent: Math.round(totalProfitLossPercent * 100) / 100,
  });
});

// ─── Portfolio valuation history ─────────────────────────────────────
app.get('/api/portfolio-valuation-history', (_req, res) => {
  const db = getDb();

  const allTransactions = db.prepare('SELECT * FROM transactions ORDER BY date').all();
  if (!allTransactions.length) return res.json({ dates: [], invested: [], values: [] });

  const transByStock = {};
  for (const t of allTransactions) {
    (transByStock[t.stock_id] = transByStock[t.stock_id] || []).push(t);
  }

  const allStockIds = new Set(Object.keys(transByStock).map(Number));
  if (!allStockIds.size) return res.json({ dates: [], invested: [], values: [] });

  const firstDate = allTransactions[0].date?.split('T')[0] || allTransactions[0].date;

  const priceDates = db.prepare(
    'SELECT DISTINCT date FROM stock_prices WHERE date >= ? ORDER BY date'
  ).all(firstDate).map((r) => r.date);

  if (!priceDates.length) return res.json({ dates: [], invested: [], values: [] });

  // Add today if not present
  const today = new Date().toISOString().split('T')[0];
  if (today > priceDates[priceDates.length - 1]) priceDates.push(today);

  // Load all prices into memory
  const allPrices = db.prepare('SELECT * FROM stock_prices WHERE date >= ?').all(firstDate);
  const priceByStock = {};
  for (const p of allPrices) {
    (priceByStock[p.stock_id] = priceByStock[p.stock_id] || []).push(p);
  }
  for (const sid of Object.keys(priceByStock)) {
    priceByStock[sid].sort((a, b) => a.date.localeCompare(b.date));
  }

  // Exchange rates from transactions
  const exchangeRatesByStock = {};
  for (const [sid, trans] of Object.entries(transByStock)) {
    for (let i = trans.length - 1; i >= 0; i--) {
      if (trans[i].exchange_rate) { exchangeRatesByStock[sid] = trans[i].exchange_rate; break; }
    }
  }

  // Fallback exchange rates from exchange_rates table / hardcoded defaults
  const rateRows = db.prepare('SELECT * FROM exchange_rates').all();
  const globalExchangeRates = { EUR: 1.0 };
  for (const r of rateRows) globalExchangeRates[r.from_currency] = r.rate;
  const fallbackRates = { USD: 0.85, SEK: 0.093, GBP: 1.18 };

  // Load all historical exchange rates per currency per date for accurate history
  const historicalRates = {}; // { currency: [[date, rate], ...] } sorted ascending
  for (const r of rateRows) {
    if (!historicalRates[r.from_currency]) historicalRates[r.from_currency] = [];
    historicalRates[r.from_currency].push([r.date.split('T')[0], r.rate]);
  }
  for (const arr of Object.values(historicalRates)) arr.sort((a, b) => a[0].localeCompare(b[0]));

  function getRateOnDate(currency, date) {
    if (currency === 'EUR') return 1.0;
    const arr = historicalRates[currency];
    if (!arr || arr.length === 0) return globalExchangeRates[currency] ?? fallbackRates[currency] ?? 1.0;
    // Find closest rate on or before date
    let rate = arr[0][1];
    for (const [d, r] of arr) {
      if (d <= date) rate = r;
      else break;
    }
    return rate;
  }

  // Build events
  const events = allTransactions.map((t) => ({
    date: t.date?.split('T')[0] || t.date,
    stockId: t.stock_id,
    qty: t.quantity,
    invested: t.quantity > 0 ? Math.abs(t.total_eur) : -Math.abs(t.total_eur),
  })).sort((a, b) => a.date.localeCompare(b.date));

  const dates = [];
  const investedSeries = [];
  const valueSeries = [];
  let runningInvested = 0;
  const runningHoldings = {};
  let eventIdx = 0;

  for (const priceDate of priceDates) {
    while (eventIdx < events.length && events[eventIdx].date <= priceDate) {
      const e = events[eventIdx];
      runningHoldings[e.stockId] = (runningHoldings[e.stockId] || 0) + e.qty;
      runningInvested += e.invested;
      eventIdx++;
    }

    let totalValueEur = 0;
    for (const [sid, holdings] of Object.entries(runningHoldings)) {
      if (holdings <= 0) continue;
      const prices = priceByStock[sid] || [];
      let priceClose = null;
      let priceCurrency = null;
      for (let i = prices.length - 1; i >= 0; i--) {
        if (prices[i].date <= priceDate) {
          priceClose = prices[i].close;
          priceCurrency = prices[i].currency;
          break;
        }
      }
      if (priceClose == null) continue;

      let priceEur = priceClose;
      if (priceCurrency && priceCurrency !== 'EUR') {
        const rate = getRateOnDate(priceCurrency, priceDate);
        priceEur = priceClose * rate;
      }
      totalValueEur += holdings * priceEur;
    }

    dates.push(priceDate);
    investedSeries.push(Math.round(runningInvested * 100) / 100);
    valueSeries.push(Math.round(totalValueEur * 100) / 100);
  }

  res.json({ dates, invested: investedSeries, values: valueSeries });
});

// ─── Upload transactions ─────────────────────────────────────────────
app.post('/api/upload-transactions', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const filename = req.file.originalname.toLowerCase();
    if (!filename.match(/\.(xlsx|xls)$/)) {
      return res.status(400).json({ success: false, message: 'Please upload a DEGIRO Excel file (.xlsx or .xls)' });
    }
    const db = getDb();

    // Purge existing transaction data before importing
    db.prepare('DELETE FROM stock_prices').run();
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM stocks').run();

    const { newTransactions, updatedStocks, stockIdsToFetch } = await processTransactionFile(req.file.buffer, filename);

    // Fetch prices for all stocks
    let totalPrices = 0;
    let stocksWithPrices = 0;

    for (const stockId of stockIdsToFetch) {
      const stock = db.prepare('SELECT * FROM stocks WHERE id = ?').get(stockId);
      if (!stock) continue;

      const count = await fetchStockPrices(stock);
      if (count > 0) { totalPrices += count; stocksWithPrices++; }
    }

    // Ensure indices exist and have data
    for (const [symbol, name] of Object.entries(config.INDICES)) {
      let index = db.prepare('SELECT * FROM indices WHERE symbol = ?').get(symbol);
      if (!index) {
        db.prepare('INSERT INTO indices (symbol, name) VALUES (?, ?)').run(symbol, name);
        index = db.prepare('SELECT * FROM indices WHERE symbol = ?').get(symbol);
      }
      const existingCount = db.prepare('SELECT COUNT(*) as cnt FROM index_prices WHERE index_id = ?').get(index.id);
      if (existingCount.cnt === 0) {
        await fetchIndexPrices(symbol, index.id, '5y');
      }
    }

    let message = `Successfully imported ${newTransactions} new transactions`;
    if (updatedStocks > 0) message += ` for ${updatedStocks} new stocks`;
    if (totalPrices > 0) message += `, fetched ${totalPrices} historical price records`;

    res.json({ success: true, message });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, message: `Error processing file: ${err.message}` });
  }
});

// ─── Refresh live prices ─────────────────────────────────────────────
app.post('/api/refresh-live-prices', async (_req, res) => {
  try {
    const db = getDb();
    const holdings = db.prepare(`
      SELECT s.* FROM stocks s JOIN transactions t ON s.id = t.stock_id
      GROUP BY s.id HAVING SUM(t.quantity) > 0
    `).all();

    const quotes = [];
    const errors = [];

    for (const stock of holdings) {
      if (!stock.yahoo_ticker) { errors.push(`No ticker for ${stock.name}`); continue; }
      const quote = await fetchLiveQuote(stock.yahoo_ticker);
      if (quote) {
        quotes.push({
          stock_id: stock.id, name: stock.name, symbol: stock.symbol,
          ticker: stock.yahoo_ticker,
          price: quote.price, change: quote.change || 0,
          change_percent: quote.change_percent || 0,
          open: quote.open || 0, high: quote.high || 0, low: quote.low || 0,
          volume: quote.volume || 0, timestamp: quote.timestamp,
          currency: quote.currency || stock.currency,
        });
      } else {
        errors.push(`No quote for ${stock.name}`);
      }
    }

    res.json({
      success: true, quotes, count: quotes.length, errors,
      timestamp: new Date().toISOString(), provider: 'yahoo',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: `Error fetching live prices: ${err.message}` });
  }
});

// ─── Update market data ──────────────────────────────────────────────
app.post('/api/update-market-data', async (_req, res) => {
  try {
    const db = getDb();
    let updatedStocks = 0;
    let updatedIndices = 0;
    const errors = [];

    // Update all stocks that have transactions (including sold positions, for history)
    const holdings = db.prepare(`
      SELECT s.* FROM stocks s JOIN transactions t ON s.id = t.stock_id
      GROUP BY s.id
    `).all();

    for (const stock of holdings) {
      try {
        if (!stock.yahoo_ticker) {
          const ticker = await resolveTickerFromIsin(stock.isin, stock.currency);
          if (ticker) {
            db.prepare('UPDATE stocks SET yahoo_ticker = ? WHERE id = ?').run(ticker, stock.id);
            stock.yahoo_ticker = ticker;
          } else {
            errors.push(`No ticker for ${stock.name}`);
            continue;
          }
        }

        const count = await fetchStockPrices(stock);
        if (count > 0) updatedStocks++;
      } catch (err) {
        errors.push(`Error updating ${stock.name}: ${err.message}`);
      }
    }

    // Update indices
    const indices = db.prepare('SELECT * FROM indices').all();
    for (const index of indices) {
      const count = await fetchIndexPrices(index.symbol, index.id, '7d');
      if (count > 0) updatedIndices++;
    }

    const message = `Updated ${updatedStocks} stocks and ${updatedIndices} indices using yahoo`;
    res.json({
      success: true, message,
      stocks_updated: updatedStocks, indices_updated: updatedIndices, errors,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: `Error updating market data: ${err.message}` });
  }
});

// ─── Portfolio performance ───────────────────────────────────────────
app.get('/api/portfolio-performance', (_req, res) => {
  const db = getDb();
  const stocks = db.prepare('SELECT * FROM stocks').all();
  const allTrans = db.prepare('SELECT * FROM transactions ORDER BY date').all();
  const allPrices = db.prepare('SELECT * FROM stock_prices ORDER BY date').all();

  const transByStock = {};
  const holdingsByStock = {};
  for (const t of allTrans) {
    (transByStock[t.stock_id] = transByStock[t.stock_id] || []).push(t);
    holdingsByStock[t.stock_id] = (holdingsByStock[t.stock_id] || 0) + t.quantity;
  }

  const pricesByStock = {};
  for (const p of allPrices) {
    (pricesByStock[p.stock_id] = pricesByStock[p.stock_id] || []).push(p);
  }

  const portfolioData = [];
  for (const stock of stocks) {
    const totalQty = holdingsByStock[stock.id] || 0;
    if (totalQty <= 0) continue;

    const trans = transByStock[stock.id] || [];
    const buys = trans.filter((t) => t.quantity > 0);
    if (!buys.length) continue;

    const totalSpent = buys.reduce((s, t) => s + Math.abs(t.total_eur), 0);
    const totalSharesBought = buys.reduce((s, t) => s + t.quantity, 0);
    if (!totalSharesBought) continue;

    const avgCost = totalSpent / totalSharesBought;
    const prices = pricesByStock[stock.id] || [];
    if (!prices.length) continue;

    const performance = prices.filter((p) => p.close != null).map((p) => ({
      date: p.date,
      return: ((p.close - avgCost) / avgCost) * 100,
    }));

    portfolioData.push({
      stock_id: stock.id, name: stock.name, symbol: stock.symbol,
      currency: stock.currency, shares: totalQty, performance,
    });
  }

  res.json({ stocks: portfolioData });
});

// ─── Cash movements ──────────────────────────────────────────────────
app.get('/api/cash-movements', (_req, res) => {
  const db = getDb();
  const movements = db.prepare('SELECT * FROM cash_movements ORDER BY date DESC').all();

  const totalDeposits = movements
    .filter((m) => m.type === 'deposit')
    .reduce((s, m) => s + m.amount, 0);
  const totalWithdrawals = movements
    .filter((m) => m.type === 'withdrawal')
    .reduce((s, m) => s + Math.abs(m.amount), 0);

  res.json({
    movements: movements.map((m) => ({
      id: m.id,
      date: m.date,
      time: m.time,
      value_date: m.value_date,
      description: m.description,
      currency: m.currency,
      amount: m.amount,
      balance: m.balance,
      type: m.type,
    })),
    summary: {
      total_deposits: Math.round(totalDeposits * 100) / 100,
      total_withdrawals: Math.round(totalWithdrawals * 100) / 100,
      net_deposits: Math.round((totalDeposits - totalWithdrawals) * 100) / 100,
      count: movements.length,
    },
  });
});

// ─── Upload account statement ────────────────────────────────────────
app.post('/api/upload-account', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const filename = req.file.originalname.toLowerCase();
    if (!filename.match(/\.xlsx?$/)) {
      return res.status(400).json({ success: false, message: 'Please upload an Excel file (.xlsx or .xls)' });
    }

    const { newMovements, errors } = processAccountFile(req.file.buffer);

    let message = `Imported ${newMovements} new cash movements`;
    if (errors.length > 0) message += ` (${errors.length} errors)`;

    res.json({ success: true, message, newMovements, errors });
  } catch (err) {
    console.error('Account upload error:', err);
    res.status(500).json({ success: false, message: `Error processing file: ${err.message}` });
  }
});

// ─── Purge database ──────────────────────────────────────────────────
app.post('/api/purge-database', (_req, res) => {
  try {
    const db = getDb();
    const stockCount = db.prepare('SELECT COUNT(*) as c FROM stocks').get().c;
    const transCount = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
    const priceCount = db.prepare('SELECT COUNT(*) as c FROM stock_prices').get().c;
    const indexCount = db.prepare('SELECT COUNT(*) as c FROM indices').get().c;
    const indexPriceCount = db.prepare('SELECT COUNT(*) as c FROM index_prices').get().c;
    const cashMovementCount = db.prepare('SELECT COUNT(*) as c FROM cash_movements').get().c;

    db.prepare('DELETE FROM stock_prices').run();
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM stocks').run();
    db.prepare('DELETE FROM index_prices').run();
    db.prepare('DELETE FROM indices').run();
    db.prepare('DELETE FROM cash_movements').run();

    res.json({
      success: true,
      message: 'Database purged successfully',
      deleted: {
        stocks: stockCount, transactions: transCount, stock_prices: priceCount,
        indices: indexCount, index_prices: indexPriceCount, cash_movements: cashMovementCount,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: `Error purging database: ${err.message}` });
  }
});

// ─── Time Travel ─────────────────────────────────────────────────────
app.get('/api/time-travel', (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD format.' });
  }

  const db = getDb();

  // Get all transactions up to and including this date (normalize date to YYYY-MM-DD)
  const transactions = db.prepare(
    'SELECT * FROM transactions ORDER BY date'
  ).all().filter(t => {
    const tDate = (t.date || '').split('T')[0];
    return tDate <= date;
  });

  // Calculate holdings at this date
  const holdingsMap = {}; // stock_id -> total quantity
  for (const t of transactions) {
    holdingsMap[t.stock_id] = (holdingsMap[t.stock_id] || 0) + t.quantity;
  }

  // Remove stocks with zero or negative holdings
  const activeStockIds = Object.entries(holdingsMap)
    .filter(([, qty]) => qty > 0)
    .map(([id]) => Number(id));

  if (!activeStockIds.length) {
    return res.json({
      date,
      total_value_eur: 0,
      daily_change_eur: 0,
      daily_change_pct: 0,
      holdings: [],
    });
  }

  // Load exchange rates (same logic as portfolio-valuation-history)
  const rateRows = db.prepare('SELECT * FROM exchange_rates').all();
  const globalRates = { EUR: 1.0 };
  for (const r of rateRows) globalRates[r.from_currency] = r.rate;
  const fallbacks = { USD: 0.85, SEK: 0.093, GBP: 1.18 };

  // Build historical rates for accurate date-specific conversion
  const historicalRates = {};
  for (const r of rateRows) {
    if (!historicalRates[r.from_currency]) historicalRates[r.from_currency] = [];
    historicalRates[r.from_currency].push([r.date.split('T')[0], r.rate]);
  }
  for (const arr of Object.values(historicalRates)) arr.sort((a, b) => a[0].localeCompare(b[0]));

  function getRateOnDate(currency, targetDate) {
    if (currency === 'EUR') return 1.0;
    const arr = historicalRates[currency];
    if (!arr || arr.length === 0) return globalRates[currency] ?? fallbacks[currency] ?? 1.0;
    let rate = arr[0][1];
    for (const [d, r] of arr) {
      if (d <= targetDate) rate = r;
      else break;
    }
    return rate;
  }

  const holdingsList = [];
  let totalValueEur = 0;
  let totalPrevValueEur = 0;

  for (const stockId of activeStockIds) {
    const stock = db.prepare('SELECT * FROM stocks WHERE id = ?').get(stockId);
    if (!stock) continue;

    const qty = holdingsMap[stockId];

    // Get price on or before the selected date
    const priceRow = db.prepare(
      'SELECT * FROM stock_prices WHERE stock_id = ? AND date <= ? ORDER BY date DESC LIMIT 1'
    ).get(stockId, date);

    // Get previous day's price (the day before priceRow.date)
    let prevPriceRow = null;
    if (priceRow) {
      prevPriceRow = db.prepare(
        'SELECT * FROM stock_prices WHERE stock_id = ? AND date < ? ORDER BY date DESC LIMIT 1'
      ).get(stockId, priceRow.date);
    }

    const price = priceRow?.close ?? null;
    const prevPrice = prevPriceRow?.close ?? null;
    const currency = priceRow?.currency || stock.currency;
    const rate = getRateOnDate(currency, date);

    const totalValue = price != null ? price * qty : null;
    const totalValueInEur = totalValue != null ? totalValue * rate : null;
    const prevTotalValue = prevPrice != null ? prevPrice * qty : null;
    const prevTotalValueInEur = prevTotalValue != null ? prevTotalValue * rate : null;

    let dailyChange = null;
    let dailyChangePct = null;
    if (price != null && prevPrice != null && prevPrice > 0) {
      dailyChange = (price - prevPrice) * qty * rate;
      dailyChangePct = ((price - prevPrice) / prevPrice) * 100;
    }

    if (totalValueInEur != null) totalValueEur += totalValueInEur;
    if (prevTotalValueInEur != null) totalPrevValueEur += prevTotalValueInEur;

    holdingsList.push({
      id: stock.id,
      name: stock.name,
      symbol: stock.symbol,
      isin: stock.isin,
      exchange: stock.exchange,
      currency,
      shares: qty,
      price,
      price_date: priceRow?.date ?? null,
      total_value: totalValue != null ? Math.round(totalValue * 100) / 100 : null,
      total_value_eur: totalValueInEur != null ? Math.round(totalValueInEur * 100) / 100 : null,
      daily_change_eur: dailyChange != null ? Math.round(dailyChange * 100) / 100 : null,
      daily_change_pct: dailyChangePct != null ? Math.round(dailyChangePct * 100) / 100 : null,
    });
  }

  // Sort by total value descending
  holdingsList.sort((a, b) => (b.total_value_eur || 0) - (a.total_value_eur || 0));

  const portfolioDailyChange = totalPrevValueEur > 0
    ? Math.round((totalValueEur - totalPrevValueEur) * 100) / 100
    : 0;
  const portfolioDailyChangePct = totalPrevValueEur > 0
    ? Math.round(((totalValueEur - totalPrevValueEur) / totalPrevValueEur) * 10000) / 100
    : 0;

  res.json({
    date,
    total_value_eur: Math.round(totalValueEur * 100) / 100,
    daily_change_eur: portfolioDailyChange,
    daily_change_pct: portfolioDailyChangePct,
    holdings: holdingsList,
  });
});

// ─── Time Travel date range ─────────────────────────────────────────
app.get('/api/time-travel/range', (_req, res) => {
  const db = getDb();
  const earliest = db.prepare('SELECT MIN(date) as min_date FROM transactions').get();
  const latest = db.prepare('SELECT MAX(date) as max_date FROM stock_prices').get();
  res.json({
    min_date: earliest?.min_date?.split('T')[0] || null,
    max_date: latest?.max_date || null,
  });
});

// ─── Shutdown ────────────────────────────────────────────────────────
app.post('/api/shutdown', (_req, res) => {
  res.json({ status: 'shutting_down' });
  setTimeout(() => process.exit(0), 200);
});

// ─── Start ───────────────────────────────────────────────────────────
initDb();
app.listen(config.PORT, config.HOST, () => {
  console.log(`DEGIRO Portfolio running on http://${config.HOST}:${config.PORT}`);
});
