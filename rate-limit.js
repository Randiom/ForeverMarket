function waitFor(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function rateLimitedFetch(fetcher, { limit = 28, windowMs = 60000, now = Date.now, readyAt = () => 0, wait = waitFor } = {}) {
  let starts = [];
  return async (url, options = {}) => {
    while (true) {
      options.signal?.throwIfAborted();
      const time = now();
      if (readyAt() > time) { await wait(readyAt() - time, options.signal); continue; }
      starts = starts.filter(start => time - start < windowMs);
      if (starts.length < limit) { starts.push(time); break; }
      await wait(Math.max(1, starts[0] + windowMs - time), options.signal);
    }
    return fetcher(url, options);
  };
}
module.exports = { rateLimitedFetch, waitFor };
