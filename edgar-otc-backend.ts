// edgar-otc-backend.ts — Daily refreshed search API (SEC EDGAR + OTC stub)
// ---------------------------------------------------------------
// WHAT THIS DOES
// - Refreshes a daily snapshot every morning (6:30 AM America/New_York)
// - Pulls key fundamentals from SEC EDGAR (Revenue, CFO, Debt, Accounts Payable)
// - Estimates last fundraising date from recent submissions (424B*, S-1/S-3, 8-K, Form D)
// - Serves /api/search so your web UI can filter companies by your criteria
//
// QUICK START (local dev)
// 1) Ensure Node.js 18+ is installed (https://nodejs.org)
// 2) In an empty folder, run:
//      npm init -y
//      npm i express cors node-cron zod
//      npm i -D typescript ts-node @types/express @types/node
//      npx tsc --init
// 3) Create this file as edgar-otc-backend.ts and paste this entire content.
// 4) Run it:
//      export TZ=America/New_York
//      export PORT=4000
//      export SEC_UA="yourname@yourfirm.com"   // SEC asks for a descriptive User-Agent
//      npx ts-node edgar-otc-backend.ts
// 5) Test in a browser:
//      http://localhost:4000/api/search?exchanges=NYSE,NASDAQ,OTC&revenue_min=100000000
//
// DEPLOY (Render)
// - Build command:  npm install && npm run build
// - Start command:  npm run start
// - Add env vars:   TZ=America/New_York  SEC_UA=yourname@yourfirm.com
// - See the step-by-step guide I’ll send after this file.
// ---------------------------------------------------------------

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { z } from 'zod';

// Node 18+ has global fetch; if not available, install node-fetch and import it.

const PORT = process.env.PORT || 4000;
const TIMEZONE = 'America/New_York';
const SEC_UA = process.env.SEC_UA || 'contact@yourfirm.com';

// ---------------- Types ----------------

type Exchange = 'NYSE' | 'NASDAQ' | 'OTC' | 'PRIVATE';

type Company = {
  ticker?: string;
  cik?: string;               // 10-digit zero-padded
  name: string;
  exchange: Exchange;
  location?: string;          // optional: state or country code
  revenueLTMUSD?: number;
  cfoLTMUSD?: number;         // cash flow from operations (LTM)
  totalDebtUSD?: number;      // long-term + short-term
  accountsPayableUSD?: number;
  advUSD?: number;            // avg daily dollar volume (approx) — OTC stubbed
  marketCapUSD?: number;
  lastFundraisingDate?: string; // YYYY-MM-DD if detected
};

type Snapshot = { date: string; items: Company[] };
let SNAPSHOT: Snapshot = { date: '', items: [] };

// ------------- Helpers -------------

function todayET(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = fmt.formatToParts(new Date());
  const y = p.find(x=>x.type==='year')!.value, m = p.find(x=>x.type==='month')!.value, d = p.find(x=>x.type==='day')!.value;
  return `${y}-${m}-${d}`;
}

function padCIK(raw: string) { return raw.padStart(10, '0'); }

async function secJSON(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': SEC_UA, 'Accept': 'application/json' } as any });
  if (!res.ok) throw new Error(`SEC fetch ${res.status} ${url}`);
  return res.json();
}

// \!\! IMPORTANT: This is a tiny demo universe. Replace with a broader ticker list when ready.
// You can also persist to a DB. For now this keeps things simple and fast.
const UNIVERSE: {ticker: string; cik?: string; exchange: Exchange; name?: string; location?: string}[] = [
  { ticker: 'VCTR', exchange: 'NASDAQ' },
  { ticker: 'HBRF', exchange: 'NYSE' },
  { ticker: 'EDEN', exchange: 'OTC' },
  { ticker: 'QMIN', exchange: 'OTC' },
];

// Map ticker -> CIK (SEC publishes a mapping JSON). We keep it simple for now.
async function tickerToCIK(ticker: string): Promise<{cik?: string; name?: string}>
{ try {
    const data = await secJSON('https://www.sec.gov/files/company_tickers.json');
    for (const k of Object.keys(data)) {
      const row = data[k];
      if (row.ticker?.toUpperCase() === ticker.toUpperCase()) {
        return { cik: padCIK(String(row.cik)), name: row.title };
      }
    }
    return {};
  } catch { return {}; } }

// Pull XBRL company facts for a CIK; extract core metrics
async function pullFacts(cik: string): Promise<Partial<Company>> {
  try {
    const facts = await secJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
    const usgaap = facts.facts?.['us-gaap'] || {};
    const pickUSD = (tag: string) => {
      const arr = usgaap[tag]?.units?.USD as any[] | undefined;
      if (!arr || !arr.length) return undefined;
      const sorted = [...arr].sort((a,b) => (b.end||'').localeCompare(a.end||''));
      return Number(sorted[0]?.val);
    };
    const revenue = pickUSD('Revenues') ?? pickUSD('SalesRevenueNet');
    const cfo = pickUSD('NetCashProvidedByUsedInOperatingActivities');
    const ltd = pickUSD('LongTermDebtNoncurrent') ?? pickUSD('LongTermDebt');
    const std = pickUSD('ShortTermBorrowings') ?? pickUSD('DebtCurrent');
    const ap = pickUSD('AccountsPayableCurrent');
    return { revenueLTMUSD: revenue, cfoLTMUSD: cfo, totalDebtUSD: (ltd ?? 0) + (std ?? 0), accountsPayableUSD: ap };
  } catch (e) { return {}; }
}

