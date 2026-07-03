const express = require('express');
const path = require('path');
const multer = require('multer');
const packageJson = require('../package.json');
const { config } = require('./config');
const { getDb, initDb } = require('./database');
const { resolveTickerFromIsin } = require('./tickerResolver');
const { fetchStockPrices, fetchManualHoldingPrices, fetchIndexPrices, fetchLiveQuote, persistManualLivePriceSnapshot } = require('./priceFetcher');
const { processTransactionFile, processAccountFile } = require('./importData');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const SERVER_START_TIME = Date.now();
const HOURLY_LIVE_REFRESH_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
let hourlyLiveRefreshInterval = null;
let hourlyLiveRefreshRunning = false;

app.set('trust proxy', config.TRUST_PROXY);

function getHostname(hostHeader) {
  if (!hostHeader) return '';
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch (_err) {
    return hostHeader.split(':')[0];
  }
}

function redirectCanonicalOrigin(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }

  if (config.PUBLIC_URL) {
    const publicUrl = new URL(config.PUBLIC_URL);
    const expectedProtocol = publicUrl.protocol.slice(0, -1);
    const expectedHost = publicUrl.host;

    if (req.protocol !== expectedProtocol || req.get('host') !== expectedHost) {
      const target = new URL(req.originalUrl, publicUrl);
      res.redirect(308, target.toString());
      return;
    }
  } else {
    const hostname = getHostname(req.get('host'));

    if (hostname === '0.0.0.0' || hostname === '::') {
      const target = new URL(req.originalUrl, `${req.protocol}://localhost:${config.PORT}`);
      res.redirect(308, target.toString());
      return;
    }
  }

  next();
}

app.use(redirectCanonicalOrigin);

// Serve static files
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(express.json());

