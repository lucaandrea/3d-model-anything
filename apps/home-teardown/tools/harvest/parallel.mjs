// A small client for Parallel's web APIs (https://docs.parallel.ai): Search, Extract and Image Search.
// Auth is the x-api-key header; every call is a POST that returns JSON. Usage is tallied in USD from the SKU counts
// each response reports, at the published prices (2026-11): Search advanced $0.005 per request with 10 results, $0.001
// per extra result; Extract $0.001 per URL; Image Search fast $0.001 per request.
import {readKey} from '../../server/env.mjs';

const BASE = 'https://api.parallel.ai';
export const spend = {usd: 0, calls: {search: 0, extract: 0, images: 0}};

export function parallel() {
  const {key} = readKey('PARALLEL_API_KEY');
  if (!key) throw new Error('PARALLEL_API_KEY is not set (environment or .env)');
  const post = async (path, body, tries = 4) => {
    for (let i = 0; ; i++) {
      const r = await fetch(`${BASE}${path}`, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-api-key': key}, body: JSON.stringify(body)});
      if (r.ok) return r.json();
      const text = await r.text();
      // 429 and 5xx are retried with backoff; anything else is a request error worth stopping for
      if ((r.status === 429 || r.status >= 500) && i < tries) {
        await new Promise((res) => setTimeout(res, 1500 * 2 ** i + Math.random() * 500));
        continue;
      }
      throw new Error(`Parallel ${path} ${r.status}: ${text.slice(0, 300)}`);
    }
  };
  return {
    /** Ranked pages on the given domains, with excerpts focused on the objective. */
    async search({objective, queries, domains, maxResults = 20, chars = 2000}) {
      const res = await post('/v1/search', {
        objective,
        search_queries: queries,
        mode: 'advanced',
        advanced_settings: {source_policy: {include_domains: domains}, max_results: maxResults, excerpt_settings: {max_chars_per_result: chars}, location: 'us'},
      });
      spend.calls.search++;
      spend.usd += 0.005 + Math.max(0, res.results.length - 10) * 0.001;
      return res.results;
    },
    /** Page excerpts (markdown) for up to 20 URLs, focused on the objective. */
    async extract({urls, objective, chars = 3000}) {
      const res = await post('/v1/extract', {urls, objective, advanced_settings: {excerpt_settings: {max_chars_per_result: chars}}});
      spend.calls.extract++;
      spend.usd += urls.length * 0.001;
      return {results: res.results, errors: res.errors};
    },
    /** Image results: image_url plus the page each appears on. */
    async images({queries, objective, max = 8}) {
      const res = await post('/v1/images/search', {search_queries: queries, objective, mode: 'fast', advanced_settings: {max_results: max, location: 'us'}});
      spend.calls.images++;
      spend.usd += 0.001;
      return res.results;
    },
  };
}

/** Runs fn over items with at most n in flight. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({length: Math.min(n, items.length)}, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
