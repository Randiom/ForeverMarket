function rateLimitedFetch(fetcher, { limit = 28, windowMs = 60000, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let starts = [];
  return async (...args) => {
    while (true) {
      const time = now();
      starts = starts.filter(start => time - start < windowMs);
      if (starts.length < limit) { starts.push(time); break; }
      await wait(Math.max(1, starts[0] + windowMs - time));
    }
    return fetcher(...args);
  };
}
module.exports = { rateLimitedFetch };
