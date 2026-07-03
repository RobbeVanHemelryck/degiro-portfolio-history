const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
    db = new Database(config.DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDb() {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS stocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT UNIQUE,
      name TEXT,
      isin TEXT UNIQUE,
      exchange TEXT,
      currency TEXT DEFAULT 'EUR',
      yahoo_ticker TEXT,
      data_provider TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stocks_isin ON stocks(isin);
    CREATE INDEX IF NOT EXISTS idx_stocks_symbol ON stocks(symbol);

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER REFERENCES stocks(id),
      date TEXT,
      time TEXT,
      quantity INTEGER,
      price REAL,
      currency TEXT,
      value_eur REAL,
      total_eur REAL,
      venue TEXT,
      exchange_rate REAL,
      fees_eur REAL,
      transaction_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_transactions_stock ON transactions(stock_id);

    CREATE TABLE IF NOT EXISTS stock_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER REFERENCES stocks(id),
      date TEXT,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume INTEGER,
      currency TEXT DEFAULT 'EUR'
    );
    CREATE INDEX IF NOT EXISTS idx_stock_prices_date ON stock_prices(date);
    CREATE INDEX IF NOT EXISTS idx_stock_prices_stock ON stock_prices(stock_id);

    CREATE TABLE IF NOT EXISTS indices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT UNIQUE,
      name TEXT
    );

    CREATE TABLE IF NOT EXISTS index_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      index_id INTEGER REFERENCES indices(id),
      date TEXT,
      close REAL
    );
    CREATE INDEX IF NOT EXISTS idx_index_prices_date ON index_prices(date);

    CREATE TABLE IF NOT EXISTS exchange_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      from_currency TEXT,
      to_currency TEXT DEFAULT 'EUR',
      rate REAL
    );
    CREATE INDEX IF NOT EXISTS idx_exchange_rates_date ON exchange_rates(date);

    CREATE TABLE IF NOT EXISTS cash_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      time TEXT,
      value_date TEXT,
      description TEXT,
      currency TEXT DEFAULT 'EUR',
      amount REAL,
      balance REAL,
      type TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cash_movements_date ON cash_movements(date);
    CREATE INDEX IF NOT EXISTS idx_cash_movements_type ON cash_movements(type);

    -- Manual / other-broker holdings
    CREATE TABLE IF NOT EXISTS manual_holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      yahoo_ticker TEXT NOT NULL,
      quantity REAL NOT NULL,
      cost_basis_eur REAL NOT NULL,
      purchase_date TEXT,
      currency TEXT DEFAULT 'EUR',
      broker TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_manual_holdings_ticker ON manual_holdings(yahoo_ticker);

    CREATE TABLE IF NOT EXISTS manual_holding_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manual_holding_id INTEGER REFERENCES manual_holdings(id) ON DELETE CASCADE,
      date TEXT,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume INTEGER,
      currency TEXT DEFAULT 'EUR'
    );
    CREATE INDEX IF NOT EXISTS idx_manual_holding_prices_holding ON manual_holding_prices(manual_holding_id);
    CREATE INDEX IF NOT EXISTS idx_manual_holding_prices_date ON manual_holding_prices(date);
  `);
}

module.exports = { getDb, initDb };
