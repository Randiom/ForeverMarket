const { rateLimitedFetch, waitFor } = require('./rate-limit');

function createApiClient(fetcher = fetch, { apiKey = '', now = Date.now, wait = waitFor } = {}) {
  apiKey = apiKey.trim();
  if (apiKey && !/^ahlk_[\w-]+$/.test(apiKey)) throw new Error('AHLEDGER_API_KEY has an invalid format');
  let retryUntil = 0;
  const limited = rateLimitedFetch((url, { timeoutMs = 30000, attempts, ...options }) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetcher(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
  }, { limit: apiKey ? 299 : 28, now, wait, readyAt: () => retryUntil });
  const cache = new Map();
  const replay = entry => ({
    ok: true, status: entry.status, headers: entry.headers, text: async () => entry.text,
    json: async () => {
      try { return JSON.parse(entry.text); }
      catch { throw new Error(`AHledger ${entry.label}: returned invalid JSON`); }
    },
  });
  const client = async (url, options = {}) => {
    if (!url.startsWith('https://api.ahledger.com/')) throw new Error('Invalid AHledger API destination');
    const parsed = new URL(url);
    const label = parsed.pathname + (parsed.searchParams.has('profession') ? `?profession=${encodeURIComponent(parsed.searchParams.get('profession'))}` : '');
    if (options.signal?.aborted) throw new Error(`AHledger ${label}: refresh time budget exceeded`);
    const saved = cache.get(url);
    if (saved && saved.expires > now()) return replay(saved);
    if (saved) cache.delete(url);
    // Only read requests may be repeated; each attempt uses the shared rate budget.
    const attempts = options.attempts ?? (!options.method || options.method === 'GET' ? 2 : 1);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await limited(url, {
          ...options,
          headers: { ...options.headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        });
        if (response.status === 429 || response.status === 503) {
          const header = response.headers?.get('Retry-After');
          const delay = header && Number.isFinite(Number(header)) ? Number(header) * 1000 : (Date.parse(header) - now());
          retryUntil = Math.max(retryUntil, now() + (Number.isFinite(delay) && delay > 0 ? delay : 60000));
        }
        if (!response.ok) return response;
        const receivedAt = now();
        const control = response.headers?.get('Cache-Control') || '';
        const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(control);
        const age = Math.max(0, Number(response.headers?.get('Age') || 0));
        const ttl = maxAge ? Math.max(0, Number(maxAge[1]) - age) * 1000 : 0;
        // Read the body here too so a stalled body gets the same retry and endpoint label.
        const entry = { text: await response.text(), status: response.status, headers: response.headers, expires: receivedAt + ttl, label };
        if (entry.expires > now() && !/\bno-store\b|\bno-cache\b/i.test(control)) {
          cache.set(url, entry);
          const timer = setTimeout(() => { if (cache.get(url) === entry) cache.delete(url); }, entry.expires - now());
          timer.unref();
        }
        return replay(entry);
      } catch (error) {
        if (options.signal?.aborted) throw new Error(`AHledger ${label}: refresh time budget exceeded`);
        const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
        const code = error.cause?.code || error.code;
        const transient = timeout || error instanceof TypeError || /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_)/.test(code || '');
        if (!transient) throw new Error(`AHledger ${label}: request processing failed`);
        if (attempt === attempts) throw new Error(`AHledger ${label}: ${timeout ? `timed out after ${(options.timeoutMs || 30000) / 1000} seconds` : 'network request failed'} (${attempt} attempts)`);
        console.warn(`AHledger ${label}: ${timeout ? 'request timed out' : 'network request failed'}; retrying once`);
        await wait(1000, options.signal);
      }
    }
  };
  client.hasFresh = url => {
    const entry = cache.get(url);
    return Boolean(entry && entry.expires > now());
  };
  return client;
}

module.exports = { createApiClient };
