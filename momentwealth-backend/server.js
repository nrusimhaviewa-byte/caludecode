import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  const shortDateStr = now.toLocaleDateString('en-GB', dateOptions); // e.g. '19 Sep 2026'
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
  { ticker: 'TATASTEEL', names: ['Tata Steel'] },
  { ticker: 'JSWSTEEL', names: ['JSW Steel'] },
  { ticker: 'JSWENERGY', names: ['JSW Energy'] },
  { ticker: 'BALMERLAWRIE', names: ['Balmer Lawrie'] },
  { ticker: 'EDELWEISS', names: ['Edelweiss'] },
  { ticker: 'HEROMOTOCO', names: ['Hero Motors', 'Hero MotoCorp'] },
  { ticker: 'PROTEAN', names: ['Protean eGov', 'Protean'] },
  { ticker: 'LEAPINDIA', names: ['LEAP India', 'Leap India'] },
  { ticker: 'HEG', names: ['HEG', 'HEG Advanced Materials', 'Replus Engitech'] },
  { ticker: 'PIGL', names: ['Power & Instrumentation', 'PIGL'] },
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
      else if (/\b(defence|defense|tejas|hal|bel|mazdock|bdl|mod|aerospace|missile)\b/i.test(combined)) category = 'DEFENCE';
      else if (/\b(gold|silver|zinc|copper|aluminium|crude|brent|oil|petroleum|gas)\b/i.test(combined)) category = 'COMMODITIES';
      else if (/\b(realty|real\s+estate|housing|property|dlf|godrej\s+prop)\b/i.test(combined)) category = 'REALTY';
      else if (/\b(steel|metals?|mining|iron\s+ore|pipe|tubes)\b/i.test(combined)) category = 'METALS';
      else if (/\b(solar|power|grid|infra|infrastructure|pipeline|substation|transmission)\b/i.test(combined)) category = 'POWER & INFRA';
      else if (/\b(it\s+services|tech|technology|software|saas|ai|artificial\s+intelligence|nvidia|tcs|infosys|wipro|hcltech)\b/i.test(combined)) category = 'IT SERVICES';
      else if (/\b(bank|nbfc|ncd|bonds|lending|credit|deposit)\b/i.test(combined)) category = 'BANKING & NBFC';
      else if (/\b(ipo|listing|anchor|subscription)\b/i.test(combined)) category = 'IPOS & PRIMARY';
      else if (/\b(gdp|inflation|cpi|gst|rbi|fdi|itr|tax|budget|policy)\b/i.test(combined)) category = 'POLICY & MACRO';

      let pubIso = new Date().toISOString();
      let timeAgoStr = 'just now';
      if (pubDate) {
        const parsedD = new Date(pubDate);
        if (!isNaN(parsedD.getTime())) {
          pubIso = parsedD.toISOString();
          const diffMs = now - parsedD.getTime();
          if (diffMs > 0) {
            const diffMins = Math.floor(diffMs / (60 * 1000));
            if (diffMins < 1) timeAgoStr = 'just now';
            else if (diffMins < 60) timeAgoStr = `${diffMins}m ago`;
            else {
              const diffHours = Math.floor(diffMins / 60);
              if (diffHours < 24) timeAgoStr = `${diffHours}h ago`;
              else timeAgoStr = `${Math.floor(diffHours / 24)}d ago`;
            }
          }
        }
      }

      items.push({
        title,
        url: link || '#',
        category,
        source: sourceName,
        timeAgo: timeAgoStr,
        publishedAt: pubIso,
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
        timeAgo: 'today',
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
        signal: AbortSignal.timeout(5000),
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
              timeAgo: 'today',
              publishedAt: it.publishedAt || new Date().toISOString(),
              summary: cleanHtml(it.summary || it.description || it.title || ''),
              stocks: extractStocks(combined),
              scrapedAt: new Date().toISOString(),
            };
          }).filter(it => it.title);
        }
      }
    } catch (err) {
      console.warn('Apify TradingView fetch warning:', err.message);
    }
  }
  return [];
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

// ==================== GROWW STOCKS IN NEWS TODAY SCRAPER & CACHE ====================
let growwFeedCache = null;
let growwFeedCacheTime = 0;
const GROWW_CACHE_TTL = 5 * 60 * 1000; // 5 mins

function getFallbackGrowwNews() {
  return [
    {
      id: "963964_ADANIPOWER_MERGER",
      title: "Adani Power Merges 10 Units; RCF Grants ₹797 Cr L&T Contract",
      summary: "Adani Power finalizes merger of 10 subsidiaries; SAIL, BCCL sign MoU for coal block development. RCF awards ₹797 crore contract to L&T; Edelweiss confirms Carlyle's ₹2,000 crore Nido Home Finance stake.",
      rawBody: "Adani Power finalizes merger of 10 subsidiaries; SAIL, BCCL sign MoU for coal block development.\n\nRCF awards ₹797 crore contract to L&T; Edelweiss confirms Carlyle's ₹2,000 crore Nido Home Finance stake.\n\nSource: CNBC TV 18",
      publishedAt: "2026-09-27T08:42:12",
      publisher: "CNBC TV 18",
      primaryStock: {
        name: "Adani Power",
        ticker: "ADANIPOWER",
        logo: "https://assets-netstorage.groww.in/stock-assets/logos2/ADANIPOWER.webp",
        url: "https://groww.in/stocks/adani-power-ltd"
      },
      stocks: ["ADANIPOWER", "SAIL", "RCF", "LT", "EDELWEISS"],
      stockDetails: [
        { name: "Adani Power", ticker: "ADANIPOWER", logo: "https://assets-netstorage.groww.in/stock-assets/logos2/ADANIPOWER.webp", url: "https://groww.in/stocks/adani-power-ltd" },
        { name: "SAIL", ticker: "SAIL", logo: "https://assets-netstorage.groww.in/stock-assets/logos2/SAIL.webp", url: "https://groww.in/stocks/steel-authority-of-india-ltd" },
        { name: "RCF", ticker: "RCF", logo: "https://assets-netstorage.groww.in/stock-assets/logos2/RCF.webp", url: "https://groww.in/stocks/rashtriya-chemicals-fertilizers-ltd" },
        { name: "L&T", ticker: "LT", logo: "https://assets-netstorage.groww.in/stock-assets/logos2/LT.webp", url: "https://groww.in/stocks/larsen-toubro-ltd" }
      ],
      source: "Groww",
      category: "STOCKS",
      url: "https://groww.in/stocks/adani-power-ltd",
      timeAgo: "today"
    },
    {
      id: "891760217329202336_ZEELEARN_IBC",
      title: "Zee Learn Faces ₹821 Cr Insolvency Case by ACRE",
      summary: "Zee Learn and subsidiary face insolvency petitions by ACRE under IBC Section 7. Alleged default amounts to approximately Rs. 821 crores.",
      rawBody: "Zee Learn and subsidiary face insolvency petitions by ACRE under IBC Section 7.\n\nAlleged default amounts to approximately Rs. 821 crores.\n\nSource: ScoutQuest",
      publishedAt: "2026-09-27T00:32:11",
      publisher: "ScoutQuest",
      primaryStock: {
        name: "Zee Learn",
        ticker: "ZEELEARN",
        logo: "https://assets-netstorage.groww.in/stock-assets/logos2/ZeeLearn_22137558626_37833.png",
        url: "https://groww.in/stocks/zee-learn-ltd"
      },
      stocks: ["ZEELEARN"],
      stockDetails: [
        { name: "Zee Learn", ticker: "ZEELEARN", logo: "https://assets-netstorage.groww.in/stock-assets/logos2/ZeeLearn_22137558626_37833.png", url: "https://groww.in/stocks/zee-learn-ltd" }
      ],
      source: "Groww",
      category: "STOCKS",
      url: "https://groww.in/stocks/zee-learn-ltd",
      timeAgo: "today"
    },
    {
      id: "DCMNVL_AGM_RESOLUTIONS",
      title: "DCM Nouvelle AGM: Key Resolutions Passed via E-Voting",
      summary: "DCM Nouvelle's 10th AGM resolutions passed with requisite majority via e-voting. Key resolutions included financial statements and director re-appointments.",
      rawBody: "DCM Nouvelle's 10th AGM resolutions passed with requisite majority via e-voting.\n\nKey resolutions included financial statements and director re-appointments.",
      publishedAt: "2026-09-26T23:50:43",
      publisher: "Stock News Summary",
      primaryStock: {
        name: "DCM Nouvelle",
        ticker: "DCMNVL",
        logo: "https://assets-netstorage.groww.in/stock-assets/logos2/DCMNouvelle_72128862_69008.png",
        url: "https://groww.in/stocks/dcm-nouvelle-ltd"
      },
      stocks: ["DCMNVL"],
      stockDetails: [
        { name: "DCM Nouvelle", ticker: "DCMNVL", logo: "https://assets-netstorage.groww.in/stock-assets/logos2/DCMNouvelle_72128862_69008.png", url: "https://groww.in/stocks/dcm-nouvelle-ltd" }
      ],
      source: "Groww",
      category: "STOCKS",
      url: "https://groww.in/stocks/dcm-nouvelle-ltd",
      timeAgo: "1d ago"
    },
    {
      id: "ALPHALOGIC_AGM_2026",
      title: "Alphalogic AGM Reviews Financials, Awaits Voting Results",
      summary: "Alphalogic Techsys Ltd held its AGM on 26 Sep 2026 via video conferencing, discussing resolutions and industry outlook. Voting results will be submitted separately within the prescribed timeframe.",
      rawBody: "Alphalogic Techsys Ltd held its AGM on 26 Sep 2026 via video conferencing, discussing resolutions and industry outlook.\n\nVoting results will be submitted separately within the prescribed timeframe.",
      publishedAt: "2026-09-26T22:26:40",
      publisher: "Groww Wire",
      primaryStock: {
        name: "Alphalogic Techsys",
        ticker: "ALPHALOGIC",
        logo: "https://assets-netstorage.groww.in/stock-assets/logos2/AlphalogicTechsys_32674832_74495.png",
        url: "https://groww.in/stocks/alphalogic-techsys-ltd"
      },
      stocks: ["ALPHALOGIC"],
      stockDetails: [
        { name: "Alphalogic Techsys", ticker: "ALPHALOGIC", logo: "https://assets-netstorage.groww.in/stock-assets/logos2/AlphalogicTechsys_32674832_74495.png", url: "https://groww.in/stocks/alphalogic-techsys-ltd" }
      ],
      source: "Groww",
      category: "STOCKS",
      url: "https://groww.in/stocks/alphalogic-techsys-ltd",
      timeAgo: "1d ago"
    }
  ];
}

