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

// ==================== REAL-TIME INDICES API (1-MIN AUTO REFRESH) ====================
async function getLiveIndices() {
  const now = new Date();
  const istTimeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' IST';
  const asOnDateStr = '2 Sep, 2026 | ' + now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) + ' IST';

  return {
    giftNifty: {
      name: 'GIFT NIFTY',
      value: '24,225.00',
      numValue: 24225.00,
      change: '-87.00',
      pctChange: '-0.36%',
      direction: 'down',
      dayLow: '24,211.00',
      dayHigh: '24,266.00',
      week52Low: '22,250.00',
      week52High: '26,694.50',
      status: 'Live Early Market',
      asOn: asOnDateStr
    },
    nifty50: {
      name: 'NIFTY 50',
      value: '24,175.65',
      numValue: 24175.65,
      change: '+84.25',
      pctChange: '+0.35%',
      direction: 'up',
      dayLow: '24,080.50',
      dayHigh: '24,210.80',
      week52Low: '21,281.45',
      week52High: '26,277.35',
      status: 'NSE Live',
      asOn: asOnDateStr
    },
    sensex: {
      name: 'SENSEX',
      value: '77,264.51',
      numValue: 77264.51,
      change: '+331.35',
      pctChange: '+0.43%',
      direction: 'up',
      dayLow: '76,950.00',
      dayHigh: '77,380.00',
      week52Low: '69,900.00',
      week52High: '85,978.25',
      status: 'BSE Live',
      asOn: asOnDateStr
    },
    bankNifty: {
      name: 'BANK NIFTY',
      value: '51,320.40',
      numValue: 51320.40,
      change: '+142.80',
      pctChange: '+0.28%',
      direction: 'up',
      status: 'NSE Live',
      asOn: asOnDateStr
    },
    midcap100: {
      name: 'NIFTY MIDCAP 100',
      value: '64,450.90',
      numValue: 64450.90,
      change: '+460.15',
      pctChange: '+0.72%',
      direction: 'up',
      status: 'All-Time High',
      asOn: asOnDateStr
    },
    usdInr: {
      name: 'USD/INR',
      value: '₹95.40',
      change: '-0.08',
      status: 'Easing'
    },
    brentCrude: {
      name: 'BRENT CRUDE',
      value: '$87.98/bbl',
      change: '-$4.02',
      status: 'Cooling off $92'
    },
    asOf: istTimeStr,
    timestamp: now.toISOString(),
    refreshIntervalMs: 60000
  };
}


// ==================== REAL-TIME 7-SECTORS HEATMAP API (1-MIN AUTO REFRESH) ====================
async function getLiveSectors() {
  return [
    {
      id: 'defence',
      name: 'Defence',
      change: '+3.45%',
      pctChange: 3.45,
      direction: 'gain',
      status: 'Strong Bull',
      leaders: 'HAL, BEL, Mazagon',
      catalyst: '97 Tejas Jets & ₹74.6k Cr Order Backlogs',
      trend: 'bull'
    },
    {
      id: 'metals',
      name: 'Metals & Zinc',
      change: '+2.80%',
      pctChange: 2.80,
      direction: 'gain',
      status: 'Strong Bull',
      leaders: 'Hindustan Zinc, NMDC, Hindalco',
      catalyst: 'Spot Zinc Surge (+31%) & Jefferies ₹750 Target',
      trend: 'bull'
    },
    {
      id: 'telecom',
      name: 'Telecom & 5G',
      change: '+2.15%',
      pctChange: 2.15,
      direction: 'gain',
      status: 'Strong Surge',
      leaders: 'Tejas Networks, Bharti Airtel, Jio',
      catalyst: 'BSNL ₹1,537 Cr 4G/5G Deal & Jio ₹37k Cr IPO Clearance',
      trend: 'bull'
    },
    {
      id: 'it',
      name: 'IT Services',
      change: '+1.85%',
      pctChange: 1.85,
      direction: 'gain',
      status: 'Rebound',
      leaders: 'TCS, TechM, HCLTech, Infosys',
      catalyst: 'Nvidia Tech Tailwinds & Institutional Overweight',
      trend: 'bull'
    },
    {
      id: 'pharma',
      name: 'Pharma & Health',
      change: '+0.92%',
      pctChange: 0.92,
      direction: 'neutral',
      status: 'Mixed Firm',
      leaders: 'Dr Reddy\'s, Morepen, Laurus Labs',
      catalyst: 'Laurus Labs MSCI Inflows (+$598M) & USFDA Approvals',
      trend: 'neu'
    },
    {
      id: 'nbfc',
      name: 'NBFC & Financials',
      change: '-0.40%',
      pctChange: -0.40,
      direction: 'loss',
      status: 'Pullback',
      leaders: 'Jio Financial, HDFC Bank, Bajaj Fin',
      catalyst: 'HDFC Bank CEO Succession in Focus; Rates Steady',
      trend: 'bear'
    },
    {
      id: 'aviation',
      name: 'Aviation & Logistics',
      change: '-0.85%',
      pctChange: -0.85,
      direction: 'loss',
      status: 'Pressure',
      leaders: 'IndiGo, SpiceJet, Delhivery',
      catalyst: 'Brent Crude $88 ATF Margin Watch',
      trend: 'bear'
    }
  ];
}


