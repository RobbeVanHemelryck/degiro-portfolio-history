/**
 * ISIN to Yahoo Finance ticker resolution via Yahoo Finance search API.
 */

let yahooFinance;
async function getYahoo() {
  if (!yahooFinance) {
    const mod = await import('yahoo-finance2');
    const YahooFinance = mod.default;
    yahooFinance = new YahooFinance({
      queue: { concurrency: 1 },
      validation: { logErrors: false },
    });
  }
  return yahooFinance;
}

// In-memory cache to avoid repeated API calls within the same session
const cache = new Map();

// Yahoo's ISIN search can return non-EUR listings first, or miss a UCITS ETF
// altogether. Prefer known liquid EUR listings for common DEGIRO ETF exports.
const ISIN_TICKER_OVERRIDES = {
  IE00B3WJKG14: 'QDVE.DE',
  IE00BKM4GZ66: 'EMIM.AS',
  LU1681040223: 'C6E.PA',
  IE00B53L3W79: 'CSX5.AS',
  IE00B5BMR087: 'SXR8.DE',
  IE00BK5BQT80: 'VWCE.DE',
  IE00B4L5Y983: 'IWDA.AS',
  IE00B53SZB19: 'SXRV.DE',
  IE0008470928: 'EUN1.DE',
};

const EUROPEAN_SUFFIX_PRIORITY = ['.AS', '.DE', '.PA', '.MI', '.BR', '.SW'];
const NON_EUR_SUFFIX_PENALTY = ['.L'];

function scoreCandidate(candidate, currency) {
  let score = 0;
  const symbol = candidate.symbol || '';
  const exchange = candidate.exchange || '';
  const exchangeDisplay = candidate.exchDisp || '';
  const quoteType = String(candidate.quoteType || candidate.typeDisp || '').toUpperCase();

  if (candidate.isYahooFinance) score += 20;
  if (quoteType.includes('ETF')) score += 15;
  if (quoteType.includes('EQUITY')) score += 5;

  const suffixIndex = EUROPEAN_SUFFIX_PRIORITY.findIndex((suffix) => symbol.endsWith(suffix));
  if (suffixIndex >= 0) score += 30 - suffixIndex;
  if (NON_EUR_SUFFIX_PENALTY.some((suffix) => symbol.endsWith(suffix))) score -= 25;

  if (currency === 'EUR') {
    if (['AMS', 'GER', 'PAR', 'MIL', 'BRU'].includes(exchange)) score += 15;
    if (/Amsterdam|XETRA|Paris|Milan|Brussels/i.test(exchangeDisplay)) score += 10;
    if (/London/i.test(exchangeDisplay)) score -= 15;
  }

  return score;
}

function pickTicker(quotes, currency) {
  const candidates = quotes
    .filter((q) => q.symbol && (q.isYahooFinance || q.quoteType || q.typeDisp))
    .sort((a, b) => scoreCandidate(b, currency) - scoreCandidate(a, currency));

  return candidates[0]?.symbol || null;
}

async function searchYahoo(query) {
  const yf = await getYahoo();
  try {
    return await yf.search(query, {}, { validateResult: false });
  } catch (err) {
    if (err.result) return err.result;
    throw err;
  }
}

async function resolveTickerFromIsin(isin, currency) {
  return resolveTickerForStock(isin, '', currency);
}

async function resolveTickerForStock(isin, name, currency) {
  if (!isin) return null;

  const cacheKey = `${isin}_${currency || ''}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  if (ISIN_TICKER_OVERRIDES[isin]) {
    cache.set(cacheKey, ISIN_TICKER_OVERRIDES[isin]);
    return ISIN_TICKER_OVERRIDES[isin];
  }

  try {
    const result = await searchYahoo(isin);
    if (!result?.quotes?.length) {
      const ticker = name ? pickTicker((await searchYahoo(name))?.quotes || [], currency) : null;
      cache.set(cacheKey, ticker);
      return ticker;
    }

    const ticker = pickTicker(result.quotes, currency);
    cache.set(cacheKey, ticker);
    return ticker;
  } catch (err) {
    console.error(`Error resolving ISIN ${isin}:`, err.message);
    cache.set(cacheKey, null);
    return null;
  }
}

async function getTickerForStock(isin, name, currency) {
  return resolveTickerForStock(isin, name, currency);
}

module.exports = { resolveTickerFromIsin, getTickerForStock, resolveTickerForStock };