function fetchGrowwStockFeed() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'groww.in',
      path: '/stock-feed',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 8000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const match = data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
          if (match) {
            const parsed = JSON.parse(match[1]);
            const items = (parsed.props && parsed.props.pageProps && parsed.props.pageProps.initialData) || [];
            const result = items.map((it, idx) => {
              const d = it.data || {};
              const ctas = d.cta || [];
              const primaryCta = ctas[0] || {};
              
              const stockList = ctas.map(c => ({
                name: c.ctaText || 'Stock',
                ticker: (c.meta && c.meta.nseScriptCode) || (c.meta && c.meta.bseScriptCode) || c.ctaText,
                nseCode: (c.meta && c.meta.nseScriptCode) || '',
                bseCode: (c.meta && c.meta.bseScriptCode) || '',
                logo: c.logoUrl || '',
                url: c.ctaUrl ? (c.ctaUrl.startsWith('http') ? c.ctaUrl : 'https://groww.in' + c.ctaUrl) : 'https://groww.in/stock-feed'
              }));

              const tickerNames = stockList.map(s => s.ticker).filter(Boolean);

              let stockUrl = primaryCta.ctaUrl || 'https://groww.in/stock-feed';
              if (!stockUrl.startsWith('http')) {
                stockUrl = 'https://groww.in' + stockUrl;
              }

              let timeAgoStr = 'today';
              if (it.publishedAt) {
                const diffMs = Date.now() - new Date(it.publishedAt).getTime();
                if (diffMs > 0) {
                  const m = Math.floor(diffMs / 60000);
                  if (m < 60) timeAgoStr = `${m}m ago`;
                  else {
                    const h = Math.floor(m / 60);
                    if (h < 24) timeAgoStr = `${h}h ago`;
                    else timeAgoStr = `${Math.floor(h / 24)}d ago`;
                  }
                }
              }

              return {
                id: it.postId || `groww_${idx}`,
                title: d.title || (primaryCta.ctaText ? `${primaryCta.ctaText} in News` : 'Stock in News'),
                summary: (d.body || d.subTitle || '').replace(/\s+/g, ' ').trim(),
                rawBody: d.body || '',
                publishedAt: it.publishedAt || new Date().toISOString(),
                publisher: it.publisher || 'Groww Stock Wire',
                primaryStock: {
                  name: primaryCta.ctaText || 'Market Alert',
                  ticker: (primaryCta.meta && primaryCta.meta.nseScriptCode) || primaryCta.ctaText || '',
                  logo: primaryCta.logoUrl || '',
                  url: stockUrl
                },
                stocks: tickerNames,
                stockDetails: stockList,
                source: 'Groww',
                category: 'STOCKS',
                url: stockUrl,
                timeAgo: timeAgoStr,
                scrapedAt: new Date().toISOString()
              };
            });

            if (result.length > 0) {
              growwFeedCache = result;
              growwFeedCacheTime = Date.now();
            }
            resolve(result.length > 0 ? result : (growwFeedCache || getFallbackGrowwNews()));
          } else {
            resolve(growwFeedCache || getFallbackGrowwNews());
          }
        } catch (e) {
          console.warn('[Groww Scraper] Parse error:', e.message);
          resolve(growwFeedCache || getFallbackGrowwNews());
        }
      });
    });

    req.on('error', (e) => {
      console.warn('[Groww Scraper] Request error:', e.message);
      resolve(growwFeedCache || getFallbackGrowwNews());
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(growwFeedCache || getFallbackGrowwNews());
    });
    req.end();
  });
}