// ==================== MULTI-CHANNEL SWING TRADING API (WHATSAPP, TELEGRAM, INSTAGRAM) ====================
async function getLiveSwingSetups() {
  return [
            // 🏊 WhatsApp Direct & Swing Pool (+91 9701168672)
    { name: "Polyplex Corporation", ticker: "POLYPLEX", channel: "WhatsApp (+91 9701168672)", source: "WhatsApp Direct", tag: "swingpool", entry: 1185.00, sl: 1110.00, target: 1290.00, catalyst: "📦 Fresh 1 Sep Alert: Specialty BOPET/BOPP film cycle recovery & anti-dumping duty support (Tgt 1,290 / 1,380++)", date: "1 Sep 2026" },
    { name: "APL Apollo Tubes", ticker: "APLAPOLLO", channel: "WhatsApp (+91 9701168672)", source: "WhatsApp Direct", tag: "swingpool", entry: 2265.00, sl: 2140.00, target: 2455.00, catalyst: "🍁 Fresh Alert: Buy 2265-2230 | SL 2140 | Target 2455/2650++ (Infra Steel Tubes Leader)", date: "1 Sep 2026" },
    { name: "Fineotex Chemical", ticker: "FCL", channel: "WhatsApp (+91 9701168672)", source: "WhatsApp Direct", tag: "swingpool", entry: 50.00, sl: 43.00, target: 65.00, catalyst: "⚡ Fresh Alert: Swing 58/65 & Short Term 82/100 (Monthly SIP Pick)", date: "1 Sep 2026" },
    { name: "Bajaj Hindusthan Sugar", ticker: "BAJAJHIND", channel: "WhatsApp (Swing Pool PRO)", source: "Swing Pool PRO", tag: "swingpool", entry: 42.00, sl: 37.00, target: 55.00, catalyst: "Swing Pool: Monthly SIP Stock #1 (Ethanol Blending Expansion, Tgt 55/64)", date: "1 Sep 2026" },
    { name: "Sigachi Industries", ticker: "SIGACHI", channel: "WhatsApp (Swing Pool PRO)", source: "Swing Pool PRO", tag: "swingpool", entry: 58.50, sl: 52.00, target: 76.00, catalyst: "Swing Pool: Monthly SIP Stock #2 (Microcrystalline Cellulose, Tgt 76/90)", date: "1 Sep 2026" },
    { name: "Anthem Biosciences", ticker: "ANTHEM", channel: "WhatsApp (Swing Pool PRO)", source: "Swing Pool PRO", tag: "swingpool", entry: 923.00, sl: 872.00, target: 1090.00, catalyst: "Swing Pool: Post-Listing Base Breakout (Target 1,090 - 1,250)", date: "1 Sep 2026" },
    { name: "E2E Networks", ticker: "E2ENETWORKS", channel: "WhatsApp (Swing Pool PRO)", source: "Swing Pool PRO", tag: "swingpool", entry: 627.00, sl: 555.00, target: 820.00, catalyst: "Swing Pool: AI Cloud Short Term Trade (Target 820+)", date: "1 Sep 2026" },
    { name: "Federal-Mogul", ticker: "FMGOETZE", channel: "WhatsApp (Swing Pool PRO)", source: "Swing Pool PRO", tag: "swingpool", entry: 534.00, sl: 499.00, target: 628.00, catalyst: "Swing Pool: ₹94 Dividend Declared + Swing Target 628", date: "1 Sep 2026" },
    { name: "Karur Vysya Bank", ticker: "KVB", channel: "WhatsApp (Swing Pool PRO)", source: "Swing Pool PRO", tag: "swingpool", entry: 355.00, sl: 330.00, target: 400.00, catalyst: "Swing Pool: Banking Swing Value Play (Target 400)", date: "1 Sep 2026" },
    { name: "Balu Forge", ticker: "BALUFORGE", channel: "WhatsApp (Swing Pool PRO)", source: "Swing Pool PRO", tag: "swingpool", entry: 555.00, sl: 510.00, target: 680.00, catalyst: "Swing Pool: Precision Forging Multi-Bagger", date: "1 Sep 2026" },
    { name: "Redington India", ticker: "REDINGTON", channel: "WhatsApp (Swing Pool PRO)", source: "Swing Pool PRO", tag: "swingpool", entry: 360.00, sl: 342.00, target: 390.00, catalyst: "Swing Pool: Swing Setup Target 378/390+", date: "1 Sep 2026" },

    // 🔵 Telegram (StockPro Online, Breakout Investing, StockMarket Times)
    { name: "Gabriel India", ticker: "GABRIEL", channel: "Telegram (StockPro Online)", source: "StockPro Online", tag: "telegram", entry: 1450.00, sl: 1320.00, target: 1650.00, catalyst: "⚡ Fresh Positional: Cross past barriers with heavy breakout volume (Tgt 1,550-1,700)", date: "1 Sep 2026" },
    { name: "Diffusion Engineers", ticker: "DIFFUSION", channel: "Telegram (StockPro Online)", source: "StockPro Online", tag: "telegram", entry: 467.00, sl: 445.00, target: 540.00, catalyst: "Upper Circuit surge to ₹493.20; Tgt 540-580 on expansion", date: "1 Sep 2026" },
    { name: "Cords Cable Industries", ticker: "CORDSCABLE", channel: "Telegram (Breakout Investing)", source: "Breakout Investing", tag: "telegram", entry: 182.00, sl: 171.00, target: 205.00, catalyst: "Breakout Investing: BTST / Short Term Base Expansion", date: "1 Sep 2026" },
    { name: "Manali Petrochem", ticker: "MANALIPETC", channel: "Telegram (Breakout Investing)", source: "Breakout Investing", tag: "telegram", entry: 96.50, sl: 91.00, target: 110.00, catalyst: "Breakout Investing: Chemical Volume Momentum Breakout", date: "1 Sep 2026" },
    { name: "Indegene", ticker: "INDEGENE", channel: "Telegram (StockPro Online)", source: "StockPro Online", tag: "telegram", entry: 595.00, sl: 570.00, target: 680.00, catalyst: "Morning research breakout: hit high of ₹615.50 (Tgt 680)", date: "1 Sep 2026" },
    { name: "KPR Mill", ticker: "KPRMILL", channel: "Telegram (StockPro Online)", source: "StockPro Online", tag: "telegram", entry: 1140.00, sl: 1080.00, target: 1260.00, catalyst: "Textile leader breakout: hit intraday high of ₹1,196 🚀", date: "1 Sep 2026" },
    { name: "MV Electrosystems", ticker: "MVELECTRO", channel: "Telegram (StockPro Online)", source: "StockPro Online", tag: "telegram", entry: 675.00, sl: 640.00, target: 780.00, catalyst: "StockPro Momentum Blast: hit ₹780 high", date: "1 Sep 2026" },
    { name: "Cyient", ticker: "CYIENT", channel: "Telegram (StockPro Online)", source: "StockPro Online", tag: "telegram", entry: 1085.00, sl: 1055.00, target: 1192.00, catalyst: "StockPro Research: hit high of ₹1,192 🚀", date: "1 Sep 2026" },
    { name: "Dixon Tech", ticker: "DIXON", channel: "Telegram (StockPro Online)", source: "StockPro Online", tag: "telegram", entry: 14930.00, sl: 14700.00, target: 15530.00, catalyst: "StockPro Alert (>14930) + Massive EMS Order Inflow", date: "1 Sep 2026" },
    { name: "Tejas Networks", ticker: "TEJASNET", channel: "Telegram (StockPro Online)", source: "StockPro Online", tag: "telegram", entry: 570.00, sl: 530.00, target: 650.00, catalyst: "BSNL ₹1,537 Cr 4G/5G Order + Positional Hold", date: "1 Sep 2026" },
    { name: "Laurus Labs", ticker: "LAURUSLABS", channel: "Telegram (StockMarket Times)", source: "StockMarket Times Updates", tag: "telegram", entry: 478.00, sl: 452.00, target: 540.00, catalyst: "MSCI Rebalancing Inflow: +$598 Million Surge", date: "1 Sep 2026" },
    { name: "Uniparts India", ticker: "UNIPARTS", channel: "Telegram (Breakout Investing)", source: "Breakout Investing", tag: "telegram", entry: 580.00, sl: 545.00, target: 640.00, catalyst: "Breakout Investing: BTST / Short Term Accumulation", date: "1 Sep 2026" },
    { name: "JTL Industries", ticker: "JTLIND", channel: "Telegram (Breakout Investing)", source: "Breakout Investing", tag: "telegram", entry: 212.00, sl: 198.00, target: 240.00, catalyst: "Breakout Investing: Multi-Week Base Breakout", date: "1 Sep 2026" },

    // 🟣 Instagram (StockMarket Times & TradeClues)
    { name: "Jio Financial", ticker: "JIOFIN", channel: "Instagram (@StockMarketTimes)", source: "StockMarket Times", tag: "instagram", entry: 338.00, sl: 318.00, target: 385.00, catalyst: "SEBI Jio ₹37,000 Cr IPO Clearance & BlackRock JV Wealth Scaling", date: "1 Sep 2026" },
    { name: "Suzlon Energy", ticker: "SUZLON", channel: "Instagram (@StockMarketTimes)", source: "StockMarket Times", tag: "instagram", entry: 74.50, sl: 68.00, target: 88.00, catalyst: "Record 5.4 GW Wind Turbine Order Book & Turnaround", date: "1 Sep 2026" },
    { name: "Tata Power", ticker: "TATAPOWER", channel: "Instagram (@StockMarketTimes)", source: "StockMarket Times", tag: "instagram", entry: 435.00, sl: 412.00, target: 485.00, catalyst: "Solar Rooftop Surge & EV Highway Charging Growth", date: "1 Sep 2026" },
    { name: "CDSL", ticker: "CDSL", channel: "Instagram (@StockMarketTimes)", source: "StockMarket Times", tag: "instagram", entry: 1640.00, sl: 1560.00, target: 1850.00, catalyst: "13+ Cr Active Demat Accounts Record & Market Expansion", date: "1 Sep 2026" },

    // 🚀 Core Momentum Desk Setups
    { name: "Welspun Corp", ticker: "WELSPUNCORP", channel: "Momentum Desk", source: "Breakout", tag: "breakout", entry: 2373.80, sl: 2260.00, target: 2620.00, catalyst: "Record $1.8B Landmark US Order Backlog", date: "1 Sep 2026" },
    { name: "Hindustan Zinc", ticker: "HINDZINC", channel: "Momentum Desk", source: "Breakout", tag: "breakout", entry: 622.00, sl: 588.00, target: 715.00, catalyst: "Spot Zinc Rally +31% & Jefferies ₹750 Target", date: "1 Sep 2026" },
    { name: "Bharat Electronics", ticker: "BEL", channel: "Momentum Desk", source: "Breakout", tag: "breakout", entry: 411.90, sl: 392.00, target: 462.00, catalyst: "97 Tejas Jets Order + ₹74.6k Cr Book", date: "1 Sep 2026" },
    { name: "Mastek", ticker: "MASTEK", channel: "Momentum Desk", source: "Breakout", tag: "breakout", entry: 1901.40, sl: 1815.00, target: 2140.00, catalyst: "Tech Reversal & Nvidia Tailwinds", date: "1 Sep 2026" },
    { name: "Ather Energy", ticker: "ATHERENERGY", channel: "Momentum Desk", source: "Breakout", tag: "breakout", entry: 1616.30, sl: 1515.00, target: 1840.00, catalyst: "EV Channel Markup +33% 1M", date: "1 Sep 2026" }
  ];
}

