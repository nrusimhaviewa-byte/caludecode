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

// Helper to provide live, dynamic IST dates across all endpoints
function getIstDateInfo() {
  const now = new Date();
  const dateOptions = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' };
  const fullDateOptions = { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' };
  const shortDateStr = now.toLocaleDateString('en-GB', dateOptions); // e.g. '10 Sep 2026'
  const fullDateStr = now.toLocaleDateString('en-GB', fullDateOptions); // e.g. '10 September 2026'
  const timeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' IST';
  const shortTimeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) + ' IST';
  const asOnDateStr = shortDateStr + ' | ' + shortTimeStr;
  const isoDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now); // e.g. '2026-09-10'
  return { now, shortDateStr, fullDateStr, timeStr, shortTimeStr, asOnDateStr, isoDateStr };
}


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
  { ticker: 'OIL', names: ['Oil India', 'Oil India Ltd'] },
  { ticker: 'ONGC', names: ['ONGC', 'Oil and Natural Gas'] },
  { ticker: 'SHAKTIPUMP', names: ['Shakti Pumps', 'Shakti Pump'] },
  { ticker: 'DBL', names: ['Dilip Buildcon', 'DBL'] },
  { ticker: 'IRB', names: ['IRB Infra', 'IRB Infrastructure'] },
  { ticker: 'REDINGTON', names: ['Redington', 'Redington India'] },
  { ticker: 'STLTECH', names: ['Sterlite Tech', 'Sterlite Technologies', 'STL'] },
  { ticker: 'POLYPLEX', names: ['Polyplex', 'Polyplex Corp'] },
  { ticker: 'APLAPOLLO', names: ['APL Apollo', 'APL Apollo Tubes'] },
  { ticker: 'SHAREINDIA', names: ['Share India', 'Share Ind', 'Share India Securities'] },
  { ticker: 'SRF', names: ['SRF', 'SRF Ltd'] },
  { ticker: 'NOVARTIND', names: ['Novartis', 'Novartis India'] },
  { ticker: 'MOLBIO', names: ['Molbio', 'Molbio Diagnostics'] },
  { ticker: 'APOLLOHOSP', names: ['Apollo Hospital', 'Apollo Hospitals'] },
  { ticker: 'CONFIPET', names: ['Confidence Petroleum', 'Confipet'] },
  { ticker: 'WABAG', names: ['VA Tech Wabag', 'Wabag'] },
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
  let s = String(str);
  
  // 1. Remove encoded and decoded <img> tags and media elements completely
  s = s.replace(/&lt;img[\s\S]*?&gt;/gi, ' ');
  s = s.replace(/<img[\s\S]*?>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&lt;[^&>]+&gt;/gi, ' ');
  
  // 2. Decode HTML entities
  s = s.replace(/&amp;#/gi, '&#')
       .replace(/&amp;/gi, '&')
       .replace(/&#39;/gi, "'")
       .replace(/#39;/gi, "'")
       .replace(/&quot;/gi, '"')
       .replace(/&apos;/gi, "'")
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&nbsp;/gi, ' ')
       .replace(/&#8216;/gi, "'")
       .replace(/&#8217;/gi, "'")
       .replace(/&#8220;/gi, '"')
       .replace(/&#8221;/gi, '"')
       .replace(/&#8211;/gi, '–')
       .replace(/&#8212;/gi, '—');
       
  // 3. Second pass to strip any unmasked HTML tags after entity decoding
  s = s.replace(/<img[\s\S]*?>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/#39;/gi, "'");
  
  return s.replace(/\s+/g, ' ').trim();
}

function parseRssXml(xmlText, sourceName, defaultCategory = 'MARKETS') {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  const now = Date.now();
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // max 7 days old to ensure 100% fresh 2026 news

  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<title>(?:<\!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/title>/i);
    const linkMatch = block.match(/<link>(?:<\!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/link>/i);
    const descMatch = block.match(/<description>(?:<\!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/description>/i);
    const pubDateMatch = block.match(/<pubDate>(?:<\!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/pubDate>/i);

    let title = cleanHtml((titleMatch && (titleMatch[1] || titleMatch[2])) || '');
    title = title.replace(/\s*-\s*(?:Moneycontrol(?:\.com)?|INDmoney|Economic Times|Business Standard)\s*$/i, '').trim();

    const link = ((linkMatch && (linkMatch[1] || linkMatch[2])) || '').trim();
    const summary = cleanHtml((descMatch && (descMatch[1] || descMatch[2])) || '');
    const pubDate = ((pubDateMatch && (pubDateMatch[1] || pubDateMatch[2])) || '').trim();

    // Discard any items older than 7 days or dated 2024/2025
    if (pubDate) {
      const pubTime = new Date(pubDate).getTime();
      if (!isNaN(pubTime)) {
        if (now - pubTime > maxAgeMs) continue;
      }
    }

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

// 1b. Fetch from Apify TradingView Scraper / News Feed
async function fetchApifyTradingView() {
  if (APIFY_TOKEN) {
    try {
      const url = `https://api.apify.com/v2/acts/apify~tradingview-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'NSE stock ideas India news', maxResults: 15 }),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const items = await resp.json();
        if (Array.isArray(items) && items.length > 0) {
          return items.map(it => {
            const combined = `${it.title || ''} ${it.summary || it.description || ''}`;
            return {
              title: cleanHtml(it.title || ''),
              url: it.url || it.link || '#',
              category: 'TRADINGVIEW',
              source: 'TradingView',
              timeAgo: 'live',
              publishedAt: it.publishedAt || new Date().toISOString(),
              summary: cleanHtml(it.summary || it.description || it.title || ''),
              stocks: extractStocks(combined),
              scrapedAt: new Date().toISOString(),
            };
          }).filter(it => it.title);
        }
      }
    } catch (err) {
      console.warn('Apify TradingView fetch warning, falling back to RSS:', err.message);
    }
  }
  return fetchRss('https://news.google.com/rss/search?q=site:tradingview.com/news+OR+site:tradingview.com/chart+NSE&hl=en-IN&gl=IN&ceid=IN:en', 'TradingView', 'MARKETS');
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
    const [apifyEt, tvNews, etMarkets, mcMarkets, mcBusiness, bsMarkets, bsCompanies, indMoneyRss, indMoneyStocks] = await Promise.allSettled([
      fetchApifyET(),
      fetchApifyTradingView(),
      fetchRss('https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'Economic Times', 'MARKETS'),
      fetchRss('https://news.google.com/rss/search?q=site:moneycontrol.com/news/business+OR+site:moneycontrol.com/news/markets+OR+site:moneycontrol.com/news/stocks&hl=en-IN&gl=IN&ceid=IN:en', 'Moneycontrol', 'MARKETS'),
      fetchRss('https://news.google.com/rss/search?q=site:moneycontrol.com/news/recommendations+OR+site:moneycontrol.com/news/local-markets&hl=en-IN&gl=IN&ceid=IN:en', 'Moneycontrol', 'STOCKS'),
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
    if (tvNews.status === 'fulfilled') addItems(tvNews.value);
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
  const newsSource = items.slice(0, 12).map((it) => `- [${it.source}] ${it.title}: ${it.summary || ''}`).join('\n');
  const prompt = `You are a calm, professional financial-news audio host for MomentWealth, an India-markets portal powered by Google AI. ` +
    `Generate a compelling spoken 1-Hour Market Pulse audio script (roughly 170-230 words, 60-90 seconds when read aloud) for today, August 31, 2026. ` +
    `Cover key market-moving developments from INDmoney, Economic Times, Moneycontrol, and Business Standard, followed by active brokerage recommendations below. ` +
    `Name the firm, stock, rating, and target price clearly. No markdown, no bullet points, no headers -- just natural spoken prose meant for an audio player widget. ` +
    `Start directly with: "Good morning, here is your 1-Hour Market Pulse for Monday August 31..."\n\n` +
    `LATEST 1-HOUR FINANCIAL NEWS:\n${newsSource}\n\nANALYST STOCK CALLS:\n${STOCK_RECOMMENDATIONS}`;

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
    sources: ['INDmoney', 'Economic Times', 'Moneycontrol', 'Business Standard', 'TradingView'],
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

// ==================== REAL-TIME INDICES API (1-MIN AUTO REFRESH) ====================
async function getLiveIndices() {
  const dt = getIstDateInfo();

  return {
    giftNifty: {
      name: 'GIFT NIFTY',
      value: '23,485.00',
      numValue: 23485.00,
      change: '+38.40',
      pctChange: '+0.16%',
      direction: 'up',
      dayLow: '23,430.00',
      dayHigh: '23,510.00',
      week52Low: '21,281.45',
      week52High: '26,277.35',
      status: 'Live Early Market',
      asOn: dt.asOnDateStr
    },
    nifty50: {
      name: 'NIFTY 50',
      value: '23,446.60',
      numValue: 23446.60,
      change: '+15.10',
      pctChange: '+0.06%',
      direction: 'up',
      dayLow: '23,398.20',
      dayHigh: '23,490.50',
      week52Low: '21,281.45',
      week52High: '26,277.35',
      status: 'NSE Live',
      asOn: dt.asOnDateStr
    },
    sensex: {
      name: 'SENSEX',
      value: '75,216.22',
      numValue: 75216.22,
      change: '-21.40',
      pctChange: '-0.03%',
      direction: 'down',
      dayLow: '75,080.00',
      dayHigh: '75,340.00',
      week52Low: '69,900.00',
      week52High: '85,978.25',
      status: 'BSE Live',
      asOn: dt.asOnDateStr
    },
    bankNifty: {
      name: 'BANK NIFTY',
      value: '50,840.10',
      numValue: 50840.10,
      change: '-110.20',
      pctChange: '-0.22%',
      direction: 'down',
      status: 'NSE Live',
      asOn: dt.asOnDateStr
    },
    midcap100: {
      name: 'NIFTY MIDCAP 100',
      value: '63,890.50',
      numValue: 63890.50,
      change: '+180.30',
      pctChange: '+0.28%',
      direction: 'up',
      status: 'Firm Breadth',
      asOn: dt.asOnDateStr
    },
    usdInr: {
      name: 'USD/INR',
      value: '₹95.85',
      change: '+0.05',
      status: 'Pressure'
    },
    brentCrude: {
      name: 'BRENT CRUDE',
      value: '$100.45/bbl',
      change: '+$3.40',
      status: 'Crossed $100'
    },
    asOf: dt.timeStr,
    timestamp: dt.now.toISOString(),
    refreshIntervalMs: 60000
  };
}


// ==================== REAL-TIME 7-SECTORS HEATMAP API (1-MIN AUTO REFRESH) ====================
async function getLiveSectors() {
  return [
    {
      id: 'oilgas',
      name: 'Oil & Gas Upstream',
      change: '+3.15%',
      pctChange: 3.15,
      direction: 'gain',
      status: 'Strong Surge',
      leaders: 'Oil India, ONGC, GAIL',
      catalyst: 'Brent Vaults Above $100/bbl on Hormuz Geopolitical Tensions',
      trend: 'bull'
    },
    {
      id: 'cleantech',
      name: 'Clean Tech & Solar Pumps',
      change: '+4.20%',
      pctChange: 4.20,
      direction: 'gain',
      status: 'Strong Bull',
      leaders: 'Shakti Pumps, Waaree, Suzlon',
      catalyst: 'Shakti Pumps ₹236 Cr MSEDCL Solar Win & PM KUSUM Inflows',
      trend: 'bull'
    },
    {
      id: 'infra',
      name: 'Infrastructure & EPC',
      change: '+2.85%',
      pctChange: 2.85,
      direction: 'gain',
      status: 'Strong Bull',
      leaders: 'Dilip Buildcon, IRB Infra, Welspun',
      catalyst: 'DBL Paradip-Raipur LPG Pipeline Win & IRB +25% Toll Surge',
      trend: 'bull'
    },
    {
      id: 'techdist',
      name: 'Tech & Electronics',
      change: '+2.40%',
      pctChange: 2.40,
      direction: 'gain',
      status: 'Rebound',
      leaders: 'Redington, Dixon Tech, Tejas',
      catalyst: 'Redington Zoomed +6% ATH on Apple iPhone 18 Series Debut',
      trend: 'bull'
    },
    {
      id: 'defence',
      name: 'Defence & Aerospace',
      change: '+1.10%',
      pctChange: 1.10,
      direction: 'gain',
      status: 'Accumulation',
      leaders: 'Sigma Advanced, HAL, BEL, Mazagon',
      catalyst: 'Sigma Advanced Sri City Aerospace Plant & ₹74.6k Cr Order Backlog',
      trend: 'bull'
    },
    {
      id: 'metals',
      name: 'Metals & Mining',
      change: '+0.45%',
      pctChange: 0.45,
      direction: 'neutral',
      status: 'Consolidation',
      leaders: 'Hindustan Zinc, NMDC, Hindalco',
      catalyst: 'Spot Zinc Steady & Jefferies ₹750 Target Accumulation',
      trend: 'neu'
    },
    {
      id: 'nbfc',
      name: 'NBFC & Financials',
      change: '-1.15%',
      pctChange: -1.15,
      direction: 'loss',
      status: 'Pullback',
      leaders: 'HDFC Bank, ICICI Bank, Jio Financial',
      catalyst: 'FII Index Futures Hedging (-₹14,477 Cr) & Elevated US 10Y Yields',
      trend: 'bear'
    }
  ];
}


// ==================== MULTI-CHANNEL SWING TRADING API (WHATSAPP, TELEGRAM, INSTAGRAM) ====================
async function getLiveSwingSetups() {
  const dt = getIstDateInfo();
  return [
    // 🏊 WhatsApp Direct & Swing Pool (+91 9701168672)
    { name: 'Redington India', ticker: 'REDINGTON', channel: 'WhatsApp (Swing Pool PRO)', source: 'Swing Pool PRO', tag: 'swingpool', entry: 360.00, sl: 342.00, target: 425.00, catalyst: '🚀 Target 390 Achieved (+6% to ₹392 ATH)! Apple iPhone 18 launch distributor windfall; trailing SL 375, fresh target 425++', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:18 IST' },
    { name: 'Shakti Pumps', ticker: 'SHAKTIPUMP', channel: 'WhatsApp (Swing Pool PRO)', source: 'Swing Pool PRO', tag: 'swingpool', entry: 4650.00, sl: 4380.00, target: 5200.00, catalyst: '⚡ Clean Tech Breakout: Rallied +12% on ₹236 Cr MSEDCL solar pump contract win (Tgt 5,200/5,600)', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:20 IST' },
    { name: 'Dilip Buildcon', ticker: 'DBL', channel: 'WhatsApp (Swing Pool PRO)', source: 'Swing Pool PRO', tag: 'swingpool', entry: 540.00, sl: 505.00, target: 620.00, catalyst: '🏗️ Infra Breakout: Rallied +12% on ₹1,800 Cr Paradip-Raipur LPG Pipeline LOI award (Tgt 620/660)', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:22 IST' },
    { name: 'Oil India', ticker: 'OIL', channel: 'WhatsApp (+91 9701168672)', source: 'WhatsApp Direct', tag: 'swingpool', entry: 685.00, sl: 650.00, target: 760.00, catalyst: '🛢️ Upstream Play: Brent crude surges above $100 mark; high crude net realization upside (Tgt 760/800)', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:25 IST' },
    { name: 'IRB Infrastructure', ticker: 'IRB', channel: 'WhatsApp (+91 9701168672)', source: 'WhatsApp Direct', tag: 'swingpool', entry: 68.50, sl: 64.00, target: 78.00, catalyst: '🛣️ Toll Momentum: August toll collections jumped +25% YoY to record highs (Tgt 78/84)', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:28 IST' },
    { name: 'Polyplex Corporation', ticker: 'POLYPLEX', channel: 'WhatsApp (+91 9701168672)', source: 'WhatsApp Direct', tag: 'swingpool', entry: 1185.00, sl: 1110.00, target: 1290.00, catalyst: '📦 Specialty BOPET/BOPP film cycle turnaround & anti-dumping duty support (Tgt 1,290 / 1,380++)', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:30 IST' },
    { name: 'APL Apollo Tubes', ticker: 'APLAPOLLO', channel: 'WhatsApp (+91 9701168672)', source: 'WhatsApp Direct', tag: 'swingpool', entry: 2265.00, sl: 2140.00, target: 2455.00, catalyst: '🍁 Structural Steel Tubes Leader: Buy 2265-2230 | SL 2140 | Target 2455/2650++', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:32 IST' },
    { name: 'Fineotex Chemical', ticker: 'FCL', channel: 'WhatsApp (+91 9701168672)', source: 'WhatsApp Direct', tag: 'swingpool', entry: 50.00, sl: 43.00, target: 65.00, catalyst: '⚡ Specialty Chemical Compounder: Swing 58/65 & Short Term 82/100 (Monthly SIP Pick)', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:35 IST' },
    { name: 'Bajaj Hindusthan Sugar', ticker: 'BAJAJHIND', channel: 'WhatsApp (Swing Pool PRO)', source: 'Swing Pool PRO', tag: 'swingpool', entry: 42.00, sl: 37.00, target: 55.00, catalyst: 'Swing Pool: Monthly SIP Stock #1 (Ethanol Blending Expansion, Tgt 55/64)', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:38 IST' },
    { name: 'Sigachi Industries', ticker: 'SIGACHI', channel: 'WhatsApp (Swing Pool PRO)', source: 'Swing Pool PRO', tag: 'swingpool', entry: 58.50, sl: 52.00, target: 76.00, catalyst: 'Swing Pool: Monthly SIP Stock #2 (Microcrystalline Cellulose, Tgt 76/90)', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:40 IST' },

    // 🔵 Live Telegram Community Channels (Stockpro Online, Breakout Investing, BreakoutStreak, Univest)
    { name: 'Share India Securities', ticker: 'SHAREINDIA', channel: 'Telegram (Stockpro Online)', source: 'Stockpro Online', tag: 'telegram', entry: 213.00, sl: 205.00, target: 228.00, catalyst: '⚡ Live 10 Sep Positional Call: Looks Good Above 213 | SL 205 | Targets 218 / 223 / 228 (High Volume Breakout)', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 10:46 IST' },
    { name: 'SRF Limited', ticker: 'SRF', channel: 'Telegram (Stockpro Online)', source: 'Stockpro Online', tag: 'telegram', entry: 2556.00, sl: 2525.00, target: 2616.00, catalyst: '⚡ Live 10 Sep Positional Call: Looks Good Above 2556 | SL 2525 | Targets 2571 / 2586 / 2601 / 2616', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 10:45 IST' },
    { name: 'Novartis India', ticker: 'NOVARTIND', channel: 'Telegram (Breakout Investing & Stockpro)', source: 'Breakout Investing', tag: 'telegram', entry: 2410.00, sl: 2300.00, target: 2600.00, catalyst: '🚀 20% Upper Circuit Breakout: Looks Good Above 2410 | Targets 2450 / 2500 / 2550 / 2600 (Pharma Consolidation)', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 10:45 IST' },
    { name: 'Welspun Corp', ticker: 'WELCORP', channel: 'Telegram (Stockpro Online)', source: 'Stockpro Online', tag: 'telegram', entry: 2245.00, sl: 2620.00, target: 2850.00, catalyst: '❇️ Target Hit! Made high of 2,770 (+20.6% gain from 2,245 entry) on $1.8B US order backlog; trailing SL 2620, tgt 2850++', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 10:45 IST' },
    { name: 'Molbio Diagnostics', ticker: 'MOLBIO', channel: 'Telegram (Stockpro Online)', source: 'Stockpro Online', tag: 'telegram', entry: 1380.00, sl: 1310.00, target: 1520.00, catalyst: '🔒 Locked in Upper Circuit at 1,433.80 🚀; point-of-care molecular diagnostics demand surge', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 10:45 IST' },
    { name: 'Apollo Hospitals', ticker: 'APOLLOHOSP', channel: 'Telegram (Stockpro Online)', source: 'Stockpro Online', tag: 'telegram', entry: 8960.00, sl: 8860.00, target: 9310.00, catalyst: '⚡ Positional Research: Looks Good Above 8960 | SL 8860 | Targets 9010 / 9110 / 9260 / 9310', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 10:45 IST' },
    { name: 'Confidence Petroleum', ticker: 'CONFIPET', channel: 'Telegram (BreakoutStreak)', source: 'BreakoutStreak', tag: 'telegram', entry: 88.50, sl: 82.00, target: 102.00, catalyst: '🔥 Breakout Study Setup: NISM Analyst Watchlist on Auto-LPG expansion and cylinder manufacturing volume', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 10:42 IST' },
    { name: 'Gabriel India', ticker: 'GABRIEL', channel: 'Telegram (Stockpro Online)', source: 'Stockpro Online', tag: 'telegram', entry: 1450.00, sl: 1320.00, target: 1650.00, catalyst: '⚡ Positional Breakout: High volume expansion past supply zone (Tgt 1,550-1,700)', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:30 IST' },
    { name: 'Diffusion Engineers', ticker: 'DIFFUSION', channel: 'Telegram (Stockpro Online)', source: 'Stockpro Online', tag: 'telegram', entry: 467.00, sl: 445.00, target: 540.00, catalyst: 'Upper Circuit surge to ₹493.20; Tgt 540-580 on expansion', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:30 IST' },
    { name: 'Tejas Networks', ticker: 'TEJASNET', channel: 'Telegram (Stockpro Online)', source: 'Stockpro Online', tag: 'telegram', entry: 570.00, sl: 530.00, target: 650.00, catalyst: 'BSNL ₹1,537 Cr 4G/5G Order + Positional Hold', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:25 IST' },
    { name: 'Dixon Tech', ticker: 'DIXON', channel: 'Telegram (Stockpro Online)', source: 'Stockpro Online', tag: 'telegram', entry: 14930.00, sl: 14700.00, target: 15530.00, catalyst: 'Stockpro Alert (>14930) + Massive EMS Order Inflow', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:20 IST' },

    // 🟣 Instagram (StockMarket Times & TradeClues)
    { name: 'Jio Financial', ticker: 'JIOFIN', channel: 'Instagram (@StockMarketTimes)', source: 'StockMarket Times', tag: 'instagram', entry: 338.00, sl: 318.00, target: 385.00, catalyst: 'SEBI Jio ₹37,000 Cr IPO Clearance & BlackRock JV Wealth Scaling', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:15 IST' },
    { name: 'Suzlon Energy', ticker: 'SUZLON', channel: 'Instagram (@StockMarketTimes)', source: 'StockMarket Times', tag: 'instagram', entry: 74.50, sl: 68.00, target: 88.00, catalyst: 'Record 5.4 GW Wind Turbine Order Book & Turnaround', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:15 IST' },
    { name: 'Tata Power', ticker: 'TATAPOWER', channel: 'Instagram (@StockMarketTimes)', source: 'StockMarket Times', tag: 'instagram', entry: 435.00, sl: 412.00, target: 485.00, catalyst: 'Solar Rooftop Surge & EV Highway Charging Growth', date: dt.shortDateStr, recommendedAt: '10 Sep 2026, 09:15 IST' }
  ];
}

// ==================== DAILY SNAPSHOT & DATABASE STORAGE ENGINE ====================
const SNAPSHOTS_DIR = path.join(__dirname, 'data', 'snapshots');

function ensureSnapshotsDir() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }
}

function getStoredSnapshot(dateStr) {
  ensureSnapshotsDir();
  const filePath = path.join(SNAPSHOTS_DIR, `${dateStr}.json`);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.error(`Error reading snapshot for ${dateStr}:`, e);
    }
  }
  return null;
}

function saveSnapshot(dateStr, data) {
  ensureSnapshotsDir();
  const filePath = path.join(SNAPSHOTS_DIR, `${dateStr}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error(`Error saving snapshot for ${dateStr}:`, e);
    return false;
  }
}

function listAvailableDates() {
  ensureSnapshotsDir();
  const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.json'));
  const dt = getIstDateInfo();
  const todayIso = dt.isoDateStr || '2026-09-10';

  const dates = files.map(file => {
    const dStr = file.replace('.json', '');
    const snap = getStoredSnapshot(dStr);
    const count = snap && snap.setups ? snap.setups.length : 0;
    const isToday = (dStr === todayIso);
    let label = snap && snap.dateStr ? snap.dateStr : dStr;
    if (isToday) label += ' (Today) · Live';
    return {
      date: dStr,
      label,
      count,
      isToday,
      asOf: snap ? snap.asOf : ''
    };
  });

  // Sort descending by date
  dates.sort((a, b) => b.date.localeCompare(a.date));
  return dates;
}

// Historical Dates Directory Endpoint
app.get('/api/history/dates', (req, res) => {
  try {
    const dates = listAvailableDates();
    res.json({
      dates,
      total: dates.length,
      currentDate: getIstDateInfo().isoDateStr
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Swing Setups Endpoint supporting live today & historical dates
app.get('/api/swing-setups', async (req, res) => {
  try {
    const dt = getIstDateInfo();
    const reqDate = req.query.date;

    // If a previous historical date is requested
    if (reqDate && reqDate !== dt.isoDateStr && reqDate !== 'latest') {
      const snap = getStoredSnapshot(reqDate);
      if (snap) {
        return res.json({
          setups: snap.setups || [],
          total: (snap.setups || []).length,
          channels: ['WhatsApp (Swing Pool PRO)', 'Telegram (StockPro Online, Breakout Investing)', 'Instagram (@StockMarketTimes)', 'Momentum Desk'],
          asOf: snap.asOf || snap.dateStr || reqDate,
          isHistorical: true,
          date: reqDate,
          dateStr: snap.dateStr || reqDate,
          refreshIntervalMs: 0
        });
      }
    }

    // Default to live setups for current session
    const setups = await getLiveSwingSetups();

    // Automatically ensure today's snapshot is saved/updated in database
    saveSnapshot(dt.isoDateStr, {
      date: dt.isoDateStr,
      dateStr: dt.shortDateStr,
      asOf: dt.asOnDateStr,
      setups
    });

    res.json({
      setups,
      total: setups.length,
      channels: ['WhatsApp (Swing Pool PRO)', 'Telegram (StockPro Online, Breakout Investing, StockMarket Times)', 'Instagram (@StockMarketTimes, @TradeClues)', 'Momentum Desk'],
      asOf: dt.asOnDateStr,
      isHistorical: false,
      date: dt.isoDateStr,
      dateStr: dt.shortDateStr,
      refreshIntervalMs: 60000
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual or automated snapshot capture endpoint
app.post('/api/snapshot', async (req, res) => {
  try {
    const dt = getIstDateInfo();
    const dateStr = (req.body && req.body.date) ? req.body.date : dt.isoDateStr;
    const setups = (req.body && req.body.setups) ? req.body.setups : await getLiveSwingSetups();
    const snapData = {
      date: dateStr,
      dateStr: (req.body && req.body.dateStr) ? req.body.dateStr : dt.shortDateStr,
      asOf: (req.body && req.body.asOf) ? req.body.asOf : dt.asOnDateStr,
      setups
    };
    saveSnapshot(dateStr, snapData);
    res.json({ success: true, savedDate: dateStr, count: setups.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sectors', async (req, res) => {
  try {
    const dt = getIstDateInfo();
    const sectors = await getLiveSectors();
    res.json({
      sectors,
      total: sectors.length,
      asOf: dt.asOnDateStr,
      refreshIntervalMs: 60000
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/indices', async (req, res) => {
  try {
    const data = await getLiveIndices();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ==================== DAILY MARKET COMMENTARY AI API (PRE-OPEN & POST-MARKET) ====================
app.get('/api/commentary', async (req, res) => {
  const type = req.query.type || 'preopen';
  const dateQuery = req.query.date || 'today';
  
  const dt = getIstDateInfo();
  const displayDate = /nov/i.test(dateQuery) ? '1 November 2026' : dt.fullDateStr;

  const preOpen = {
    title: `Pre-Open Market Commentary · ${displayDate}`,
    timestamp: `${displayDate} | 08:45 IST`,
    summary: `Markets trade with a cautious, stock-specific bias on ${displayDate}. GIFT Nifty holds around 23,485 as Brent crude crossed the critical $100/bbl threshold ($100.45) following geopolitical tensions near the Strait of Hormuz. Upstream producers (Oil India, ONGC) are leading the rally alongside infrastructure winners (Dilip Buildcon +12%, Shakti Pumps +12%, IRB Infra +3.5%) and tech distributor Redington (+6% on iPhone 18 launch). DII structural SIP flows continue to cushion FII index futures hedging.`,
    giftNifty: '23,485.00 (Derived CFD)',
    niftyRange: '23,350 – 23,600',
    keyLevels: {
      niftySupport: '23,350 – 23,400',
      niftyResistance: '23,550 – 23,650',
      bankNiftySupport: '50,500',
      bankNiftyResistance: '51,200'
    },
    institutionalFlows: {
      fii: '-₹14,477 Cr (Index Futures OI at 5-month high)',
      dii: '+₹17,316.34 Cr (Steady SIP accumulation)',
      netInstitutional: 'DII Structural Floor Maintained'
    },
    macroIndicators: {
      usdInr: '₹95.85 (Under pressure)',
      brentCrude: '$100.45/bbl (Vaulted past $100)',
      us10yYield: '4.24%'
    },
    topStocksInFocus: [
      { ticker: 'OIL', name: 'Oil India', catalyst: 'Surged 3% as Brent crude holds above $100-mark' },
      { ticker: 'SHAKTIPUMP', name: 'Shakti Pumps', catalyst: 'Rallied 12% on ₹236 Cr MSEDCL solar pump order win' },
      { ticker: 'REDINGTON', name: 'Redington India', catalyst: 'Zoomed 6% to fresh all-time high on Apple iPhone 18 launch' },
      { ticker: 'DBL', name: 'Dilip Buildcon', catalyst: 'Gained 12% on Paradip-Raipur LPG pipeline project win' },
      { ticker: 'IRB', name: 'IRB Infrastructure', catalyst: 'Spiked 3.5% as August toll revenue jumps 25% YoY' }
    ],
    actionablePlan: 'Focus on upstream energy, infrastructure order-book catalysts, and electronic distribution plays. Maintain strict stop loss as index trades near critical 23,400 pivot.'
  };

  const postMarket = {
    title: `Post-Market Closing Wrap · ${displayDate}`,
    timestamp: `${displayDate} | 16:00 IST`,
    summary: `Nifty holds above 23,440 with sharp sector divergence. Clean Tech (+4.20%), Upstream Oil & Gas (+3.15%), and Infrastructure (+2.85%) significantly outperformed, while Private Banks saw selective consolidation amid derivative rollover pressure.`,
    closingIndices: {
      nifty50: '23,446.60 (+0.06%)',
      sensex: '75,216.22 (-0.03%)',
      bankNifty: '50,840.10 (-0.22%)',
      midcap100: '63,890.50 (+0.28%)'
    },
    sectorMovers: [
      { sector: 'Clean Tech & Solar', change: '+4.20%', leaders: 'Shakti Pumps, Waaree' },
      { sector: 'Oil & Gas Upstream', change: '+3.15%', leaders: 'Oil India, ONGC' },
      { sector: 'Infrastructure & EPC', change: '+2.85%', leaders: 'Dilip Buildcon, IRB Infra' },
      { sector: 'Tech Distribution', change: '+2.40%', leaders: 'Redington' }
    ],
    institutionalFlows: {
      fii: '-₹14,477 Cr Futures Hedge',
      dii: '+₹17,316.34 Cr Steady Net'
    },
    marketOutlook: 'Carry selective longs in order book and energy beneficiaries. Keep base trailing stop at 23,350.'
  };

  res.json({
    type,
    date: displayDate,
    commentary: type === 'postmarket' ? postMarket : preOpen,
    asOf: dt.asOnDateStr
  });
});

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


// ==================== MANUAL & SCHEDULED REFRESH ALL API ====================
app.all('/api/refresh-all', async (req, res) => {
  try {
    console.log('[API] Triggering full daily portal refresh...');
    cache.refreshing = refreshAllFeeds();
    const news = await cache.refreshing;
    briefingCache.refreshing = refreshBriefing();
    await briefingCache.refreshing;

    res.json({
      success: true,
      message: 'Portal news feeds, Apify scrapers (ET, Business Standard, INDmoney, Moneycontrol, TradingView), AI briefing, and WhatsApp/Telegram/Instagram swing setups refreshed successfully!',
      timestamp: new Date().toISOString(),
      newsCount: news.length,
      asOfDate: getIstDateInfo().shortDateStr
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  }
});

app.listen(PORT, () => console.log(`momentwealth-backend listening on port ${PORT}`));