function persistLivePriceSnapshot(db, stock, quote) {
  if (!quote || quote.price == null) return null;

  // Keep intraday snapshots at second precision for stable ordering and compact storage.
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  db.prepare(`
    INSERT INTO stock_prices (stock_id, date, open, high, low, close, volume, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    stock.id,
    timestamp,
    quote.open ?? quote.price,
    quote.high ?? quote.price,
    quote.low ?? quote.price,
    quote.price,
    quote.volume || 0,
    quote.currency || stock.currency
  );

  return timestamp;
}

function includeOtherBrokers(req) {
  const val = req.query.includeOtherBrokers;
  if (val === '1' || val === 'true') return true;
  if (val === '0' || val === 'false') return false;
  return config.INCLUDE_OTHER_BROKERS_DEFAULT;
}

function loadExchangeRates(db) {
  const rateRows = db.prepare('SELECT * FROM exchange_rates').all();
  const globalRates = { EUR: 1.0 };
  const historicalRates = {};
  for (const r of rateRows) {
    globalRates[r.from_currency] = r.rate;
    if (!historicalRates[r.from_currency]) historicalRates[r.from_currency] = [];
    historicalRates[r.from_currency].push([r.date.split('T')[0], r.rate]);
  }
  for (const arr of Object.values(historicalRates)) arr.sort((a, b) => a[0].localeCompare(b[0]));
  return { globalRates, historicalRates };
}

function getRateOnDate(currency, date, globalRates, historicalRates) {
  if (currency === 'EUR') return 1.0;
  const arr = historicalRates[currency];
  if (!arr || arr.length === 0) return globalRates[currency] ?? fallbacks[currency] ?? 1.0;
  let rate = arr[0][1];
  for (const [d, r] of arr) {
    if (d <= date) rate = r;
    else break;
  }
  return rate;
}

const fallbacks = { USD: 0.85, SEK: 0.093, GBP: 1.18 };

function getManualHoldings(db) {
  return db.prepare('SELECT * FROM manual_holdings ORDER BY display_name').all();
}

function getManualHoldingLatestPrice(db, manualHoldingId) {
  return db.prepare(
    'SELECT * FROM manual_holding_prices WHERE manual_holding_id = ? ORDER BY date DESC LIMIT 1'
  ).get(manualHoldingId);
}

function getManualHoldingPriceOnDate(db, manualHoldingId, date) {
  return db.prepare(
    `SELECT * FROM manual_holding_prices
     WHERE manual_holding_id = ? AND substr(date, 1, 10) <= ?
     ORDER BY substr(date, 1, 10) DESC, date DESC
     LIMIT 1`
  ).get(manualHoldingId, date);
}

function getManualHoldingPrevDayPrice(db, manualHoldingId, priceDay) {
  return db.prepare(
    `SELECT * FROM manual_holding_prices
     WHERE manual_holding_id = ? AND substr(date, 1, 10) < ?
     ORDER BY substr(date, 1, 10) DESC, date DESC
     LIMIT 1`
  ).get(manualHoldingId, priceDay);
}

function enrichManualHoldings(db) {
  const holdings = getManualHoldings(db);
  if (!holdings.length) return [];

  const { globalRates } = loadExchangeRates(db);

  return holdings.map((h) => {
    const latest = getManualHoldingLatestPrice(db, h.id);
    const latestDay = latest ? (latest.date || '').split('T')[0] : null;
    const prev = latestDay ? getManualHoldingPrevDayPrice(db, h.id, latestDay) : null;

    const currency = latest?.currency || h.currency || 'EUR';
    const rate = globalRates[currency] ?? fallbacks[currency] ?? 1.0;
    const price = latest?.close ?? null;
    const prevPrice = prev?.close ?? null;

    const totalValueEur = price != null ? h.quantity * price * rate : null;
    const costBasis = h.cost_basis_eur || 0;
    const gainLoss = totalValueEur != null ? totalValueEur - costBasis : null;
    const gainLossPct = costBasis > 0 && gainLoss != null ? (gainLoss / costBasis) * 100 : null;

    let dailyChangePct = null;
    if (price != null && prevPrice != null && prevPrice > 0) {
      dailyChangePct = ((price - prevPrice) / prevPrice) * 100;
    }

    return {
      id: h.id,
      is_manual: true,
      symbol: h.yahoo_ticker,
      name: h.display_name,
      isin: null,
      exchange: h.broker || 'Other',
      currency,
      shares: h.quantity,
      latest_price: price,
      price_change_pct: dailyChangePct,
      price_date: latest?.date ?? null,
      yahoo_ticker: h.yahoo_ticker,
      cost_basis_eur: Math.round(costBasis * 100) / 100,
      total_value_eur: totalValueEur != null ? Math.round(totalValueEur * 100) / 100 : null,
      gain_loss_eur: gainLoss != null ? Math.round(gainLoss * 100) / 100 : null,
      gain_loss_percent: gainLossPct != null ? Math.round(gainLossPct * 100) / 100 : null,
      purchase_date: h.purchase_date,
      broker: h.broker,
    };
  });
}

async function collectAndPersistLiveQuotes() {
  const db = getDb();
  const holdings = db.prepare(`
    SELECT s.* FROM stocks s JOIN transactions t ON s.id = t.stock_id
    GROUP BY s.id HAVING SUM(t.quantity) > 0
  `).all();

  const manualHoldings = getManualHoldings(db);

  const quotes = [];
  const errors = [];

  for (const stock of holdings) {
    if (!stock.yahoo_ticker) {
      errors.push(`No ticker for ${stock.name}`);
      continue;
    }

    const quote = await fetchLiveQuote(stock.yahoo_ticker);
    if (!quote) {
      errors.push(`No quote for ${stock.name}`);
      continue;
    }

    const persistedAt = persistLivePriceSnapshot(db, stock, quote);
    quotes.push({
      stock_id: stock.id,
      name: stock.name,
      symbol: stock.symbol,
      ticker: stock.yahoo_ticker,
      price: quote.price,
      change: quote.change || 0,
      change_percent: quote.change_percent || 0,
      open: quote.open || 0,
      high: quote.high || 0,
      low: quote.low || 0,
      volume: quote.volume || 0,
      timestamp: persistedAt || quote.timestamp,
      currency: quote.currency || stock.currency,
    });
  }

  for (const manual of manualHoldings) {
    if (!manual.yahoo_ticker) {
      errors.push(`No ticker for ${manual.display_name}`);
      continue;
    }

    const quote = await fetchLiveQuote(manual.yahoo_ticker);
    if (!quote) {
      errors.push(`No quote for ${manual.display_name}`);
      continue;
    }

    const persistedAt = persistManualLivePriceSnapshot(db, manual, quote);
    quotes.push({
      manual_holding_id: manual.id,
      name: manual.display_name,
      symbol: manual.yahoo_ticker,
      ticker: manual.yahoo_ticker,
      price: quote.price,
      change: quote.change || 0,
      change_percent: quote.change_percent || 0,
      open: quote.open || 0,
      high: quote.high || 0,
      low: quote.low || 0,
      volume: quote.volume || 0,
      timestamp: persistedAt || quote.timestamp,
      currency: quote.currency || manual.currency,
    });
  }

  return { quotes, errors };
}

async function backfillHistoricalPricesIfNeeded() {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const latestDaily = db.prepare(
    'SELECT date FROM stock_prices WHERE date GLOB ? ORDER BY date DESC LIMIT 1'
  ).get('????-??-??');

  let daysBehind = null;
  if (latestDaily?.date) {
    const latestTs = new Date(`${latestDaily.date}T00:00:00Z`).getTime();
    const todayTs = new Date(`${today}T00:00:00Z`).getTime();
    daysBehind = Math.floor((todayTs - latestTs) / DAY_MS);
  }

  // Skip unnecessary historical pulls when data is already current enough.
  if (latestDaily?.date && daysBehind != null && daysBehind < 2) {
    return {
      performed: false,
      days_behind: daysBehind,
      latest_daily_date: latestDaily.date,
      rows_added: 0,
      stocks_updated: 0,
      errors: [],
    };
  }

  const stocks = db.prepare(`
    SELECT s.* FROM stocks s JOIN transactions t ON s.id = t.stock_id
    GROUP BY s.id
  `).all();

  const manualHoldings = getManualHoldings(db);

  let rowsAdded = 0;
  let stocksUpdated = 0;
  let manualRowsAdded = 0;
  let manualUpdated = 0;
  const errors = [];

  for (const stock of stocks) {
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
      if (count > 0) {
        rowsAdded += count;
        stocksUpdated++;
      }
    } catch (err) {
      errors.push(`Error backfilling ${stock.name}: ${err.message}`);
    }
  }

  for (const manual of manualHoldings) {
    try {
      if (!manual.yahoo_ticker) {
        errors.push(`No ticker for ${manual.display_name}`);
        continue;
      }
      const count = await fetchManualHoldingPrices(manual);
      if (count > 0) {
        manualRowsAdded += count;
        manualUpdated++;
      }
    } catch (err) {
      errors.push(`Error backfilling ${manual.display_name}: ${err.message}`);
    }
  }

  return {
    performed: true,
    days_behind: daysBehind,
    latest_daily_date: latestDaily?.date ?? null,
    rows_added: rowsAdded,
    stocks_updated: stocksUpdated,
    manual_rows_added: manualRowsAdded,
    manual_updated: manualUpdated,
    errors,
  };
}

function startHourlyLiveRefreshJob() {
  if (hourlyLiveRefreshInterval) return;

  hourlyLiveRefreshInterval = setInterval(async () => {
    if (hourlyLiveRefreshRunning) return;

    hourlyLiveRefreshRunning = true;
    try {
      const { quotes, errors } = await collectAndPersistLiveQuotes();
      const errSuffix = errors.length ? ` (${errors.length} errors)` : '';
      console.log(`[HourlyLiveRefresh] Saved ${quotes.length} live quotes${errSuffix}`);
    } catch (err) {
      console.error('[HourlyLiveRefresh] Failed:', err.message);
    } finally {
      hourlyLiveRefreshRunning = false;
    }
  }, HOURLY_LIVE_REFRESH_MS);

  console.log(`[HourlyLiveRefresh] Started with ${HOURLY_LIVE_REFRESH_MS / 60000} minute interval`);
}

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
    version: packageJson.version,
    started: new Date(SERVER_START_TIME).toISOString(),
    uptime_seconds: s,
    uptime,
  });
});

// ─── Root ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// ─── PWA assets ──────────────────────────────────────────────────────
app.get('/service-worker.js', (_req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'static', 'service-worker.js'));
});

app.get('/manifest.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, 'static', 'manifest.json'));
});

// ─── Config ──────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    include_other_brokers_default: config.INCLUDE_OTHER_BROKERS_DEFAULT,
  });
});

// ─── Manual / other-broker holdings ──────────────────────────────────
app.get('/api/manual-holdings', (_req, res) => {
  const db = getDb();
  res.json({ holdings: enrichManualHoldings(db) });
});

app.post('/api/manual-holdings', async (req, res) => {
  try {
    const { display_name, yahoo_ticker, quantity, purchase_price_total, purchase_price_per_share, purchase_date, broker } = req.body;

    if (!display_name || !yahoo_ticker || !quantity || quantity <= 0) {
      return res.status(400).json({ success: false, message: 'Name, ticker and a positive quantity are required' });
    }

    let costBasisEur;
    if (purchase_price_total != null && purchase_price_total > 0) {
      costBasisEur = purchase_price_total;
    } else if (purchase_price_per_share != null && purchase_price_per_share > 0) {
      costBasisEur = purchase_price_per_share * quantity;
    } else {
      return res.status(400).json({ success: false, message: 'Provide either purchase_price_total or purchase_price_per_share' });
    }

    const date = purchase_date || new Date().toISOString().split('T')[0];

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO manual_holdings (display_name, yahoo_ticker, quantity, cost_basis_eur, purchase_date, broker)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(display_name, yahoo_ticker.trim().toUpperCase(), quantity, costBasisEur, date, broker || null);

    const manualHolding = db.prepare('SELECT * FROM manual_holdings WHERE id = ?').get(result.lastInsertRowid);

    fetchManualHoldingPrices(manualHolding).catch((err) => {
      console.error('Error backfilling new manual holding:', err.message);
    });

    res.json({ success: true, holding: enrichManualHoldings(db).find((h) => h.id === manualHolding.id) });
  } catch (err) {
    console.error('Create manual holding error:', err);
    res.status(500).json({ success: false, message: `Error creating holding: ${err.message}` });
  }
});

app.delete('/api/manual-holdings/:id', (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT id FROM manual_holdings WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ success: false, message: 'Holding not found' });

    db.prepare('DELETE FROM manual_holding_prices WHERE manual_holding_id = ?').run(id);
    db.prepare('DELETE FROM manual_holdings WHERE id = ?').run(id);

    res.json({ success: true, message: 'Holding deleted' });
  } catch (err) {
    console.error('Delete manual holding error:', err);
    res.status(500).json({ success: false, message: `Error deleting holding: ${err.message}` });
  }
});

// ─── Holdings ────────────────────────────────────────────────────────
app.get('/api/holdings', (req, res) => {
  const db = getDb();
  const includeManual = includeOtherBrokers(req);

  const holdings = db.prepare(`
    SELECT s.*, SUM(t.quantity) as total_qty, COUNT(t.id) as trans_count
    FROM stocks s JOIN transactions t ON s.id = t.stock_id
    GROUP BY s.id HAVING total_qty > 0
  `).all();

  const result = [];

  if (holdings.length) {
    const stockIds = holdings.map((h) => h.id);
    const idPlaceholders = stockIds.map(() => '?').join(',');

    const latestPrices = db.prepare(`
      SELECT sp.* FROM stock_prices sp
      INNER JOIN (
        SELECT stock_id, MAX(date) as max_date FROM stock_prices
        WHERE stock_id IN (${idPlaceholders}) GROUP BY stock_id
      ) sub ON sp.stock_id = sub.stock_id AND sp.date = sub.max_date
    `).all(...stockIds);

    const latestByStock = {};
    for (const p of latestPrices) latestByStock[p.stock_id] = p;

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

    for (const h of holdings) {
      const latest = latestByStock[h.id];
      const prev = prevByStock[h.id];
      let priceChangePct = null;
      if (latest?.close && prev?.close && prev.close > 0) {
        priceChangePct = ((latest.close - prev.close) / prev.close) * 100;
      }

      result.push({
        id: h.id,
        is_manual: false,
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
      });
    }
  }

  if (includeManual) {
    const manual = enrichManualHoldings(db);
    result.push(...manual);
  }

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
    const startDate = (prices[0].date || '').split('T')[0];
    const endDate = (prices[prices.length - 1].date || '').split('T')[0];
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
    const toComparableTs = (value) => {
      if (!value) return Number.NEGATIVE_INFINITY;
      if (value.includes('T')) return new Date(value).getTime();
      return new Date(`${value}T23:59:59.999Z`).getTime();
    };

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
      const priceTs = toComparableTs(priceDate || '');
      const priceDay = (priceDate || '').split('T')[0];

      while (transIdx < sortedTrans.length && toComparableTs(sortedTrans[transIdx].date || '') <= priceTs) {
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
            if (td <= priceDay && exchangeRateByDate[td]) {
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
app.get('/api/portfolio-summary', (req, res) => {
  const db = getDb();
  const includeManual = includeOtherBrokers(req);

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

  let totalNetInvested = 0;
  for (const h of holdings) {
    const trans = db.prepare('SELECT quantity, total_eur FROM transactions WHERE stock_id = ?').all(h.id);
    const buys = trans.filter((t) => t.quantity > 0).reduce((s, t) => s + Math.abs(t.total_eur), 0);
    const sells = trans.filter((t) => t.quantity < 0).reduce((s, t) => s + Math.abs(t.total_eur), 0);
    totalNetInvested += buys - sells;
  }

  let currentValue = 0;

  if (holdings.length) {
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

    const { globalRates } = loadExchangeRates(db);

    for (const h of holdings) {
      const pr = priceByStock[h.id];
      if (pr?.close) {
        const currency = pr.currency || h.currency;
        const rate = globalRates[currency] ?? fallbacks[currency] ?? 1.0;
        currentValue += h.total_qty * pr.close * rate;
      }
    }
  }

  let manualValue = 0;
  let manualInvested = 0;
  let manualCount = 0;

  if (includeManual) {
    const manual = enrichManualHoldings(db);
    for (const m of manual) {
      if (m.total_value_eur != null) manualValue += m.total_value_eur;
      manualInvested += m.cost_basis_eur || 0;
    }
    manualCount = manual.length;
  }

  const combinedNetInvested = totalNetInvested + manualInvested;
  const combinedCurrentValue = currentValue + manualValue;
  const gainLoss = combinedCurrentValue - combinedNetInvested;
  const gainLossPercent = combinedNetInvested > 0 ? (gainLoss / combinedNetInvested) * 100 : 0;
  const totalProfitLoss = combinedCurrentValue - netDeposited;
  const totalProfitLossPercent = netDeposited > 0 ? (totalProfitLoss / netDeposited) * 100 : 0;

  res.json({
    total_holdings: holdings.length + manualCount,
    net_invested: Math.round(combinedNetInvested * 100) / 100,
    current_value: Math.round(combinedCurrentValue * 100) / 100,
    gain_loss: Math.round(gainLoss * 100) / 100,
    gain_loss_percent: Math.round(gainLossPercent * 100) / 100,
    total_deposited: Math.round(totalDeposited * 100) / 100,
    total_withdrawals: Math.round(totalWithdrawals * 100) / 100,
    net_deposited: Math.round(netDeposited * 100) / 100,
    total_profit_loss: Math.round(totalProfitLoss * 100) / 100,
    total_profit_loss_percent: Math.round(totalProfitLossPercent * 100) / 100,
    other_brokers_included: includeManual,
    other_brokers_value: Math.round(manualValue * 100) / 100,
    other_brokers_invested: Math.round(manualInvested * 100) / 100,
    other_brokers_count: manualCount,
  });
});

// ─── Portfolio valuation history ─────────────────────────────────────
app.get('/api/portfolio-valuation-history', (req, res) => {
  const db = getDb();
  const includeManual = includeOtherBrokers(req);

  const allTransactions = db.prepare('SELECT * FROM transactions ORDER BY date').all();
  const manualHoldings = includeManual ? db.prepare('SELECT * FROM manual_holdings').all() : [];

  if (!allTransactions.length && !manualHoldings.length) {
    return res.json({ dates: [], invested: [], values: [] });
  }

  const hasDegiro = allTransactions.length > 0;

  // Determine start date
  let firstDate;
  if (hasDegiro) {
    firstDate = allTransactions[0].date?.split('T')[0] || allTransactions[0].date;
  } else {
    firstDate = manualHoldings
      .filter((m) => m.purchase_date)
      .sort((a, b) => a.purchase_date.localeCompare(b.purchase_date))[0]?.purchase_date
      || new Date().toISOString().split('T')[0];
  }

  const manualFirstDate = manualHoldings
    .filter((m) => m.purchase_date)
    .sort((a, b) => a.purchase_date.localeCompare(b.purchase_date))[0]?.purchase_date
    || firstDate;

  // Collect all dates from DEGIRO and manual price series
  const dateSet = new Set();

  if (hasDegiro) {
    const degiroDates = db.prepare(
      'SELECT DISTINCT substr(date, 1, 10) as date FROM stock_prices WHERE substr(date, 1, 10) >= ? ORDER BY date'
    ).all(firstDate);
    for (const r of degiroDates) dateSet.add(r.date);
  }

  for (const m of manualHoldings) {
    if (m.purchase_date) dateSet.add(m.purchase_date);
    const manualDates = db.prepare(
      'SELECT DISTINCT substr(date, 1, 10) as date FROM manual_holding_prices WHERE manual_holding_id = ? AND substr(date, 1, 10) >= ? ORDER BY date'
    ).all(m.id, manualFirstDate);
    for (const r of manualDates) dateSet.add(r.date);
  }

  const today = new Date().toISOString().split('T')[0];
  dateSet.add(today);

  const priceDates = Array.from(dateSet).sort();
  if (!priceDates.length) return res.json({ dates: [], invested: [], values: [] });

  // Load DEGIRO prices
  const priceByStock = {};
  if (hasDegiro) {
    const allPrices = db.prepare('SELECT * FROM stock_prices WHERE substr(date, 1, 10) >= ?').all(firstDate);
    for (const p of allPrices) {
      (priceByStock[p.stock_id] = priceByStock[p.stock_id] || []).push(p);
    }
    for (const sid of Object.keys(priceByStock)) {
      priceByStock[sid].sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  // Load manual prices
  const manualPricesByHolding = {};
  if (includeManual) {
    const allManualPrices = db.prepare('SELECT * FROM manual_holding_prices WHERE substr(date, 1, 10) >= ?').all(manualFirstDate);
    for (const p of allManualPrices) {
      (manualPricesByHolding[p.manual_holding_id] = manualPricesByHolding[p.manual_holding_id] || []).push(p);
    }
    for (const hid of Object.keys(manualPricesByHolding)) {
      manualPricesByHolding[hid].sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  // DEGIRO exchange rate helpers
  const transByStock = {};
  for (const t of allTransactions) {
    (transByStock[t.stock_id] = transByStock[t.stock_id] || []).push(t);
  }

  const exchangeRatesByStock = {};
  for (const [sid, trans] of Object.entries(transByStock)) {
    for (let i = trans.length - 1; i >= 0; i--) {
      if (trans[i].exchange_rate) { exchangeRatesByStock[sid] = trans[i].exchange_rate; break; }
    }
  }

  const rateRows = db.prepare('SELECT * FROM exchange_rates').all();
  const globalExchangeRates = { EUR: 1.0 };
  for (const r of rateRows) globalExchangeRates[r.from_currency] = r.rate;
  const fallbackRates = { USD: 0.85, SEK: 0.093, GBP: 1.18 };

  const historicalRates = {};
  for (const r of rateRows) {
    if (!historicalRates[r.from_currency]) historicalRates[r.from_currency] = [];
    historicalRates[r.from_currency].push([r.date.split('T')[0], r.rate]);
  }
  for (const arr of Object.values(historicalRates)) arr.sort((a, b) => a[0].localeCompare(b[0]));

  function getRateOnDateLocal(currency, date) {
    if (currency === 'EUR') return 1.0;
    const arr = historicalRates[currency];
    if (!arr || arr.length === 0) return globalExchangeRates[currency] ?? fallbackRates[currency] ?? 1.0;
    let rate = arr[0][1];
    for (const [d, r] of arr) {
      if (d <= date) rate = r;
      else break;
    }
    return rate;
  }

  // Build DEGIRO events
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

    // DEGIRO value
    for (const [sid, holdings] of Object.entries(runningHoldings)) {
      if (holdings <= 0) continue;
      const prices = priceByStock[sid] || [];
      let priceClose = null;
      let priceCurrency = null;
      for (let i = prices.length - 1; i >= 0; i--) {
        const priceDay = (prices[i].date || '').split('T')[0];
        if (priceDay <= priceDate) {
          priceClose = prices[i].close;
          priceCurrency = prices[i].currency;
          break;
        }
      }
      if (priceClose == null) continue;

      let priceEur = priceClose;
      if (priceCurrency && priceCurrency !== 'EUR') {
        let exchangeRate = null;
        for (const td of Object.keys(exchangeRatesByStock).sort().reverse()) {
          if (td <= priceDate && exchangeRatesByStock[td]) {
            exchangeRate = exchangeRatesByStock[td];
            break;
          }
        }
        if (exchangeRate) {
          priceEur = priceClose / exchangeRate;
        } else {
          priceEur = priceClose * getRateOnDateLocal(priceCurrency, priceDate);
        }
      }
      totalValueEur += holdings * priceEur;
    }

    // Manual holdings value and invested
    let manualInvested = 0;
    for (const m of manualHoldings) {
      if (!m.purchase_date || m.purchase_date > priceDate) continue;
      manualInvested += m.cost_basis_eur;

      const prices = manualPricesByHolding[m.id] || [];
      let priceClose = null;
      let priceCurrency = null;
      for (let i = prices.length - 1; i >= 0; i--) {
        const priceDay = (prices[i].date || '').split('T')[0];
        if (priceDay <= priceDate) {
          priceClose = prices[i].close;
          priceCurrency = prices[i].currency;
          break;
        }
      }
      if (priceClose == null) continue;

      let priceEur = priceClose;
      if (priceCurrency && priceCurrency !== 'EUR') {
        priceEur = priceClose * getRateOnDateLocal(priceCurrency, priceDate);
      }
      totalValueEur += m.quantity * priceEur;
    }

    dates.push(priceDate);
    investedSeries.push(Math.round((runningInvested + manualInvested) * 100) / 100);
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
    const backfill = await backfillHistoricalPricesIfNeeded();
    const { quotes, errors } = await collectAndPersistLiveQuotes();

    const combinedErrors = [...(backfill.errors || []), ...errors];

    res.json({
      success: true,
      quotes,
      count: quotes.length,
      errors: combinedErrors,
      backfill,
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
    let updatedManual = 0;
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

    // Update manual / other-broker holdings
    const manualHoldings = getManualHoldings(db);
    for (const manual of manualHoldings) {
      try {
        if (!manual.yahoo_ticker) {
          errors.push(`No ticker for ${manual.display_name}`);
          continue;
        }
        const count = await fetchManualHoldingPrices(manual);
        if (count > 0) updatedManual++;
      } catch (err) {
        errors.push(`Error updating ${manual.display_name}: ${err.message}`);
      }
    }

    // Update indices
    const indices = db.prepare('SELECT * FROM indices').all();
    for (const index of indices) {
      const count = await fetchIndexPrices(index.symbol, index.id, '7d');
      if (count > 0) updatedIndices++;
    }

    const message = `Updated ${updatedStocks} stocks, ${updatedManual} manual holdings and ${updatedIndices} indices using yahoo`;
    res.json({
      success: true, message,
      stocks_updated: updatedStocks,
      manual_updated: updatedManual,
      indices_updated: updatedIndices,
      errors,
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
    const manualCount = db.prepare('SELECT COUNT(*) as c FROM manual_holdings').get().c;
    const manualPriceCount = db.prepare('SELECT COUNT(*) as c FROM manual_holding_prices').get().c;

    db.prepare('DELETE FROM stock_prices').run();
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM stocks').run();
    db.prepare('DELETE FROM index_prices').run();
    db.prepare('DELETE FROM indices').run();
    db.prepare('DELETE FROM cash_movements').run();
    db.prepare('DELETE FROM manual_holding_prices').run();
    db.prepare('DELETE FROM manual_holdings').run();

    res.json({
      success: true,
      message: 'Database purged successfully',
      deleted: {
        stocks: stockCount, transactions: transCount, stock_prices: priceCount,
        indices: indexCount, index_prices: indexPriceCount, cash_movements: cashMovementCount,
        manual_holdings: manualCount, manual_holding_prices: manualPriceCount,
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
  const includeManual = includeOtherBrokers(req);

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

  const manualHoldings = includeManual
    ? db.prepare('SELECT * FROM manual_holdings WHERE purchase_date <= ?').all(date)
    : [];

  if (!activeStockIds.length && !manualHoldings.length) {
    return res.json({
      date,
      total_value_eur: 0,
      daily_change_eur: 0,
      daily_change_pct: 0,
      holdings: [],
    });
  }

  const { globalRates, historicalRates } = loadExchangeRates(db);
  const getRate = (currency, targetDate) => getRateOnDate(currency, targetDate, globalRates, historicalRates);

  const holdingsList = [];
  let totalValueEur = 0;
  let totalPrevValueEur = 0;

  for (const stockId of activeStockIds) {
    const stock = db.prepare('SELECT * FROM stocks WHERE id = ?').get(stockId);
    if (!stock) continue;

    const qty = holdingsMap[stockId];

    const priceRow = db.prepare(
      `SELECT * FROM stock_prices
       WHERE stock_id = ? AND substr(date, 1, 10) <= ?
       ORDER BY substr(date, 1, 10) DESC, date DESC
       LIMIT 1`
    ).get(stockId, date);

    let prevPriceRow = null;
    if (priceRow) {
      const priceDay = (priceRow.date || '').split('T')[0];
      prevPriceRow = db.prepare(
        `SELECT * FROM stock_prices
         WHERE stock_id = ? AND substr(date, 1, 10) < ?
         ORDER BY substr(date, 1, 10) DESC, date DESC
         LIMIT 1`
      ).get(stockId, priceDay);
    }

    const price = priceRow?.close ?? null;
    const prevPrice = prevPriceRow?.close ?? null;
    const currency = priceRow?.currency || stock.currency;
    const rate = getRate(currency, date);

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
      is_manual: false,
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

  for (const m of manualHoldings) {
    const priceRow = getManualHoldingPriceOnDate(db, m.id, date);

    let prevPriceRow = null;
    if (priceRow) {
      const priceDay = (priceRow.date || '').split('T')[0];
      prevPriceRow = getManualHoldingPrevDayPrice(db, m.id, priceDay);
    }

    const price = priceRow?.close ?? null;
    const prevPrice = prevPriceRow?.close ?? null;
    const currency = priceRow?.currency || m.currency || 'EUR';
    const rate = getRate(currency, date);

    const totalValue = price != null ? price * m.quantity : null;
    const totalValueInEur = totalValue != null ? totalValue * rate : null;
    const prevTotalValue = prevPrice != null ? prevPrice * m.quantity : null;
    const prevTotalValueInEur = prevTotalValue != null ? prevTotalValue * rate : null;

    let dailyChange = null;
    let dailyChangePct = null;
    if (price != null && prevPrice != null && prevPrice > 0) {
      dailyChange = (price - prevPrice) * m.quantity * rate;
      dailyChangePct = ((price - prevPrice) / prevPrice) * 100;
    }

    if (totalValueInEur != null) totalValueEur += totalValueInEur;
    if (prevTotalValueInEur != null) totalPrevValueEur += prevTotalValueInEur;

    holdingsList.push({
      id: m.id,
      is_manual: true,
      name: m.display_name,
      symbol: m.yahoo_ticker,
      isin: null,
      exchange: m.broker || 'Other',
      currency,
      shares: m.quantity,
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
    max_date: latest?.max_date?.split('T')[0] || null,
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
  startHourlyLiveRefreshJob();
});
