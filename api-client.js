const { rateLimitedFetch } = require('./rate-limit');

function createApiClient(fetcher = fetch, { apiKey = '', now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  apiKey = apiKey.trim();
  if (apiKey && !/^ahlk_[\w-]+$/.test(apiKey)) throw new Error('AHLEDGER_API_KEY has an invalid format');
  let retryUntil = 0;
  const limited = rateLimitedFetch((url, options) => fetcher(url, { ...options, signal: AbortSignal.timeout(20000) }), { limit: apiKey ? 299 : 28, now, wait, readyAt: () => retryUntil });
  const cache = new Map();
  const replay = entry => ({ ok: true, status: entry.status, headers: entry.headers, text: async () => entry.text, json: async () => JSON.parse(entry.text) });
  return async (url, options = {}) => {
    // Never attach credentials to a caller-supplied destination outside this API.
    if (!url.startsWith('https://api.ahledger.com/')) throw new Error('Invalid AHledger API destination');
    const saved = cache.get(url);
    if (saved && saved.expires > now()) return replay(saved);
    if (saved) cache.delete(url);
    // Create the timeout after rate-limit waiting, not while queued for admission.
    const response = await limited(url, {
      ...options, signal: undefined,
      headers: { ...options.headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    });
    if (response.status === 429 || response.status === 503) {
      const header = response.headers?.get('Retry-After');
      const delay = header && Number.isFinite(Number(header)) ? Number(header) * 1000 : (Date.parse(header) - now());
      retryUntil = Math.max(retryUntil, now() + (Number.isFinite(delay) && delay > 0 ? delay : 60000));
    }
    const control = response.headers?.get('Cache-Control') || '';
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(control);
    const age = Math.max(0, Number(response.headers?.get('Age') || 0));
    const ttl = maxAge ? Math.max(0, Number(maxAge[1]) - age) * 1000 : 0;
    if (!response.ok || !ttl || /\bno-store\b|\bno-cache\b/i.test(control)) return response;
    const entry = { text: await response.text(), status: response.status, headers: response.headers, expires: now() + ttl };
    cache.set(url, entry);
    const timer = setTimeout(() => { if (cache.get(url) === entry) cache.delete(url); }, ttl);
    timer.unref();
    return replay(entry);
  };
}

module.exports = { createApiClient };
