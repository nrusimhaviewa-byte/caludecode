import express from 'express';

const app = express();
const PORT = process.env.PORT || 8080;
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const ACTOR_ID = process.env.APIFY_ACTOR_ID || 'mrE0hmRF359AXBWtl';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15 * 60 * 1000); // 15 mins
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const GCP_PROJECT = process.env.GCP_PROJECT || 'protean-fabric-467500-a5';
const VERTEX_REGION = process.env.VERTEX_REGION || 'us-central1';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TTS_VOICE = process.env.TTS_VOICE || 'en-IN-Neural2-A';
const BRIEFING_TTL_MS = Number(process.env.BRIEFING_TTL_MS || 30 * 60 * 1000);

let cache = { data: [], fetchedAt: 0, error: null, refreshing: null };
let briefingCache = { text: null, audioBase64: null, fetchedAt: 0, error: null, refreshing: null };

async function getAccessToken() {
  const resp = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!resp.ok) throw new Error(`Metadata token fetch failed: ${resp.status}`);
  const json = await resp.json();
  return json.access_token;
}

// Known Indian Stock Tickers & Companies Map for automatic tagging
const STOCK_PATTERNS = [
  { ticker: 'HAL', names: ['HAL', 'Hindustan Aeronautics'] },
  { ticker: 'HINDZINC', names: ['Hindustan Zinc', 'Hind Zinc', 'HZL'] },
  { ticker: 'WELSPUN', names: ['Welspun', 'Welspun Corp'] },
  { ticker: 'TCS', names: ['TCS', 'Tata Consultancy'] },
  { ticker: 'RELIANCE', names: ['Reliance', 'RIL', 'Jio Financial'] },
  { ticker: 'ZOMATO', names: ['Zomato', 'Blinkit'] },
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
  { ticker: 'KPITTECH', names: ['KPIT', 'KPIT Tech', 'KPIT Technologies'] },
  { ticker: 'JUSTDIAL', names: ['Just Dial', 'Justdial'] },
  { ticker: 'TEJASNET', names: ['Tejas Networks', 'Tejas'] },
  { ticker: 'ATHER', names: ['Ather Energy', 'Ather'] },
  { ticker: 'LENSKART', names: ['Lenskart'] },
  { ticker: 'OLAELEC', names: ['Ola Electric', 'Ola'] },
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
    const [apifyEt, etMarkets, mcMarkets, mcBusiness, bsMarkets, bsCompanies, indMoneyRss, indMoneyStocks] = await Promise.allSettled([
      fetchApifyET(),
      fetchRss('https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'Economic Times', 'MARKETS'),
      fetchRss('https://www.moneycontrol.com/rss/marketreports.xml', 'Moneycontrol', 'MARKETS'),
      fetchRss('https://www.moneycontrol.com/rss/business.xml', 'Moneycontrol', 'STOCKS'),
      fetchRss('https://www.business-standard.com/rss/markets-106.rss', 'Business Standard', 'MARKETS'),
      fetchRss('https://www.business-standard.com/rss/companies-101.rss', 'Business Standard', 'COMPANIES'),
      fetchRss('https://news.google.com/rss/search?q=site:indmoney.com/articles+stocks+OR+market&hl=en-IN&gl=IN&ceid=IN:en', 'INDmoney', 'STOCKS'),
      fetchRss('https://news.google.com/rss/search?q=site:indmoney.com/blog/stocks&hl=en-IN&gl=IN&ceid=IN:en', 'INDmoney', 'STOCKS'),
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
    if (indMoneyRss.status === 'fulfilled') addItems(indMoneyRss.value);
    if (indMoneyStocks.status === 'fulfilled') addItems(indMoneyStocks.value);
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

// Curated multi-firm analyst calls behind the momentum watchlist on the page
// (docs/momentwealth.html, "Momentum watchlist for next week" section) --
// kept in sync by hand alongside that section, not independently sourced here.
const STOCK_RECOMMENDATIONS = [
  'Nuvama Institutional Equities: Welspun Corp, BUY, target Rs 2,656, after the company\'s record $1.8 billion US pipe order lifted FY27-29 EPS estimates 3 to 20 percent.',
  'Jefferies: Hindustan Zinc, BUY, target raised to Rs 750 from Rs 660, on firm zinc and silver prices lifting FY27-29 EPS estimates 10 to 11 percent.',
  'HDFC Securities: Bharat Electronics, Add, target Rs 490; Mazagon Dock Shipbuilders, Add, target Rs 2,950; part of an eight-stock defence coverage initiation.',
  'Ashika Institutional Research: turned broadly bullish on the whole defence pack -- HAL, BEL, Mazagon Dock -- on a "global rearmament" theme as order books lengthen.',
].join('\n');

async function summarizeForVoice(items, token) {
  const newsSource = items.slice(0, 10).map((it) => `- ${it.title}: ${it.summary || ''}`).join('\n');
  const prompt = `You are a calm financial-news narrator for an India-markets portal. ` +
    `Turn this into a natural, spoken-style briefing script of about 60-90 seconds when read aloud ` +
    `(roughly 160-220 words), covering two segments in order: first the day's policy/markets headlines, ` +
    `then a "here's what brokerages are saying" segment covering the analyst stock calls below, naming the ` +
    `firm, the stock, the rating, and the target price for each. No markdown, no bullet points, no headers -- ` +
    `just plain prose someone would speak out loud, in a natural conversational flow, grouping related items ` +
    `and skipping anything trivial. Start directly with the content, no "here is your briefing" preamble.\n\n` +
    `POLICY & MARKETS NEWS:\n${newsSource}\n\nANALYST STOCK CALLS:\n${STOCK_RECOMMENDATIONS}`;

  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
  });
  if (!resp.ok) throw new Error(`Vertex AI generateContent failed: ${resp.status} ${await resp.text()}`);
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) throw new Error('Vertex AI returned no text');
  return text.trim();
}

async function synthesizeSpeech(text, token) {
  const resp = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'en-IN', name: TTS_VOICE },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
    }),
  });
  if (!resp.ok) throw new Error(`Text-to-Speech synthesize failed: ${resp.status} ${await resp.text()}`);
  const json = await resp.json();
  if (!json.audioContent) throw new Error('Text-to-Speech returned no audio');
  return json.audioContent; // base64 MP3
}

