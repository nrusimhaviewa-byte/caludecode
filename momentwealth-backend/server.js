import express from 'express';

const app = express();
const PORT = process.env.PORT || 8080;
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const ACTOR_ID = process.env.APIFY_ACTOR_ID || 'mrE0hmRF359AXBWtl';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15 * 60 * 1000); // 15 mins
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

let cache = { data: [], fetchedAt: 0, error: null, refreshing: null };

// Known Indian Stock Tickers & Companies Map for automatic tagging
const STOCK_PATTERNS = [
  { ticker: 'HAL', names: ['HAL', 'Hindustan Aeronautics'] },
  { ticker: 'HINDZINC', names: ['Hindustan Zinc', 'Hind Zinc', 'HZL'] },
  { ticker: 'WELSPUN', names: ['Welspun', 'Welspun Corp'] },
  { ticker: 'TCS', names: ['TCS', 'Tata Consultancy'] },
  { ticker: 'RELIANCE', names: ['Reliance', 'RIL', 'Jio Financial'] },
  { ticker: 'ZOMATO', names: ['Zomato'] },
  { ticker: 'BEL', names: ['BEL', 'Bharat Electronics'] },
  { ticker: 'BDL', names: ['BDL', 'Bharat Dynamics'] },
  { ticker: 'MAZDOCK', names: ['Mazagon Dock', 'Mazdock'] },
  { ticker: 'TATAMOTORS', names: ['Tata Motors', 'TaMo'] },
  { ticker: 'HDFCBANK', names: ['HDFC Bank', 'HDFC'] },
  { ticker: 'ICICIBANK', names: ['ICICI Bank', 'ICICI'] },
  { ticker: 'INFY', names: ['Infosys', 'Infy'] },
  { ticker: 'ITC', names: ['ITC'] },
  { ticker: 'BHARTIARTL', names: ['Bharti Airtel', 'Airtel'] },
  { ticker: 'CYIENT', names: ['Cyient'] },
  { ticker: 'MOREPENLAB', names: ['Morepen', 'Morepen Lab'] },
  { ticker: 'SOLARINDS', names: ['Solar Ind', 'Solar Industries'] },
  { ticker: 'MARUTI', names: ['Maruti', 'Maruti Suzuki'] },
  { ticker: 'NESTLEIND', names: ['Nestle', 'Nestle India'] },
  { ticker: 'GRASIM', names: ['Grasim'] },
  { ticker: 'HCLTECH', names: ['HCL Tech', 'HCL Technologies'] },
];

function extractStocks(text) {
  if (!text) return [];
  const found = [];
  for (const s of STOCK_PATTERNS) {
    for (const name of s.names) {
      const regex = new RegExp(`\\b${name}\\b`, 'i');
      if (regex.test(text)) {
        if (!found.includes(s.ticker)) found.push(s.ticker);
        break;
      }
    }
  }
  return found;
}

function cleanHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

function parseRssXml(xmlText, sourceName, defaultCategory = 'MARKETS') {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<title>(?:<\!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/title>/i);
    const linkMatch = block.match(/<link>(?:<\!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/link>/i);
    const descMatch = block.match(/<description>(?:<\!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/description>/i);
    const pubDateMatch = block.match(/<pubDate>(?:<\!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/pubDate>/i);

    const title = cleanHtml((titleMatch && (titleMatch[1] || titleMatch[2])) || '');
    const link = ((linkMatch && (linkMatch[1] || linkMatch[2])) || '').trim();
    const summary = cleanHtml((descMatch && (descMatch[1] || descMatch[2])) || '');
    const pubDate = ((pubDateMatch && (pubDateMatch[1] || pubDateMatch[2])) || '').trim();

    if (title && title.length > 5) {
      const combined = `${title} ${summary}`;
      const stocks = extractStocks(combined);
      
      let category = defaultCategory;
      if (stocks.length > 0) category = 'STOCKS';
      else if (/defence|tejas|hal|bel|mod/i.test(combined)) category = 'DEFENCE';
      else if (/zinc|gold|silver|metal|oil|crude|brent/i.test(combined)) category = 'COMMODITIES';
      else if (/it|tech|ai|nvidia|tcs|infosys/i.test(combined)) category = 'IT SERVICES';
      else if (/policy|gst|rbi|fdi|itr|tax|budget/i.test(combined)) category = 'POLICY';

      items.push({
        title,
        url: link || '#',
        category,
        source: sourceName,
        timeAgo: 'live',
        publishedAt: pubDate || new Date().toISOString(),
        summary: summary || title,
        stocks,
        scrapedAt: new Date().toISOString(),
      });
    }
  }
  return items;
}

// 1. Fetch from Apify Economic Times Actor
async function fetchApifyET() {
  if (!APIFY_TOKEN) return [];
  try {
    const url = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scrapeDuration: '1 week' }),
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return [];
    const items = await resp.json();
    if (!Array.isArray(items)) return [];
    return items.map(it => {
      const combined = `${it.title || ''} ${it.summary || ''}`;
      return {
        title: cleanHtml(it.title || ''),
        url: it.url || '#',
        category: it.category || 'POLICY',
        source: 'Economic Times',
        timeAgo: 'live',
        publishedAt: it.publishedAt || it.scrapedAt || new Date().toISOString(),
        summary: cleanHtml(it.summary || ''),
        stocks: extractStocks(combined),
        scrapedAt: it.scrapedAt || new Date().toISOString(),
      };
    }).filter(it => it.title && it.summary && it.summary !== 'No summary available');
  } catch (err) {
    console.warn('Apify ET fetch warning:', err.message);
    return [];
  }
}