// Estimate last fundraising date from recent submissions
// Signals: 424B*, 8-K, S-1, S-3, Form D (best-effort)
async function estimateLastFundraisingDate(cik?: string): Promise<string | undefined> {
  if (!cik) return undefined;
  try {
    const subs = await secJSON(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const forms: string[] = subs.filings?.recent?.form || [];
    const dates: string[] = subs.filings?.recent?.filingDate || [];
    let best: string | undefined;
    for (let i = 0; i < forms.length; i++) {
      const f = String(forms[i]).toUpperCase();
      if (/^(424B\d|8-K|S-1|S-3|D)$/.test(f)) {
        const dt = dates[i];
        if (!best || dt > best) best = dt;
      }
    }
    return best; // YYYY-MM-DD
  } catch { return undefined; }
}

// OTC markets daily dollar volume (stub). Replace with your OTCMarkets provider later.
async function pullOTCVolumeUSD(_ticker: string): Promise<number | undefined> {
  return undefined;
}

// Build the daily snapshot (lightweight demo)
async function refreshSnapshot(): Promise<Snapshot> {
  const date = todayET();
  const out: Company[] = [];
  for (const u of UNIVERSE) {
    let cik = u.cik; let name = u.name;
    if (!cik) { const m = await tickerToCIK(u.ticker); cik = m.cik; name = name || m.name; }
    const facts = cik ? await pullFacts(cik) : {};
    const advUSD = u.exchange === 'OTC' ? await pullOTCVolumeUSD(u.ticker) : undefined;
    const lastFundraisingDate = await estimateLastFundraisingDate(cik);
    out.push({
      ticker: u.ticker,
      cik,
      name: name || u.ticker,
      exchange: u.exchange,
      location: u.location,
      advUSD,
      lastFundraisingDate,
      ...facts,
    });
  }
  SNAPSHOT = { date, items: out };
  console.log(`[snapshot ${date}] companies=${out.length}`);
  return SNAPSHOT;
}

// Initial & daily 6:30am ET refresh
refreshSnapshot().catch(console.error);
cron.schedule('30 6 * * *', () => { refreshSnapshot().catch(console.error); }, { timezone: TIMEZONE });

// ---------------- API ----------------

const app = express();
app.use(cors());

const Q = z.object({
  revenue_min: z.coerce.number().optional(),
  revenue_max: z.coerce.number().optional(),
  cfo_min: z.coerce.number().optional(),
  debt_max: z.coerce.number().optional(),
  ap_max: z.coerce.number().optional(),
  adv_min: z.coerce.number().optional(),
  location: z.string().optional(),
  exchanges: z.string().optional(), // comma list e.g. "NYSE,NASDAQ,OTC"
});

app.get('/api/health', (_req, res) => res.json({ ok: true, date: SNAPSHOT.date }));

app.post('/api/refresh', async (_req, res) => {
  const snap = await refreshSnapshot();
  res.json({ ok: true, date: snap.date, count: snap.items.length });
});

app.get('/api/search', async (req, res) => {
  try {
    const q = Q.parse(req.query);
    if (SNAPSHOT.date !== todayET()) await refreshSnapshot();
    const exAllowed = q.exchanges ? q.exchanges.split(',').map(s=>s.trim().toUpperCase()) as Exchange[] : undefined;
    const filtered = SNAPSHOT.items.filter(c => {
      if (exAllowed && !exAllowed.includes(c.exchange)) return false;
      if (q.location && (c.location||'').toLowerCase() !== q.location.toLowerCase()) return false;
      if (q.revenue_min != null && (c.revenueLTMUSD ?? -Infinity) < q.revenue_min) return false;
      if (q.revenue_max != null && (c.revenueLTMUSD ?? Infinity) > q.revenue_max) return false;
      if (q.cfo_min != null && (c.cfoLTMUSD ?? -Infinity) < q.cfo_min) return false;
      if (q.debt_max != null && (c.totalDebtUSD ?? Infinity) > q.debt_max) return false;
      if (q.ap_max != null && (c.accountsPayableUSD ?? Infinity) > q.ap_max) return false;
      if (q.adv_min != null && (c.advUSD ?? 0) < q.adv_min) return false;
      return true;
    });
    res.json({ date: SNAPSHOT.date, count: filtered.length, items: filtered });
  } catch (e:any) {
    res.status(400).json({ error: e?.message || 'bad query' });
  }
});

app.listen(PORT, () => console.log(`EDGAR+OTC backend on :${PORT}, daily 6:30am ET refresh`));