async function refreshBriefing() {
  try {
    if (!cache.data || cache.data.length === 0) {
      if (!cache.refreshing) cache.refreshing = refreshAllFeeds();
      await cache.refreshing;
    }
    const items = cache.data || [];
    if (items.length === 0) throw new Error('No news items available to summarize');
    const token = await getAccessToken();
    const text = await summarizeForVoice(items, token);
    const audioBase64 = await synthesizeSpeech(text, token);
    briefingCache = { text, audioBase64, fetchedAt: Date.now(), error: null, refreshing: null };
  } catch (err) {
    briefingCache = { ...briefingCache, error: String(err && err.message ? err.message : err), refreshing: null };
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
    sources: ['INDmoney', 'Economic Times', 'Moneycontrol', 'Business Standard'],
    total: items.length,
  });
});

app.get('/api/briefing', async (req, res) => {
  const age = Date.now() - briefingCache.fetchedAt;
  const stale = age > BRIEFING_TTL_MS || !briefingCache.fetchedAt;
  if (stale) {
    if (!briefingCache.refreshing) briefingCache.refreshing = refreshBriefing();
    await briefingCache.refreshing;
  }
  res.json({
    text: briefingCache.text,
    audioBase64: briefingCache.audioBase64,
    fetchedAt: briefingCache.fetchedAt ? new Date(briefingCache.fetchedAt).toISOString() : null,
    error: briefingCache.error,
  });
});

// Dedicated stock-specific news endpoint (queries targeted Google News RSS for INDmoney, ET, Moneycontrol & BS for any stock)
app.get('/api/stock-news', async (req, res) => {
  const ticker = req.query.ticker || '';
  const company = req.query.name || '';
  if (!ticker && !company) {
    return res.status(400).json({ error: 'Please provide a ticker or company name' });
  }

  try {
    const query = encodeURIComponent(`${ticker} OR "${company}" (site:indmoney.com OR site:economictimes.indiatimes.com OR site:moneycontrol.com OR site:business-standard.com)`);
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
      if (/indmoney/i.test(it.url) || /indmoney/i.test(it.title)) src = 'INDmoney';
      else if (/moneycontrol/i.test(it.url) || /moneycontrol/i.test(it.title)) src = 'Moneycontrol';
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