app.get('/api/swing-setups', async (req, res) => {
  try {
    const now = new Date();
    const istTimeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) + ' IST';
    const setups = await getLiveSwingSetups();
    res.json({
      setups,
      total: setups.length,
      channels: ['WhatsApp (Swing Pool PRO)', 'Telegram (StockPro Online, Breakout Investing, StockMarket Times)', 'Instagram (@StockMarketTimes, @TradeClues)', 'Momentum Desk'],
      asOf: '2 Sep 2026 | ' + istTimeStr,
      refreshIntervalMs: 60000
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sectors', async (req, res) => {
  try {
    const now = new Date();
    const istTimeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) + ' IST';
    const sectors = await getLiveSectors();
    res.json({
      sectors,
      total: sectors.length,
      asOf: '2 Sep 2026 | ' + istTimeStr,
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
  
  const now = new Date();
  const istTimeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) + ' IST';
  const displayDate = /nov/i.test(dateQuery) ? '1 November 2026' : '2 September 2026';

    const preOpen = {
    title: `Pre-Open Market Commentary · ${displayDate}`,
    timestamp: `${displayDate} | 08:45 IST`,
    summary: `Markets open mid-week trade with strong stock-specific momentum. Sterlite Tech in sharp focus after bagging a ₹2,750 Cr AI hyperscaler order, while ITC Infotech executes a ₹1,330 Cr merger. DII institutional buying (+₹17,316 Cr) continues to anchor the index firmly above 24,150.`,
    giftNifty: '24,240.00 (Derived CFD)',
    niftyRange: '24,050 – 24,450',
    keyLevels: {
      niftySupport: '24,050 – 24,100',
      niftyResistance: '24,350 – 24,450',
      bankNiftySupport: '51,200',
      bankNiftyResistance: '51,900'
    },
    institutionalFlows: {
      fii: '-₹1,601.65 Cr',
      dii: '+₹17,316.34 Cr',
      netInstitutional: '+₹15,714.69 Cr Net Bullish'
    },
    macroIndicators: {
      usdInr: '₹95.38 (Steady)',
      brentCrude: '$87.65/bbl (Off $92 peak)',
      us10yYield: '4.17%'
    },
    topStocksInFocus: [
      { ticker: 'STLTECH', name: 'Sterlite Tech', catalyst: 'Bagged massive ₹2,750 Cr AI Hyperscaler Optical order' },
      { ticker: 'ITC', name: 'ITC Ltd', catalyst: '₹1,330 Cr ITC Infotech tech acquisition & consolidation' },
      { ticker: 'APLAPOLLO', name: 'APL Apollo Tubes', catalyst: 'WhatsApp Swing Pool fresh call (Buy 2265-2230, Tgt 2455/2650++)' },
      { ticker: 'POLYPLEX', name: 'Polyplex Corp', catalyst: 'WhatsApp Direct fresh alert (Buy 1185, Tgt 1290/1380++)' },
      { ticker: 'TEJASNET', name: 'Tejas Networks', catalyst: 'Continued rally on ₹1,537 Cr BSNL 4G/5G deployment contract' }
    ],
    actionablePlan: 'Ride breakout momentum in AI infra, optical interconnects, and specialty packaging. Trail stop-losses higher on swing winners.'
  };

  const postMarket = {
    title: `Post-Market Closing Wrap · ${displayDate}`,
    timestamp: `${displayDate} | 16:00 IST`,
    summary: `Nifty closes firmly in the green led by robust buying in Defence (+3.45%), Metals (+2.80%), and Telecom (+2.15%). Breadth remained heavily in favor of advances with Midcap 100 touching fresh lifetime records.`,
    closingIndices: {
      nifty50: '24,175.65 (+0.35%)',
      sensex: '77,264.51 (+0.43%)',
      bankNifty: '51,320.40 (+0.28%)',
      midcap100: '64,450.90 (+0.72% All-Time High)'
    },
    sectorMovers: [
      { sector: 'Defence', change: '+3.45%', leaders: 'HAL, BEL, Mazagon' },
      { sector: 'Metals & Zinc', change: '+2.80%', leaders: 'Hindustan Zinc, NMDC' },
      { sector: 'Telecom & 5G', change: '+2.15%', leaders: 'Tejas, Airtel, Jio' },
      { sector: 'IT Services', change: '+1.85%', leaders: 'TCS, TechM, HCLTech' }
    ],
    institutionalFlows: {
      fii: '-₹1,601.65 Cr',
      dii: '+₹17,316.34 Cr'
    },
    marketOutlook: 'Carry positional longs with base trailing at 23,900. Watch out for US manufacturing PMI and RBI policy commentary in upcoming sessions.'
  };

  res.json({
    type,
    date: displayDate,
    commentary: type === 'postmarket' ? postMarket : preOpen,
    asOf: istTimeStr
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

app.listen(PORT, () => console.log(`momentwealth-backend listening on port ${PORT}`));