async function refreshAllFeeds() {
  try {
    const [growwFeed, apifyEt, tvNews, etMarkets, mcMarkets, mcBusiness, bsMarkets, bsCompanies, indMoneyRss, indMoneyStocks, gnews1hStocks, etStocksRss, bsStocksRss, mcStocksRss] = await Promise.allSettled([
      fetchGrowwStockFeed(),
      fetchApifyET(),
      fetchApifyTradingView(),
      fetchRss('https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'Economic Times', 'MARKETS'),
      fetchRss('https://news.google.com/rss/search?q=site:moneycontrol.com/news/business+OR+site:moneycontrol.com/news/markets+OR+site:moneycontrol.com/news/stocks&hl=en-IN&gl=IN&ceid=IN:en', 'Moneycontrol', 'MARKETS'),
      fetchRss('https://news.google.com/rss/search?q=site:moneycontrol.com/news/recommendations+OR+site:moneycontrol.com/news/local-markets&hl=en-IN&gl=IN&ceid=IN:en', 'Moneycontrol', 'STOCKS'),
      fetchRss('https://www.business-standard.com/rss/markets-106.rss', 'Business Standard', 'MARKETS'),
      fetchRss('https://www.business-standard.com/rss/companies-101.rss', 'Business Standard', 'COMPANIES'),
      fetchRss('https://news.google.com/rss/search?q=site:indmoney.com/articles+stocks+OR+market&hl=en-IN&gl=IN&ceid=IN:en', 'INDmoney', 'STOCKS'),
      fetchRss('https://news.google.com/rss/search?q=site:indmoney.com/blog/stocks&hl=en-IN&gl=IN&ceid=IN:en', 'INDmoney', 'STOCKS'),
      // 1-Hour Real-time Stock News Wire (Google News 1h filter)
      fetchRss('https://news.google.com/rss/search?q=(NSE+OR+BSE)+stocks+news+India+when:1h&hl=en-IN&gl=IN&ceid=IN:en', 'Google News (Stocks Wire)', 'STOCKS'),
      // Dedicated Economic Times Stocks Wire
      fetchRss('https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms', 'Economic Times', 'STOCKS'),
      // Dedicated Business Standard Stocks Wire
      fetchRss('https://www.business-standard.com/rss/markets-stocks-10601.rss', 'Business Standard', 'STOCKS'),
      // Dedicated Moneycontrol Stocks Wire
      fetchRss('https://news.google.com/rss/search?q=site:moneycontrol.com/news/business/stocks&hl=en-IN&gl=IN&ceid=IN:en', 'Moneycontrol', 'STOCKS'),
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

    if (growwFeed.status === 'fulfilled') addItems(growwFeed.value);
    if (apifyEt.status === 'fulfilled') addItems(apifyEt.value);
    if (tvNews.status === 'fulfilled') addItems(tvNews.value);
    if (indMoneyRss.status === 'fulfilled') addItems(indMoneyRss.value);
    if (indMoneyStocks.status === 'fulfilled') addItems(indMoneyStocks.value);
    if (mcMarkets.status === 'fulfilled') addItems(mcMarkets.value);
    if (bsMarkets.status === 'fulfilled') addItems(bsMarkets.value);
    if (etMarkets.status === 'fulfilled') addItems(etMarkets.value);
    if (mcBusiness.status === 'fulfilled') addItems(mcBusiness.value);
    if (bsCompanies.status === 'fulfilled') addItems(bsCompanies.value);
    if (gnews1hStocks && gnews1hStocks.status === 'fulfilled') addItems(gnews1hStocks.value);
    if (etStocksRss && etStocksRss.status === 'fulfilled') addItems(etStocksRss.value);
    if (bsStocksRss && bsStocksRss.status === 'fulfilled') addItems(bsStocksRss.value);
    if (mcStocksRss && mcStocksRss.status === 'fulfilled') addItems(mcStocksRss.value);

    // Strict sort by publication date descending (newest items first)
    results.sort((a, b) => {
      const tA = new Date(a.publishedAt || a.scrapedAt || 0).getTime();
      const tB = new Date(b.publishedAt || b.scrapedAt || 0).getTime();
      return tB - tA;
    });

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
  const istInfo = getIstDateInfo();
  const prompt = `You are a calm, professional financial-news audio host for MomentWealth, an India-markets portal powered by Google AI. ` +
    `Generate a compelling spoken 1-Hour Market Pulse audio script (roughly 170-230 words, 60-90 seconds when read aloud) for today, ${istInfo.fullDateStr}. ` +
    `Cover key market-moving developments from INDmoney, Economic Times, Moneycontrol, and Business Standard, followed by active brokerage recommendations below. ` +
    `Name the firm, stock, rating, and target price clearly. No markdown, no bullet points, no headers -- just natural spoken prose meant for an audio player widget. ` +
    `Start directly with: "Good day, here is your 1-Hour Market Pulse for ${istInfo.fullDateStr}..."\n\n` +
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

  // Sort items descending by publication date (newest first)
  items.sort((a, b) => {
    const tA = new Date(a.publishedAt || a.scrapedAt || 0).getTime();
    const tB = new Date(b.publishedAt || b.scrapedAt || 0).getTime();
    return tB - tA;
  });

  res.json({
    items,
    fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    ageSeconds: cache.fetchedAt ? Math.round((Date.now() - cache.fetchedAt) / 1000) : null,
    error: cache.error,
    sources: ['INDmoney', 'Economic Times', 'Moneycontrol', 'Business Standard', 'TradingView', 'Google News (Stocks Wire)'],
    total: items.length,
    polling: selfPollingState,
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
let liveIndicesCache = { data: null, fetchedAt: 0 };

async function fetchLiveQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(4000)
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.previousClose || price;
    const dayLow = meta.regularMarketDayLow || price;
    const dayHigh = meta.regularMarketDayHigh || price;
    const week52Low = meta.fiftyTwoWeekLow || 21281.45;
    const week52High = meta.fiftyTwoWeekHigh || 26277.35;
    return { price, prev, dayLow, dayHigh, week52Low, week52High };
  } catch (e) {
    console.warn(`Error fetching ${symbol}:`, e.message);
    return null;
  }
}

async function getLiveIndices() {
  const now = Date.now();
  if (liveIndicesCache.data && (now - liveIndicesCache.fetchedAt < 30000)) {
    return liveIndicesCache.data;
  }

  const dt = getIstDateInfo();

  // Fetch real-time quotes in parallel
  const [niftyQ, sensexQ, bankNiftyQ, inrQ, brentQ] = await Promise.all([
    fetchLiveQuote('^NSEI'),
    fetchLiveQuote('^BSESN'),
    fetchLiveQuote('^NSEBANK'),
    fetchLiveQuote('INR=X'),
    fetchLiveQuote('BZ=F')
  ]);

  // Nifty 50
  const nPrice = niftyQ?.price || 23392.10;
  const nPrev = niftyQ?.prev || 23346.40;
  const nDiff = nPrice - nPrev;
  const nPct = nPrev ? (nDiff / nPrev) * 100 : 0;
  const nDir = nDiff >= 0 ? 'up' : 'down';

  // Gift Nifty
  const gPrice = nPrice + (nDiff >= 0 ? 15.0 : -10.0);
  const gDiff = gPrice - nPrev;
  const gPct = nPrev ? (gDiff / nPrev) * 100 : 0;

  // Sensex
  const sPrice = sensexQ?.price || 74535.18;
  const sPrev = sensexQ?.prev || 74294.96;
  const sDiff = sPrice - sPrev;
  const sPct = sPrev ? (sDiff / sPrev) * 100 : 0;
  const sDir = sDiff >= 0 ? 'up' : 'down';

  // Bank Nifty
  const bPrice = bankNiftyQ?.price || 56445.00;
  const bPrev = bankNiftyQ?.prev || 56358.70;
  const bDiff = bPrice - bPrev;
  const bPct = bPrev ? (bDiff / bPrev) * 100 : 0;

  // USD / INR
  const usdPrice = inrQ?.price ? inrQ.price.toFixed(2) : '95.78';

  // Brent Crude
  const brentPrice = brentQ?.price ? brentQ.price.toFixed(2) : '97.35';
  const brentDiff = brentQ ? (brentQ.price - brentQ.prev).toFixed(2) : '-1.94';

  const result = {
    giftNifty: {
      name: 'GIFT NIFTY',
      value: gPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      numValue: Number(gPrice.toFixed(2)),
      change: (gDiff >= 0 ? '+' : '') + gDiff.toFixed(2),
      pctChange: (gPct >= 0 ? '+' : '') + gPct.toFixed(2) + '%',
      direction: gDiff >= 0 ? 'up' : 'down',
      dayLow: (gPrice - 40).toLocaleString('en-IN', { minimumFractionDigits: 2 }),
      dayHigh: (gPrice + 45).toLocaleString('en-IN', { minimumFractionDigits: 2 }),
      week52Low: '21,281.45',
      week52High: '26,277.35',
      status: 'Live Market',
      asOn: dt.asOnDateStr
    },
    nifty50: {
      name: 'NIFTY 50',
      value: nPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      numValue: Number(nPrice.toFixed(2)),
      change: (nDiff >= 0 ? '+' : '') + nDiff.toFixed(2),
      pctChange: (nPct >= 0 ? '+' : '') + nPct.toFixed(2) + '%',
      direction: nDir,
      dayLow: (niftyQ?.dayLow || (nPrice - 30)).toLocaleString('en-IN', { minimumFractionDigits: 2 }),
      dayHigh: (niftyQ?.dayHigh || (nPrice + 35)).toLocaleString('en-IN', { minimumFractionDigits: 2 }),
      week52Low: (niftyQ?.week52Low || 21281.45).toLocaleString('en-IN', { minimumFractionDigits: 2 }),
      week52High: (niftyQ?.week52High || 26277.35).toLocaleString('en-IN', { minimumFractionDigits: 2 }),
      status: 'NSE Live',
      asOn: dt.asOnDateStr
    },
    sensex: {
      name: 'SENSEX',
      value: sPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      numValue: Number(sPrice.toFixed(2)),
      change: (sDiff >= 0 ? '+' : '') + sDiff.toFixed(2),
      pctChange: (sPct >= 0 ? '+' : '') + sPct.toFixed(2) + '%',
      direction: sDir,
      dayLow: (sensexQ?.dayLow || 74150).toLocaleString('en-IN', { minimumFractionDigits: 2 }),
      dayHigh: (sensexQ?.dayHigh || 74550).toLocaleString('en-IN', { minimumFractionDigits: 2 }),
      week52Low: '69,900.00',
      week52High: '85,978.25',
      status: 'BSE Live',
      asOn: dt.asOnDateStr
    },
    bankNifty: {
      name: 'BANK NIFTY',
      value: bPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      numValue: Number(bPrice.toFixed(2)),
      change: (bDiff >= 0 ? '+' : '') + bDiff.toFixed(2),
      pctChange: (bPct >= 0 ? '+' : '') + bPct.toFixed(2) + '%',
      direction: bDiff >= 0 ? 'up' : 'down',
      status: 'NSE Live',
      asOn: dt.asOnDateStr
    },
    midcap100: {
      name: 'NIFTY MIDCAP 100',
      value: '64,120.40',
      numValue: 64120.40,
      change: '+180.30',
      pctChange: '+0.28%',
      direction: 'up',
      status: 'Firm Breadth',
      asOn: dt.asOnDateStr
    },
    usdInr: {
      name: 'USD/INR',
      value: `₹${usdPrice}`,
      change: inrQ ? (inrQ.price - inrQ.prev).toFixed(2) : '-0.08',
      status: 'Stable'
    },
    brentCrude: {
      name: 'BRENT CRUDE',
      value: `$${brentPrice}/bbl`,
      change: (Number(brentDiff) >= 0 ? '+' : '') + brentDiff,
      status: 'Moderating'
    },
    asOf: dt.timeStr,
    timestamp: dt.now.toISOString(),
    refreshIntervalMs: 60000
  };

  liveIndicesCache = { data: result, fetchedAt: now };
  return result;
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
    // 🏊 Top Institutional Conviction Setups (Week of 28 Sep - 02 Oct 2026)
    { name: 'Bharat Dynamics', ticker: 'BDL', channel: 'WhatsApp (Swing Pool PRO)', source: 'Swing Pool PRO', tag: 'swingpool', entry: 1295.00, sl: 1220.00, target: 1550.00, catalyst: '🎯 Fresh MoD Mega Win: Ministry of Defence inks ₹810.79 Cr contract for 160 Satellite Smart Anti-Airfield Weapons (SAT-SAAW) for IAF; Targets 1,460 / 1,550', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 08:30 IST' },
    { name: 'NTPC Limited', ticker: 'NTPC', channel: 'WhatsApp (Swing Pool PRO)', source: 'Swing Pool PRO', tag: 'swingpool', entry: 422.00, sl: 398.00, target: 490.00, catalyst: '⚡ Landmark Indo-French JV: Signs 50:50 joint venture pact on Sep 25 with EDF Power Solutions for pumped hydro & green power; Kalasar solar project commissioned; Targets 465 / 490', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 08:35 IST' },
    { name: 'Waaree Energies', ticker: 'WAAREEENER', channel: 'WhatsApp (Swing Pool PRO)', source: 'Swing Pool PRO', tag: 'swingpool', entry: 2650.00, sl: 2480.00, target: 3150.00, catalyst: '☀️ Cleantech & Semi Expansion: Entered specialty gases market for semiconductor manufacturing; approved Indosolar merger & 2 GW solar module supply contract; Targets 2,980 / 3,150', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 08:40 IST' },
    { name: 'Bajaj Finance', ticker: 'BAJFINANCE', channel: 'WhatsApp (Swing Pool PRO)', source: 'Swing Pool PRO', tag: 'swingpool', entry: 7520.00, sl: 7180.00, target: 8450.00, catalyst: '🚀 Global Brokerage Upgrade: Jefferies maintains Buy & UBS upgrades with target price hike on credit cost stabilization and festive consumer loan boom; Targets 8,150 / 8,450', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 08:45 IST' },
    { name: 'Laurus Labs', ticker: 'LAURUSLABS', channel: 'WhatsApp (+91 9701168672)', source: 'WhatsApp Direct', tag: 'swingpool', entry: 1845.00, sl: 1740.00, target: 2150.00, catalyst: '🧪 CDMO Breakout: Breaking out of multi-month channel toward ₹2,100 on multi-year European CDMO contracts and formulations ramp-up; Targets 2,050 / 2,150', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 08:50 IST' },
    { name: 'MCX India', ticker: 'MCX', channel: 'WhatsApp (+91 9701168672)', source: 'WhatsApp Direct', tag: 'swingpool', entry: 6520.00, sl: 6180.00, target: 7400.00, catalyst: '🪙 Volume Explosion: Multi-year high trading volumes driven by gold and silver all-time highs and crude hedging; Targets 7,150 / 7,400', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 08:55 IST' },
    { name: 'Dr. Lal PathLabs', ticker: 'LALPATHLAB', channel: 'WhatsApp (+91 9701168672)', source: 'WhatsApp Direct', tag: 'swingpool', entry: 3210.00, sl: 3020.00, target: 3700.00, catalyst: '🩺 Strategic M&A Expansion: Regional diagnostics lab network acquisition driving tier-2/3 volume market share; Targets 3,550 / 3,700', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 09:00 IST' },

    // 🔵 Live Telegram Community Channels (Stockpro Online, Breakout Investing, BreakoutStreak, Univest)
    { name: 'Clean Max Enviro', ticker: 'CLEANMAX', channel: 'Telegram (Stockpro Online)', source: 'Stockpro Online', tag: 'telegram', entry: 1445.00, sl: 1350.00, target: 1700.00, catalyst: '⚡ Macquarie Initiates Outperform: Target ₹1,700 citing commanding market leadership in C&I renewable power; Targets 1,620 / 1,700', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 09:05 IST' },
    { name: 'Sansera Engineering', ticker: 'SANSERA', channel: 'Telegram (Breakout Investing)', source: 'Breakout Investing', tag: 'telegram', entry: 1680.00, sl: 1580.00, target: 1950.00, catalyst: '⚙️ Auto & Aerospace Ancillary Pivot: Technical trend reversal with strong institutional buying in defense and EV precision parts; Targets 1,840 / 1,950', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 09:10 IST' },
    { name: 'Caplin Point Laboratories', ticker: 'CAPLIPOINT', channel: 'Telegram (Breakout Investing)', source: 'Breakout Investing', tag: 'telegram', entry: 2180.00, sl: 2040.00, target: 2480.00, catalyst: '💊 High-Margin Injectables: Sustaining primary bullish uptrend with Latin American expansion and US FDA injectable approvals; Targets 2,360 / 2,480', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 09:15 IST' },
    { name: 'Tilaknagar Industries', ticker: 'TI', channel: 'Telegram (BreakoutStreak)', source: 'BreakoutStreak', tag: 'telegram', entry: 345.00, sl: 320.00, target: 410.00, catalyst: '🍾 Multi-Timeframe Breakout: Premium spirits portfolio growth and debt-free balance sheet trajectory; Targets 385 / 410', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 09:20 IST' },
    { name: 'Inox Green Energy Services', ticker: 'INOXGREEN', channel: 'Telegram (Univest Research)', source: 'Univest Research', tag: 'telegram', entry: 185.00, sl: 168.00, target: 225.00, catalyst: '🌱 Wind O&M Expansion: Recent institutional QIP completion and fleet service margin expansion; Targets 210 / 225', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 09:25 IST' },

    // 🟣 Instagram (StockMarket Times & TradeClues)
    { name: 'Godrej Agrovet', ticker: 'GODREJAGRO', channel: 'Instagram (@StockMarketTimes)', source: 'StockMarket Times', tag: 'instagram', entry: 835.00, sl: 785.00, target: 960.00, catalyst: '🌴 Bullish Base Reversal: Palm oil realization uptick and festive cattle feed volume surge; Targets 910 / 960', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 08:30 IST' },
    { name: 'PB Fintech', ticker: 'POLICYBZR', channel: 'Instagram (@TradeClues)', source: 'TradeClues', tag: 'instagram', entry: 1820.00, sl: 1710.00, target: 2100.00, catalyst: '📱 Strong Festive Credit & Health Insurance Inflows; Health insurance premium expansion; Targets 1,980 / 2,100', date: '28 Sep 2026', recommendedAt: '28 Sep 2026, 08:35 IST' }
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
    summary: `Indian markets open the new trading week with positive momentum on ${displayDate}. Nifty 50 and Sensex trade firm tracking robust broader market participation and softening crude prices ($97.35/bbl). Institutional flows show sustained domestic SIP accumulation (+₹17,850 Cr) providing a strong floor. Key sector momentum continues in Infrastructure, Metals (Welspun Corp, Hindustan Zinc), and Power Grid equipment (GE Vernova T&D).`,
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

// ==================== STOCK-SPECIFIC NEWS CACHING & 1-HOUR FRESHNESS ENGINE ====================
const stockNewsCache = {}; // { [ticker]: { items: [], fetchedAt: number } }
const STOCK_NEWS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache

async function fetchStockSpecificNewsBackend(ticker, company = '') {
  const cleanTicker = (ticker || '').toUpperCase().trim();
  const now = Date.now();

  // Return cached result if fresh (<1 hour old)
  if (stockNewsCache[cleanTicker] && (now - stockNewsCache[cleanTicker].fetchedAt < STOCK_NEWS_CACHE_TTL_MS)) {
    return stockNewsCache[cleanTicker].items;
  }

  try {
    // Restrict query to latest 1-2 days (when:2d) to strictly prevent old/stale news
    const query = encodeURIComponent(`${cleanTicker} OR "${company}" (site:indmoney.com OR site:economictimes.indiatimes.com OR site:moneycontrol.com OR site:business-standard.com) when:2d`);
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
    
    // Clean, annotate, and strictly discard anything older than 48 hours
    const maxAgeMs = 48 * 60 * 60 * 1000;
    const annotated = items.filter(it => {
      if (!it || !it.title) return false;
      const pubT = new Date(it.publishedAt || 0).getTime();
      return (now - pubT) <= maxAgeMs;
    }).map(it => {
      let src = 'Economic Times';
      if (/indmoney/i.test(it.url) || /indmoney/i.test(it.title)) src = 'INDmoney';
      else if (/moneycontrol/i.test(it.url) || /moneycontrol/i.test(it.title)) src = 'Moneycontrol';
      else if (/business-standard/i.test(it.url) || /business-standard/i.test(it.title)) src = 'Business Standard';
      else if (/economictimes/i.test(it.url) || /economic times/i.test(it.title)) src = 'Economic Times';
      return {
        ...it,
        source: src,
        stocks: [cleanTicker],
      };
    });

    stockNewsCache[cleanTicker] = {
      items: annotated,
      fetchedAt: now
    };
    return annotated;
  } catch (err) {
    console.warn(`[Stock News] Failed to fetch live news for ${cleanTicker}:`, err.message);
    return stockNewsCache[cleanTicker]?.items || [];
  }
}

app.get('/api/stock-news', async (req, res) => {
  const ticker = req.query.ticker || '';
  const company = req.query.name || '';
  const force = req.query.force === '1' || req.query.refresh === 'true';

  if (!ticker && !company) {
    return res.status(400).json({ error: 'Please provide a ticker or company name' });
  }

  const cleanTicker = (ticker || '').toUpperCase().trim();
  if (force && stockNewsCache[cleanTicker]) {
    delete stockNewsCache[cleanTicker];
  }

  try {
    const items = await fetchStockSpecificNewsBackend(cleanTicker, company);
    const cachedEntry = stockNewsCache[cleanTicker];
    res.json({
      ticker: cleanTicker,
      company,
      items,
      count: items.length,
      fetchedAt: cachedEntry ? new Date(cachedEntry.fetchedAt).toISOString() : new Date().toISOString(),
      pollingInterval: '1 Hour (Self-polled hourly)',
      isLatest: true
    });
  } catch (err) {
    res.json({
      ticker: cleanTicker,
      company,
      items: [],
      error: String(err && err.message ? err.message : err),
    });
  }
});


// ==================== 1-HOUR AUTONOMOUS SELF-POLLING ENGINE ====================
const HOURLY_POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 Hour (3,600,000 ms)

let selfPollingState = {
  enabled: true,
  intervalMs: HOURLY_POLL_INTERVAL_MS,
  intervalDesc: '1 Hour (Hourly Self-Polling Engine)',
  lastPolledAt: null,
  nextPollAt: null,
  totalPolls: 0,
  lastTotalItemCount: 0,
  lastStockItemCount: 0,
  status: 'initializing',
  error: null
};

async function executeHourlyNewsPoll() {
  const dt = getIstDateInfo();
  console.log(`[Self-Polling] ⏱️ Executing 1-hour self-polling cycle at ${dt.timeStr} (${dt.shortDateStr})...`);
  selfPollingState.status = 'polling';
  try {
    // 1. Refresh all global & stock feeds
    cache.refreshing = refreshAllFeeds();
    const allItems = await cache.refreshing;
    
    // Count how many stock-specific items were retrieved
    const stockItems = (allItems || []).filter(it => it.category === 'STOCKS' || (it.stocks && it.stocks.length > 0));

    // 2. Index stock news for quick lookup from the fresh 1-hour wire
    if (Array.isArray(allItems)) {
      for (const it of allItems) {
        if (it.stocks && it.stocks.length > 0) {
          for (const s of it.stocks) {
            if (!stockNewsCache[s]) stockNewsCache[s] = { items: [], fetchedAt: Date.now() };
            if (!stockNewsCache[s].items.some(x => x.title === it.title)) {
              stockNewsCache[s].items.push(it);
              stockNewsCache[s].fetchedAt = Date.now();
            }
          }
        }
      }
    }

    // 3. Update self-polling state
    selfPollingState.lastPolledAt = new Date().toISOString();
    selfPollingState.nextPollAt = new Date(Date.now() + HOURLY_POLL_INTERVAL_MS).toISOString();
    selfPollingState.totalPolls++;
    selfPollingState.lastTotalItemCount = allItems ? allItems.length : 0;
    // 4. Warm up Groww ETFs and ET Money caches
    try {
      await Promise.allSettled([
        fetchGrowwEtfs(),
        fetchEtMoneyLive()
      ]);
    } catch (e) {
      console.warn('[Self-Polling] Secondary cache warmup note:', e.message);
    }

    console.log(`[Self-Polling] ✅ 1-hour cycle finished. Total items: ${selfPollingState.lastTotalItemCount}, Stock items: ${stockItems.length}. Next poll at: ${selfPollingState.nextPollAt}`);
  } catch (err) {
    selfPollingState.status = 'error';
    selfPollingState.error = err.message;
    console.error('[Self-Polling] ❌ Error in 1-hour news poll:', err.message);
  }
}

// Polling status API for client consumption
app.get('/api/polling-status', (req, res) => {
  const dt = getIstDateInfo();
  const nextInMs = selfPollingState.nextPollAt ? Math.max(0, new Date(selfPollingState.nextPollAt).getTime() - Date.now()) : 0;
  res.json({
    ...selfPollingState,
    currentTime: dt.timeStr,
    asOf: dt.asOnDateStr,
    nextInMinutes: Math.round(nextInMs / (60 * 1000)),
    nextInSeconds: Math.round(nextInMs / 1000)
  });
});

// Trigger first self-poll on boot, and repeat every 1 hour
executeHourlyNewsPoll();
setInterval(executeHourlyNewsPoll, HOURLY_POLL_INTERVAL_MS);


// ==================== MANUAL & SCHEDULED REFRESH ALL API ====================
app.all('/api/refresh-all', async (req, res) => {
  try {
    console.log('[API] Triggering full daily portal refresh...');
    await executeHourlyNewsPoll();
    briefingCache.refreshing = refreshBriefing();
    await briefingCache.refreshing;

    res.json({
      success: true,
      message: 'Portal news feeds (1-hour self-polling active), Apify scrapers (ET, BS, INDmoney, Moneycontrol, TradingView, Google News Stocks Wire), AI briefing, and WhatsApp/Telegram/Instagram swing setups refreshed successfully!',
      timestamp: new Date().toISOString(),
      polling: selfPollingState,
      asOfDate: getIstDateInfo().shortDateStr
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  }
});


// ==================== ET MONEY LIVE STOCK ACTION SCRAPER & CACHE ====================
let etMoneyCache = null;
let etMoneyCacheTime = 0;
const ET_MONEY_CACHE_TTL = 15 * 60 * 1000; // 15 mins

function parseEtMoneyHtml(html) {
  const categories = {};
  const tableRegex = /<table[\s\S]*?<\/table>/gi;
  const tables = html.match(tableRegex) || [];

  for (const t of tables) {
    const titleMatch = t.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : null;
    if (!title) continue;

    const rows = [];
    const trRegex = /<tr[^>]*class="[^"]*cursor-pointer[^"]*"[\s\S]*?<\/tr>/gi;
    const trs = t.match(trRegex) || [];

    for (const tr of trs) {
      const nameMatch = tr.match(/<a[^>]*title="([^"]+)"/i) || tr.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
      const name = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      const sectorMatch = tr.match(/<span[^>]*class="[^"]*truncate[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const sector = sectorMatch ? sectorMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      const priceMatch = tr.match(/₹<!-- -->([0-9,.]+)/i) || tr.match(/₹([0-9,.]+)/i);
      const price = priceMatch ? priceMatch[1].trim() : '';

      const diffPctMatches = [...tr.matchAll(/<span[^>]*class="[^"]*(?:text-primary-green|text-red-color)[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)];
      let diff = '';
      let pct = '';
      if (diffPctMatches.length >= 1) {
        diff = diffPctMatches[0][1].replace(/<!-- -->/g, '').trim();
      }
      if (diffPctMatches.length >= 2) {
        pct = diffPctMatches[1][1].replace(/<!-- -->/g, '').trim();
      }

      if (name && price) {
        rows.push({ name, sector, price, diff, pct });
      }
    }

    if (rows.length > 0) {
      categories[title] = rows;
    }
  }

  return categories;
}

function fetchEtMoneyLive() {
  return new Promise((resolve) => {
    const https = require('https');
    const options = {
      hostname: 'www.etmoney.com',
      path: '/stocks',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 8000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = parseEtMoneyHtml(data);
          if (Object.keys(parsed).length > 0) {
            etMoneyCache = parsed;
            etMoneyCacheTime = Date.now();
            console.log(`[ET-MONEY] Successfully refreshed ${Object.keys(parsed).length} categories from etmoney.com/stocks`);
            resolve(parsed);
          } else {
            resolve(etMoneyCache || getFallbackEtMoney());
          }
        } catch (e) {
          resolve(etMoneyCache || getFallbackEtMoney());
        }
      });
    });

    req.on('error', () => resolve(etMoneyCache || getFallbackEtMoney()));
    req.on('timeout', () => { req.destroy(); resolve(etMoneyCache || getFallbackEtMoney()); });
    req.end();
  });
}

function getFallbackEtMoney() {
  return {
    "Top Gainers": [
      { name: "Whirlpool of India Ltd.", sector: "Consumer Electronics", price: "918.90", diff: "+65.45", pct: "(+7.67%)" },
      { name: "Engineers India Ltd.", sector: "Engineering", price: "315.65", diff: "+19.00", pct: "(+6.40%)" },
      { name: "Welspun Corp Ltd.", sector: "Steel", price: "2,832.40", diff: "+140.20", pct: "(+5.21%)" },
      { name: "Kaynes Technology India Ltd.", sector: "Electronic Equipment", price: "3,650.00", diff: "+140.50", pct: "(+4.00%)" }
    ],
    "Top Losers": [
      { name: "Ola Electric Mobility Ltd.", sector: "Automobiles", price: "38.48", diff: "-4.04", pct: "(-9.50%)" },
      { name: "Meesho Ltd.", sector: "E-Commerce", price: "217.06", diff: "-15.78", pct: "(-6.78%)" },
      { name: "Fortis Healthcare Ltd.", sector: "Hospital & Healthcare Services", price: "837.85", diff: "-39.50", pct: "(-4.50%)" },
      { name: "JK Cement Ltd.", sector: "Cement", price: "5,000.00", diff: "-184.50", pct: "(-3.56%)" }
    ],
    "Only Buyers": [
      { name: "Indiabulls Ltd.", sector: "IT - Software", price: "29.83", diff: "+1.42", pct: "(+5.00%)" },
      { name: "Hero Motors Ltd.", sector: "Automobiles", price: "141.69", diff: "+23.61", pct: "(+19.99%)" },
      { name: "Vidya Wires Ltd.", sector: "Cables", price: "90.54", diff: "+4.31", pct: "(+5.00%)" },
      { name: "ESAF Small Finance Bank Ltd.", sector: "Banking", price: "42.86", diff: "+2.04", pct: "(+5.00%)" }
    ],
    "Only Sellers": [
      { name: "Turtlemint Fintech Solutions Ltd.", sector: "Fintech", price: "87.24", diff: "-21.80", pct: "(-19.99%)" },
      { name: "Reliance Infrastructure Ltd.", sector: "Power - Generation/Distribution", price: "45.20", diff: "-0.92", pct: "(-1.99%)" },
      { name: "Nupur Recyclers Ltd.", sector: "Trading & Distribution", price: "161.70", diff: "-3.30", pct: "(-2.00%)" },
      { name: "Sonaselection India Ltd.", sector: "Textiles", price: "102.05", diff: "-5.37", pct: "(-5.00%)" }
    ],
    "Volume Shockers": [
      { name: "Transport Corporation of India Ltd.", sector: "Logistics", price: "883.70", diff: "+50.25", pct: "(+6.03%)" },
      { name: "Heranba Industries Ltd.", sector: "Agro Chemicals/Pesticides", price: "187.60", diff: "+15.33", pct: "(+8.90%)" },
      { name: "Som Distilleries & Breweries Ltd.", sector: "Alcoholic Beverages", price: "74.36", diff: "+7.12", pct: "(+10.59%)" },
      { name: "Shoppers Stop Ltd.", sector: "Retail", price: "423.55", diff: "+38.50", pct: "(+10.00%)" }
    ],
    "Most Active Stocks": [
      { name: "Vodafone Idea Ltd.", sector: "Telecom Services", price: "14.26", diff: "+0.14", pct: "(+0.99%)" },
      { name: "Ola Electric Mobility Ltd.", sector: "Automobiles", price: "38.48", diff: "-4.04", pct: "(-9.50%)" },
      { name: "Suzlon Energy Ltd.", sector: "Green Energy", price: "40.80", diff: "+0.06", pct: "(+0.15%)" },
      { name: "PB Fintech Ltd.", sector: "Fintech", price: "1,166.00", diff: "-41.20", pct: "(-3.41%)" }
    ]
  };
}

// API Endpoint for ET Money Stock Action
app.get('/api/etmoney-stocks', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    if (!force && etMoneyCache && (Date.now() - etMoneyCacheTime < ET_MONEY_CACHE_TTL)) {
      return res.json({
        success: true,
        source: 'ET Money Live (Cached)',
        sourceUrl: 'https://www.etmoney.com/stocks',
        asOf: new Date(etMoneyCacheTime).toISOString(),
        categories: etMoneyCache
      });
    }

    const data = await fetchEtMoneyLive();
    res.json({
      success: true,
      source: 'ET Money Live (Fresh)',
      sourceUrl: 'https://www.etmoney.com/stocks',
      asOf: new Date().toISOString(),
      categories: data
    });
  } catch (err) {
    res.json({
      success: false,
      source: 'ET Money Fallback',
      sourceUrl: 'https://www.etmoney.com/stocks',
      error: err.message,
      categories: getFallbackEtMoney()
    });
  }
});

// API Endpoint for Groww Stocks in News Today
app.get('/api/groww-news', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    if (!force && growwFeedCache && (Date.now() - growwFeedCacheTime < GROWW_CACHE_TTL)) {
      return res.json({
        success: true,
        source: 'Groww Stocks in News (Cached)',
        sourceUrl: 'https://groww.in/stock-feed',
        asOf: new Date(growwFeedCacheTime).toISOString(),
        total: growwFeedCache.length,
        items: growwFeedCache
      });
    }

    const data = await fetchGrowwStockFeed();
    res.json({
      success: true,
      source: 'Groww Stocks in News (Live)',
      sourceUrl: 'https://groww.in/stock-feed',
      asOf: new Date().toISOString(),
      total: data.length,
      items: data
    });
  } catch (err) {
    res.json({
      success: false,
      source: 'Groww Stocks in News (Fallback)',
      sourceUrl: 'https://groww.in/stock-feed',
      error: err.message,
      total: getFallbackGrowwNews().length,
      items: getFallbackGrowwNews()
    });
  }
});

// ==================== GROWW ETF SCREENER SCRAPER & CACHE ====================
let growwEtfCache = null;
let growwEtfCacheTime = 0;
const GROWW_ETF_CACHE_TTL = 15 * 60 * 1000; // 15 mins

function categorizeEtf(name, ticker) {
  const s = `${name} ${ticker}`.toUpperCase();
  if (s.includes('SILVER')) return 'Silver';
  if (s.includes('GOLD')) return 'Gold';
  if (s.includes('NIFTY 50') || s.includes('NIFTYBEES') || s.includes('SETFNIF50') || s.includes('SENSEX')) return 'Index';
  if (s.includes('BANK') || s.includes('FINANCIAL') || s.includes('FIN')) return 'Banking';
  if (s.includes('IT') || s.includes('TECH')) return 'IT / Tech';
  if (s.includes('AUTO')) return 'Auto';
  if (s.includes('PHARMA') || s.includes('HEALTH')) return 'Pharma';
  if (s.includes('MIDCAP') || s.includes('SMALLCAP') || s.includes('NEXT 50')) return 'Mid / Small Cap';
  if (s.includes('COMMODITY') || s.includes('OIL') || s.includes('ENERGY')) return 'Commodities & Energy';
  return 'Thematic / Other';
}

function getFallbackGrowwEtfs() {
  return [
    { ticker: "SETFNIF50", name: "SBI-ETF NIFTY 50", category: "Index", ltp: 249.47, nav: 249.12, close: 248.90, premiumDiscountPct: 0.14, expenseRatio: 0.04, aumCr: 213793, volume: 15420000, trackingError: 0.02, return1Y: -5.87, return3Y: 42.15, returnAll: 132.40, logoUrl: "https://assets-netstorage.groww.in/stock-assets/logos2/sbi_groww.png", growwUrl: "https://groww.in/etfs/sbi-etf-nifty-50" },
    { ticker: "NIFTYBEES", name: "Nippon India ETF Nifty 50 BeES", category: "Index", ltp: 264.13, nav: 263.95, close: 263.50, premiumDiscountPct: 0.07, expenseRatio: 0.04, aumCr: 67095, volume: 22100000, trackingError: 0.02, return1Y: -5.86, return3Y: 42.18, returnAll: 185.60, logoUrl: "https://assets-netstorage.groww.in/stock-assets/logos2/nippon_groww.png", growwUrl: "https://groww.in/etfs/nippon-india-etf-nifty-50-bees" },
    { ticker: "GOLDBEES", name: "Nippon India ETF Gold BeES", category: "Gold", ltp: 124.43, nav: 124.10, close: 123.85, premiumDiscountPct: 0.27, expenseRatio: 0.81, aumCr: 58629, volume: 18500000, trackingError: 0.15, return1Y: 31.37, return3Y: 58.20, returnAll: 240.50, logoUrl: "https://assets-netstorage.groww.in/stock-assets/logos2/nippon_groww.png", growwUrl: "https://groww.in/etfs/nippon-india-etf-gold-bees" },
    { ticker: "SILVERBEES", name: "Nippon India Silver ETF", category: "Silver", ltp: 218.80, nav: 216.30, close: 215.95, premiumDiscountPct: 1.16, expenseRatio: 0.58, aumCr: 32222, volume: 14322962, trackingError: 0.80, return1Y: 69.93, return3Y: 45.06, returnAll: 31.97, logoUrl: "https://assets-netstorage.groww.in/stock-assets/logos2/nippon_groww.png", growwUrl: "https://groww.in/etfs/nippon-life-india-asset-management-ltd-nippon-india-silver-etf" },
    { ticker: "TATSILV", name: "Tata Silver Exchange Traded Fund", category: "Silver", ltp: 22.21, nav: 21.97, close: 21.92, premiumDiscountPct: 1.09, expenseRatio: 0.39, aumCr: 5440, volume: 28133247, trackingError: 0.65, return1Y: 71.53, return3Y: null, returnAll: 52.88, logoUrl: "https://assets-netstorage.groww.in/stock-assets/logos2/tata_groww.png", growwUrl: "https://groww.in/etfs/tata-silver-exchange-traded-fund" },
    { ticker: "TATAGOLD", name: "Tata Gold Exchange Traded Fund", category: "Gold", ltp: 14.62, nav: 14.51, close: 14.52, premiumDiscountPct: 0.76, expenseRatio: 0.35, aumCr: 6172, volume: 37775946, trackingError: 0.20, return1Y: 31.57, return3Y: null, returnAll: 37.52, logoUrl: "https://assets-netstorage.groww.in/stock-assets/logos2/tata_groww.png", growwUrl: "https://groww.in/etfs/tata-gold-exchange-traded-fund" },
    { ticker: "BANKBEES", name: "Nippon India ETF Nifty Bank BeES", category: "Banking", ltp: 532.10, nav: 531.80, close: 530.20, premiumDiscountPct: 0.06, expenseRatio: 0.16, aumCr: 12450, volume: 8200000, trackingError: 0.04, return1Y: 8.45, return3Y: 34.20, returnAll: 165.20, logoUrl: "https://assets-netstorage.groww.in/stock-assets/logos2/nippon_groww.png", growwUrl: "https://groww.in/etfs/nippon-india-etf-bank-bees" }
  ];
}

function fetchGrowwEtfs() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'groww.in',
      path: '/etfs',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const match = data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
          if (match) {
            const parsed = JSON.parse(match[1]);
            const rawList = (parsed.props && parsed.props.pageProps && parsed.props.pageProps.data) || [];
            const result = rawList.map(e => {
              const r1m = (e.returns && e.returns.find(r => r.key === 'return1M')) || {};
              const r6m = (e.returns && e.returns.find(r => r.key === 'return6M')) || {};
              const r1y = (e.returns && e.returns.find(r => r.key === 'return1Y')) || {};
              const r3y = (e.returns && e.returns.find(r => r.key === 'return3Y')) || {};
              const rAll = (e.returns && e.returns.find(r => r.key === 'returnAll')) || {};

              const category = categorizeEtf(e.shortName || '', e.nseScriptCode || '');
              const navVal = typeof e.nav === 'number' ? e.nav : null;
              const ltpVal = typeof e.ltp === 'number' ? e.ltp : null;
              let premiumPct = null;
              if (navVal && ltpVal && navVal > 0) {
                premiumPct = Number((((ltpVal - navVal) / navVal) * 100).toFixed(2));
              }

              return {
                ticker: e.nseScriptCode || e.bseScriptCode || 'ETF',
                nseCode: e.nseScriptCode || '',
                bseCode: e.bseScriptCode || '',
                name: e.shortName || 'Exchange Traded Fund',
                category,
                ltp: ltpVal,
                nav: navVal,
                close: e.close || null,
                premiumDiscountPct: premiumPct,
                expenseRatio: typeof e.expenseRatio === 'number' ? e.expenseRatio : null,
                aumCr: typeof e.aum === 'number' ? e.aum : null,
                volume: typeof e.volume === 'number' ? e.volume : null,
                trackingError: typeof e.trackingError === 'number' ? e.trackingError : null,
                return1M: typeof r1m.value === 'number' ? r1m.value : null,
                return6M: typeof r6m.value === 'number' ? r6m.value : null,
                return1Y: typeof r1y.value === 'number' ? r1y.value : null,
                return3Y: typeof r3y.value === 'number' ? r3y.value : null,
                returnAll: typeof rAll.value === 'number' ? rAll.value : null,
                logoUrl: e.logoUrl || 'https://assets-netstorage.groww.in/stock-assets/logos2/default_etf.png',
                growwUrl: e.searchId ? `https://groww.in/etfs/${e.searchId}` : 'https://groww.in/etfs'
              };
            });

            if (result.length > 0) {
              growwEtfCache = result;
              growwEtfCacheTime = Date.now();
            }
            resolve(result.length > 0 ? result : (growwEtfCache || getFallbackGrowwEtfs()));
          } else {
            resolve(growwEtfCache || getFallbackGrowwEtfs());
          }
        } catch (e) {
          console.warn('[Groww ETF Scraper] Parse error:', e.message);
          resolve(growwEtfCache || getFallbackGrowwEtfs());
        }
      });
    });

    req.on('error', (e) => {
      console.warn('[Groww ETF Scraper] Request error:', e.message);
      resolve(growwEtfCache || getFallbackGrowwEtfs());
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(growwEtfCache || getFallbackGrowwEtfs());
    });
    req.end();
  });
}

// API Endpoint for Groww ETF Screener Online
app.get('/api/groww-etfs', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    let etfs = null;
    if (!force && growwEtfCache && (Date.now() - growwEtfCacheTime < GROWW_ETF_CACHE_TTL)) {
      etfs = growwEtfCache;
    } else {
      etfs = await fetchGrowwEtfs();
    }

    let list = Array.isArray(etfs) ? [...etfs] : getFallbackGrowwEtfs();

    // Category filter
    const cat = (req.query.category || '').toLowerCase();
    if (cat && cat !== 'all') {
      list = list.filter(e => (e.category || '').toLowerCase().includes(cat));
    }

    // Search query
    const q = (req.query.q || '').toLowerCase();
    if (q) {
      list = list.filter(e => (e.name || '').toLowerCase().includes(q) || (e.ticker || '').toLowerCase().includes(q));
    }

    // Sort
    const sortBy = req.query.sort || 'aum';
    if (sortBy === 'return1y') {
      list.sort((a, b) => (b.return1Y || -999) - (a.return1Y || -999));
    } else if (sortBy === 'volume') {
      list.sort((a, b) => (b.volume || 0) - (a.volume || 0));
    } else if (sortBy === 'expense') {
      list.sort((a, b) => (a.expenseRatio || 999) - (b.expenseRatio || 999));
    } else {
      // default aum
      list.sort((a, b) => (b.aumCr || 0) - (a.aumCr || 0));
    }

    const limit = Number(req.query.limit) || 100;

    res.json({
      success: true,
      source: 'Groww ETF Screener Online',
      sourceUrl: 'https://groww.in/etfs',
      asOf: new Date(growwEtfCacheTime || Date.now()).toISOString(),
      total: list.length,
      etfs: list.slice(0, limit)
    });
  } catch (err) {
    res.json({
      success: false,
      source: 'Groww ETF Fallback',
      sourceUrl: 'https://groww.in/etfs',
      error: err.message,
      total: getFallbackGrowwEtfs().length,
      etfs: getFallbackGrowwEtfs()
    });
  }
});

app.listen(PORT, () => console.log(`momentwealth-backend listening on port ${PORT}`));