// 2. Fetch from RSS Feeds
async function fetchRss(url, sourceName, defaultCat = 'MARKETS') {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return [];
    const text = await resp.text();
    return parseRssXml(text, sourceName, defaultCat);
  } catch (err) {
    console.warn(`RSS fetch warning for ${sourceName} (${url}):`, err.message);
    return [];
  }
}

async function refreshAllFeeds() {
  try {
    const [apifyEt, etMarkets, mcMarkets, mcBusiness, bsMarkets, bsCompanies] = await Promise.allSettled([
      fetchApifyET(),
      fetchRss('https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'Economic Times', 'MARKETS'),
      fetchRss('https://www.moneycontrol.com/rss/marketreports.xml', 'Moneycontrol', 'MARKETS'),
      fetchRss('https://www.moneycontrol.com/rss/business.xml', 'Moneycontrol', 'STOCKS'),
      fetchRss('https://www.business-standard.com/rss/markets-106.rss', 'Business Standard', 'MARKETS'),
      fetchRss('https://www.business-standard.com/rss/companies-101.rss', 'Business Standard', 'COMPANIES'),
    ]);

    const results = [];
    const seenTitles = new Set();

    function addItems(items) {
      if (!Array.isArray(items)) return;
      for (const it of items) {
        if (!it || !it.title) continue;
        const norm = it.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (norm.length > 10 && !seenTitles.has(norm)) {
          seenTitles.add(norm);
          results.push(it);
        }
      }
    }

    if (apifyEt.status === 'fulfilled') addItems(apifyEt.value);
    if (mcMarkets.status === 'fulfilled') addItems(mcMarkets.value);
    if (bsMarkets.status === 'fulfilled') addItems(bsMarkets.value);
    if (etMarkets.status === 'fulfilled') addItems(etMarkets.value);
    if (mcBusiness.status === 'fulfilled') addItems(mcBusiness.value);
    if (bsCompanies.status === 'fulfilled') addItems(bsCompanies.value);

    cache = {
      data: results,
      fetchedAt: Date.now(),
      error: null,
      refreshing: null,
    };
    return results;
  } catch (err) {
    cache = {
      ...cache,
      error: String(err && err.message ? err.message : err),
      refreshing: null,
    };
    return cache.data || [];
  }
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, count: cache.data ? cache.data.length : 0 }));

app.get('/api/news', async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true' || req.query.refresh === 'true';
  const age = Date.now() - cache.fetchedAt;
  const stale = force || age > CACHE_TTL_MS || !cache.fetchedAt || !cache.data || cache.data.length === 0;

  if (stale) {
    if (!cache.refreshing) cache.refreshing = refreshAllFeeds();
    await cache.refreshing;
  }

  let items = cache.data || [];

  // Filter by Source if requested
  const sourceFilter = req.query.source;
  if (sourceFilter && sourceFilter !== 'all') {
    const sLower = sourceFilter.toLowerCase();
    items = items.filter(it => it.source && it.source.toLowerCase().includes(sLower));
  }

  // Filter by Stock ticker or query if requested
  const stockFilter = req.query.stock || req.query.q;
  if (stockFilter) {
    const term = stockFilter.toLowerCase();
    items = items.filter(it => {
      if (it.stocks && it.stocks.some(s => s.toLowerCase() === term)) return true;
      const combined = `${it.title} ${it.summary} ${it.category}`.toLowerCase();
      return combined.includes(term);
    });
  }

  res.json({
    items,
    fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    ageSeconds: cache.fetchedAt ? Math.round((Date.now() - cache.fetchedAt) / 1000) : null,
    error: cache.error,
    sources: ['Economic Times', 'Moneycontrol', 'Business Standard'],
    total: items.length,
  });
});

// Dedicated stock-specific news endpoint (queries targeted Google News RSS for ET, Moneycontrol & BS for any stock)
app.get('/api/stock-news', async (req, res) => {
  const ticker = req.query.ticker || '';
  const company = req.query.name || '';
  if (!ticker && !company) {
    return res.status(400).json({ error: 'Please provide a ticker or company name' });
  }

  try {
    const query = encodeURIComponent(`${ticker} OR "${company}" (site:economictimes.indiatimes.com OR site:moneycontrol.com OR site:business-standard.com)`);
    const url = `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) {
      throw new Error(`Google News RSS responded with ${resp.status}`);
    }
    const text = await resp.text();
    const items = parseRssXml(text, 'Multi-Source Financial Wire', 'STOCKS');
    
    // Clean and annotate items
    const annotated = items.map(it => {
      let src = 'Economic Times';
      if (/moneycontrol/i.test(it.url) || /moneycontrol/i.test(it.title)) src = 'Moneycontrol';
      else if (/business-standard/i.test(it.url) || /business-standard/i.test(it.title)) src = 'Business Standard';
      else if (/economictimes/i.test(it.url) || /economic times/i.test(it.title)) src = 'Economic Times';
      return {
        ...it,
        source: src,
        stocks: [ticker.toUpperCase()],
      };
    });

    res.json({
      ticker,
      company,
      items: annotated,
      fetchedAt: new Date().toISOString(),
      count: annotated.length,
    });
  } catch (err) {
    res.json({
      ticker,
      company,
      items: [],
      error: String(err && err.message ? err.message : err),
    });
  }
});

app.listen(PORT, () => console.log(`momentwealth-backend listening on port ${PORT}`));
