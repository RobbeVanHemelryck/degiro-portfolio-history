/**
 * Import transaction data from DEGIRO Excel files.
 */
const XLSX = require('xlsx');
const { getDb } = require('./database');
const { config, col } = require('./config');
const { getTickerForStock } = require('./tickerResolver');

/**
 * Normalize DEGIRO column headers to canonical names by position.
 */
function normalizeColumns(headers) {
  const ncols = headers.length;

  if (ncols === 14) {
    // 14-column format: map by position
    const mapping = {};
    for (let i = 0; i < 14; i++) {
      mapping[headers[i]] = config.DEGIRO_COLUMN_ORDER[i];
    }
    return mapping;
  }

  if (ncols === 18 || ncols === 19) {
    // 18/19-column format: select specific positions
    const mapping = {};
    for (const [pos, canonical] of Object.entries(config.DEGIRO_18COL_POSITIONS)) {
      mapping[headers[parseInt(pos)]] = canonical;
    }
    return mapping;
  }

  throw new Error(
    `Expected 14, 18, or 19 columns in DEGIRO export, got ${ncols}. Columns: ${headers.join(', ')}`
  );
}

/**
 * Parse a date + time string into an ISO datetime string.
 */
function parseDate(dateVal, timeStr) {
  if (dateVal == null || dateVal === '' || String(dateVal).toLowerCase() === 'nan') {
    return null;
  }

  // If it's already a Date object (from xlsx)
  if (dateVal instanceof Date) {
    if (typeof timeStr === 'string' && timeStr.includes(':')) {
      const parts = timeStr.split(':');
      dateVal.setHours(parseInt(parts[0]), parseInt(parts[1]));
    }
    return dateVal.toISOString();
  }

  const dateStr = String(dateVal);

  // Try DD-MM-YYYY or DD/MM/YYYY format (DEGIRO day-first)
  const dayFirstMatch = dateStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dayFirstMatch) {
    const [, day, month, year] = dayFirstMatch;
    const timePart = typeof timeStr === 'string' && timeStr.includes(':') ? `T${timeStr}:00` : 'T00:00:00';
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}${timePart}`;
  }

  // Try YYYY-MM-DD
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const timePart = typeof timeStr === 'string' && timeStr.includes(':') ? `T${timeStr}:00` : 'T00:00:00';
    return `${dateStr}${timePart}`;
  }

  // Fallback: try native parsing
  const parsed = new Date(`${dateStr} ${timeStr || ''}`);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * Determine native currency for a product from the transaction data.
 */
function determineNativeCurrency(rows, product) {
  const currencyCounts = {};
  for (const row of rows) {
    if (row[col('product')] === product) {
      const c = row[col('currency')];
      currencyCounts[c] = (currencyCounts[c] || 0) + 1;
    }
  }
  let best = 'EUR';
  let bestCount = 0;
  for (const [c, count] of Object.entries(currencyCounts)) {
    if (count > bestCount) { best = c; bestCount = count; }
  }
  return best;
}

/**
 * Process an uploaded DEGIRO Excel file buffer.
 * Returns { newTransactions, updatedStocks, stockIdsToFetch }.
 */
async function processTransactionFile(buffer, filename) {
  const db = getDb();

  // Read workbook
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });

  if (rawRows.length === 0) {
    return { newTransactions: 0, updatedStocks: 0, errors: ['File is empty'] };
  }

  // Normalize column names
  const originalHeaders = Object.keys(rawRows[0]);
  const columnMapping = normalizeColumns(originalHeaders);

  // Remap rows to canonical column names
  const rows = rawRows.map((row) => {
    const mapped = {};
    for (const [origKey, canonKey] of Object.entries(columnMapping)) {
      mapped[canonKey] = row[origKey];
    }
    return mapped;
  });

  let newTransactions = 0;
  let updatedStocks = 0;
  const stockIdsToFetch = new Set();

  // Pre-resolve tickers for all new ISINs before the synchronous transaction
  const tickerCache = new Map();
  for (const row of rows) {
    const isin = row[col('isin')];
    if (!isin || config.IGNORED_STOCKS.has(isin) || tickerCache.has(isin)) continue;
    const existing = db.prepare('SELECT id FROM stocks WHERE isin = ?').get(isin);
    if (!existing) {
      const productName = row[col('product')] || '';
      const nativeCurrency = determineNativeCurrency(rows, productName);
      tickerCache.set(isin, await getTickerForStock(isin, productName, nativeCurrency));
    }
  }

  const insertStock = db.prepare(`
    INSERT INTO stocks (symbol, name, isin, exchange, currency, yahoo_ticker)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertTransaction = db.prepare(`
    INSERT INTO transactions (stock_id, date, time, quantity, price, currency, value_eur, total_eur, venue, exchange_rate, fees_eur, transaction_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Detect DEGIRO implicit-decimal format: exchange rates and prices are stored
  // as integers with 4 implied decimal places, EUR amounts with 2 implied places.
  // Detect by checking if exchange_rate values are all > 100 (real rates are 0.5–2.0),
  // or if no FX data, check if all prices are large integers (>10000 means >1.0 real).
  let priceScale = 1;
  let eurScale = 1;
  let fxScale = 1;
  const sampleRates = rows
    .map((r) => parseFloat(r[col('exchange_rate')]))
    .filter((v) => v && !isNaN(v) && v !== 0);
  const samplePrices = rows
    .map((r) => parseFloat(r[col('price')]))
    .filter((v) => v && !isNaN(v) && v !== 0);
  const hasScaledRates = sampleRates.length > 0 && sampleRates.every((v) => Math.abs(v) > 100);
  const hasScaledPrices = samplePrices.length > 0 && samplePrices.every((v) => Number.isInteger(v) && Math.abs(v) > 10000);
  if (hasScaledRates || hasScaledPrices) {
    priceScale = 10000;
    eurScale = 100;
    fxScale = 10000;
  }

  const importAll = db.transaction(() => {
    for (const row of rows) {
      const dateVal = row[col('date')];
      if (dateVal == null || String(dateVal).toLowerCase() === 'nan') continue;

      const isin = row[col('isin')];
      if (!isin || config.IGNORED_STOCKS.has(isin)) continue;

      // Get or create stock
      let stock = db.prepare('SELECT * FROM stocks WHERE isin = ?').get(isin);

      if (!stock) {
        const productName = row[col('product')] || '';
        const nativeCurrency = determineNativeCurrency(rows, productName);
        let symbol = productName.split(/\s+/)[0]?.toUpperCase() || isin;

        // Avoid unique constraint on symbol
        const existingSymbol = db.prepare('SELECT id FROM stocks WHERE symbol = ?').get(symbol);
        if (existingSymbol) symbol = isin;

        const yahooTicker = tickerCache.get(isin) || null;

        insertStock.run(symbol, productName, isin, row[col('exchange')] || '', nativeCurrency, yahooTicker);
        stock = db.prepare('SELECT * FROM stocks WHERE isin = ?').get(isin);
        updatedStocks++;
      }

      stockIdsToFetch.add(stock.id);

      // Parse date
      const transDate = parseDate(dateVal, String(row[col('time')] ?? ''));
      if (!transDate) continue;

      const quantity = parseInt(row[col('quantity')]) || 0;
      const price = (parseFloat(row[col('price')]) || 0) / priceScale;

      // Check for duplicate
      const existing = db.prepare(
        'SELECT id FROM transactions WHERE stock_id = ? AND date = ? AND quantity = ? AND price = ?'
      ).get(stock.id, transDate, quantity, price);

      if (!existing) {
        const exchangeRate = row[col('exchange_rate')];
        const feesEur = row[col('fees_eur')];

        insertTransaction.run(
          stock.id,
          transDate,
          String(row[col('time')] ?? ''),
          quantity,
          price,
          row[col('currency')] || 'EUR',
          (parseFloat(row[col('value_eur')]) || 0) / eurScale,
          (parseFloat(row[col('total_eur')]) || 0) / eurScale,
          row[col('venue')] || '',
          exchangeRate != null && !isNaN(parseFloat(exchangeRate)) ? parseFloat(exchangeRate) / fxScale : null,
          feesEur != null && !isNaN(parseFloat(feesEur)) ? parseFloat(feesEur) / eurScale : null,
          String(row[col('transaction_id')] ?? '')
        );
        newTransactions++;
      }
    }
  });

  importAll();

  return { newTransactions, updatedStocks, stockIdsToFetch: [...stockIdsToFetch] };
}

/**
 * Descriptions that indicate deposits/withdrawals in DEGIRO account statements.
 */
const CASH_MOVEMENT_PATTERNS = {
  deposit: ['flatex Deposit'],
  withdrawal: ['Processed Flatex Withdrawal', 'flatex terugstorting'],
};

/**
 * Process an uploaded DEGIRO Account Excel file.
 * Returns { newMovements, errors }.
 */
function processAccountFile(buffer) {
  const db = getDb();

  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: true });
  const sheetName = workbook.SheetNames[0];
  const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null, raw: true });

  if (rawRows.length === 0) {
    return { newMovements: 0, errors: ['File is empty'] };
  }

  // Excel columns: Datum, Tijd, Valutadatum, Product, ISIN, Omschrijving, FX,
  // Mutatie (currency), __EMPTY (amount), Saldo (currency), __EMPTY_1 (balance), Order Id
  const allPatterns = [
    ...CASH_MOVEMENT_PATTERNS.deposit,
    ...CASH_MOVEMENT_PATTERNS.withdrawal,
  ];

  let newMovements = 0;
  const errors = [];

  const insertMovement = db.prepare(`
    INSERT INTO cash_movements (date, time, value_date, description, currency, amount, balance, type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const importAll = db.transaction(() => {
    for (const row of rawRows) {
      const description = String(row['Omschrijving'] || '');

      const matched = allPatterns.find((p) => description === p);
      if (!matched) continue;

      const amount = row['__EMPTY'];
      if (amount == null || typeof amount !== 'number') continue;

      const isDeposit = CASH_MOVEMENT_PATTERNS.deposit.includes(matched);
      let type;
      if (isDeposit) {
        type = 'deposit';
      } else {
        type = amount < 0 ? 'withdrawal' : 'deposit';
      }

      const dateStr = String(row['Datum'] || '');
      const timeStr = String(row['Tijd'] || '');
      const valueDateStr = String(row['Valutadatum'] || '');
      const currency = String(row['Mutatie'] || 'EUR');
      const balance = typeof row['__EMPTY_1'] === 'number' ? row['__EMPTY_1'] : null;

      const parsedDate = parseDate(dateStr, timeStr);
      const parsedValueDate = parseDate(valueDateStr);
      if (!parsedDate) continue;

      const existing = db.prepare(
        'SELECT id FROM cash_movements WHERE date = ? AND amount = ? AND description = ?'
      ).get(parsedDate, amount, description);

      if (!existing) {
        insertMovement.run(
          parsedDate,
          timeStr,
          parsedValueDate || parsedDate,
          description,
          currency,
          amount,
          balance,
          type
        );
        newMovements++;
      }
    }
  });

  importAll();

  return { newMovements, errors };
}

module.exports = { processTransactionFile, processAccountFile, parseDate };
