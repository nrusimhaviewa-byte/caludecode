import express from 'express';

const app = express();
const PORT = process.env.PORT || 8080;
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
// complex_intricate_networks/economic-times-intelligence-scraper-markets-policy-data
const ACTOR_ID = process.env.APIFY_ACTOR_ID || 'mrE0hmRF359AXBWtl';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30 * 60 * 1000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://nrusimhaviewa-byte.github.io';

let cache = { data: null, fetchedAt: 0, error: null, refreshing: null };

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

async function refreshCache() {
  if (!APIFY_TOKEN) {
    cache = { ...cache, error: 'APIFY_TOKEN not configured on the server' };
    return;
  }
  try {
    const url = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scrapeDuration: '1 week' }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Apify run failed: ${resp.status} ${text}`);
    }
    const items = await resp.json();
    cache = { data: items, fetchedAt: Date.now(), error: null, refreshing: null };
  } catch (err) {
    cache = { ...cache, error: String(err && err.message ? err.message : err), refreshing: null };
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/news', async (req, res) => {
  const age = Date.now() - cache.fetchedAt;
  const stale = age > CACHE_TTL_MS || !cache.fetchedAt;
  if (stale) {
    // De-dupe concurrent refreshes from overlapping client polls.
    if (!cache.refreshing) cache.refreshing = refreshCache();
    await cache.refreshing;
  }
  res.json({
    items: cache.data || [],
    fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    ageSeconds: cache.fetchedAt ? Math.round((Date.now() - cache.fetchedAt) / 1000) : null,
    error: cache.error,
  });
});

app.listen(PORT, () => console.log(`momentwealth-backend listening on ${PORT}`));
