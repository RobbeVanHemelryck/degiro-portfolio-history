const path = require('path');

const config = {
  // Paths
  DB_DIR: process.env.DEGIRO_PORTFOLIO_DB_DIR || '/config',
  DB_PATH: process.env.DEGIRO_PORTFOLIO_DB || path.join(process.env.DEGIRO_PORTFOLIO_DB_DIR || '/config', 'degiro_portfolio.db'),

  // Server
  HOST: process.env.DEGIRO_PORTFOLIO_HOST || '0.0.0.0',
  PORT: parseInt(process.env.DEGIRO_PORTFOLIO_PORT || '8000', 10),
  PUBLIC_URL: process.env.DEGIRO_PORTFOLIO_PUBLIC_URL || '',
  TRUST_PROXY: process.env.DEGIRO_PORTFOLIO_TRUST_PROXY !== '0' && process.env.DEGIRO_PORTFOLIO_TRUST_PROXY !== 'false',

  // Feature flags
  INCLUDE_OTHER_BROKERS_DEFAULT: process.env.DEGIRO_PORTFOLIO_INCLUDE_OTHER_BROKERS_DEFAULT === '1' || process.env.DEGIRO_PORTFOLIO_INCLUDE_OTHER_BROKERS_DEFAULT === 'true',

  // Data provider: 'yahoo' (only yahoo supported in Node version)
  PRICE_DATA_PROVIDER: 'yahoo',

  // Market indices
  INDICES: {
    '^GSPC': 'S&P 500',
    '^STOXX50E': 'Euro Stoxx 50',
  },

  // Ignored stocks (ISIN codes)
  IGNORED_STOCKS: new Set([
    'US82669G1040', // Signature Bank (collapsed March 2023)
  ]),

  // DEGIRO column order (14-column format)
  DEGIRO_COLUMN_ORDER: [
    'Date', 'Time', 'Product', 'ISIN', 'Reference exchange',
    'Quantity', 'Price', 'Currency', 'Value EUR', 'Total EUR',
    'Venue', 'Exchange rate', 'Fees EUR', 'Transaction ID',
  ],

  // 18-column positions
  DEGIRO_18COL_POSITIONS: {
    0: 'Date', 1: 'Time', 2: 'Product', 3: 'ISIN',
    4: 'Reference exchange', 5: 'Venue', 6: 'Quantity',
    7: 'Price', 8: 'Currency', 11: 'Value EUR',
    12: 'Exchange rate', 14: 'Fees EUR', 15: 'Total EUR',
    16: 'Transaction ID',
  },

  // Column key mapping
  COLUMNS: {
    date: 'Date',
    time: 'Time',
    transaction_id: 'Transaction ID',
    product: 'Product',
    isin: 'ISIN',
    exchange: 'Reference exchange',
    quantity: 'Quantity',
    price: 'Price',
    currency: 'Currency',
    venue: 'Venue',
    value_eur: 'Value EUR',
    total_eur: 'Total EUR',
    fees_eur: 'Fees EUR',
    exchange_rate: 'Exchange rate',
  },
};

function col(key) {
  return config.COLUMNS[key] || key;
}

module.exports = { config, col };
