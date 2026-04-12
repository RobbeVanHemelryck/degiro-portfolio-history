/**
 * ISIN to Yahoo Finance ticker resolution via Yahoo Finance search API.
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

// In-memory cache to avoid repeated API calls within the same session
const cache = new Map();

async function resolveTickerFromIsin(isin, currency) {
  if (!isin) return null;

  const cacheKey = `${isin}_${currency || ''}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const yf = await getYahoo();
    const result = await yf.search(isin);
    if (!result?.quotes?.length) {
      cache.set(cacheKey, null);
      return null;
    }

    // Filter to equity/ETF type quotes from Yahoo Finance
    const candidates = result.quotes.filter((q) => q.isYahooFinance);
    if (!candidates.length) {
      cache.set(cacheKey, null);
      return null;
    }

    // Prefer a match whose currency matches the requested currency
    let best = candidates[0];
    if (currency) {
      const currencyMatch = candidates.find(
        (q) => q.exchDisp?.includes(currency) || q.symbol?.endsWith(`.${currency}`)
      );
      if (currencyMatch) best = currencyMatch;
    }

    const ticker = best.symbol || null;
    cache.set(cacheKey, ticker);
    return ticker;
  } catch (err) {
    console.error(`Error resolving ISIN ${isin}:`, err.message);
    cache.set(cacheKey, null);
    return null;
  }
}

async function getTickerForStock(isin, name, currency) {
  return resolveTickerFromIsin(isin, currency);
}

module.exports = { resolveTickerFromIsin, getTickerForStock };
