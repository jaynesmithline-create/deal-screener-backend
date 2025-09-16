Here’s a single drop-in replacement for **`edgar-otc-backend.ts`**. Copy **all** of this, replace your file’s contents, commit, and Render will rebuild.

```ts
// edgar-otc-backend.ts — Daily refreshed search API (SEC EDGAR + OTC stub)
// ----------------------------------------------------------------------
// WHAT THIS DOES
// - Refreshes a daily snapshot every morning (6:30 AM America/New_York)
// - Pulls key fundamentals from SEC EDGAR companyfacts (Revenue, CFO, Debt, AP)
// - Estimates last fundraising date from submissions (424B*, S-1/S-3, 8-K, Form D)
// - Tries to infer company location from submissions (state/country)
// - Serves /api/search so your web UI can filter companies by your criteria
//
// QUICK START (local dev)
//   node >= 18 is required (global fetch)
//   npm i express cors node-cron zod
//   npm i -D typescript ts-node @types/express @types/node @types/cors @types/node-cron
//   npx tsc --init
//   SEC_UA=<you@yourfirm.com> TZ=America/New_York PORT=4000 npx ts-node edgar-otc-backend.ts
//
// RENDER SETTINGS
//   Build:  npm install && npm run build
//   Start:  npm run start
//   Env:    TZ=America/New_York   SEC_UA=you@yourfirm.com   UNIVERSE_LIMIT=300
// ----------------------------------------------------------------------

import express from "express";
import cors from "cors";
import cron from "node-cron";
import { z } from "zod";

const PORT = process.env.PORT || 4000;
const TIMEZONE = "America/New_York";
const SEC_UA = process.env.SEC_UA || "contact@yourfirm.com";
const UNIVERSE_LIMIT = Number(process.env.UNIVERSE_LIMIT || 300); // how many tickers to scan daily

// ---------------- Types ----------------

type Exchange = "NYSE" | "NASDAQ" | "OTC" | "PRIVATE";

type Company = {
  ticker?: string;
  cik?: string; // 10-digit zero-padded
  name: string;
  exchange: Exchange;
  location?: string; // state or country (best effort)
  revenueLTMUSD?: number;
  cfoLTMUSD?: number; // cash flow from ops (LTM-ish, most recent USD value)
  totalDebtUSD?: number; // LT debt + ST debt
  accountsPayableUSD?: number;
  advUSD?: number; // avg daily $ volume (OTC stub for now)
  marketCapUSD?: number;
  lastFundraisingDate?: string; // YYYY-MM-DD (best effort)
};

type Snapshot = { date: string; items: Company[] };

let SNAPSHOT: Snapshot = { date: "", items: [] };
let UNIVERSE: { ticker: string; cik?: string; exchange: Exchange; name?: string }[] = [];

// ---------------- Helpers ----------------

function todayET(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p = fmt.formatToParts(new Date());
  const y = p.find((x) => x.type === "year")!.value;
  const m = p.find((x) => x.type === "month")!.value;
  const d = p.find((x) => x.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

function padCIK(raw: string) {
  return raw.padStart(10, "0");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function secJSON(url: string) {
  const res = await fetch(url, {
    headers: { "User-Agent": SEC_UA, Accept: "application/json" } as any,
  });
  if (!res.ok) throw new Error(`SEC fetch ${res.status} ${url}`);
  return res.json();
}

function classifyExchange(ticker: string): Exchange {
  const t = ticker.toUpperCase();
  // Heuristics: 5-char tickers or those with '.' or ending 'F' → often OTC
  if (t.length === 5 || t.includes(".") || t.endsWith("F")) return "OTC";
  return "NASDAQ"; // we don't get exchange in SEC mapping; treat as NASDAQ by default
}

// Build a larger ticker universe from SEC's mapping file
async function buildUniverse(): Promise<
  { ticker: string; cik?: string; exchange: Exchange; name?: string }[]
> {
  const data = await secJSON("https://www.sec.gov/files/company_tickers.json");
  const rows = Object.keys(data).map((k) => data[k]) as Array<{
    cik: number;
    ticker: string;
    title: string;
  }>;

  // Take the first N (keep light for free tier)
  return rows.slice(0, UNIVERSE_LIMIT).map((r) => ({
    ticker: r.ticker.toUpperCase(),
    cik: padCIK(String(r.cik)),
    exchange: classifyExchange(r.ticker),
    name: r.title,
  }));
}

// Pull XBRL company facts for a CIK; extract core metrics
async function pullFacts(cik: string): Promise<Partial<Company>> {
  try {
    const facts = await secJSON(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`
    );
    const usgaap = facts.facts?.["us-gaap"] || {};
    const pickUSD = (tag: string) => {
      const arr = (usgaap[tag]?.units?.USD as any[]) || [];
      if (!arr.length) return undefined;
      // most recent by end date
      const sorted = [...arr].sort((a, b) =>
        String(b.end || "").localeCompare(String(a.end || ""))
      );
      const val = Number(sorted[0]?.val);
      return Number.isFinite(val) ? val : undefined;
    };

    const revenue =
      pickUSD("Revenues") ??
      pickUSD("SalesRevenueNet") ??
      pickUSD("RevenueFromContractWithCustomerExcludingAssessedTax");
    const cfo = pickUSD("NetCashProvidedByUsedInOperatingActivities");
    const ltd =
      pickUSD("LongTermDebtNoncurrent") ?? pickUSD("LongTermDebt") ?? 0;
    const std =
      pickUSD("ShortTermBorrowings") ?? pickUSD("DebtCurrent") ?? 0;
    const ap = pickUSD("AccountsPayableCurrent");

    return {
      revenueLTMUSD: revenue,
      cfoLTMUSD: cfo,
      totalDebtUSD: (ltd || 0) + (std || 0),
      accountsPayableUSD: ap,
    };
  } catch {
    return {};
  }
}

// Fetch submissions once; derive both location and last fundraising date
async function fetchSubmissions(cik: string): Promise<any | undefined> {
  try {
    return await secJSON(`https://data.sec.gov/submissions/CIK${cik}.json`);
  } catch {
    return undefined;
  }
}

function estimateLocationFromSubs(subs: any): string | undefined {
  if (!subs) return undefined;
  const loc =
    subs?.stateOfIncorporation ||
    subs?.addresses?.business?.stateOrCountry ||
    subs?.addresses?.mailing?.stateOrCountry ||
    subs?.stateOfIncorporationDescription;
  return typeof loc === "string" ? loc : undefined;
}

function estimateLastFundraisingDateFromSubs(subs: any): string | undefined {
  if (!subs) return undefined;
  const forms: string[] = subs.filings?.recent?.form || [];
  const dates: string[] = subs.filings?.recent?.filingDate || [];
  let best: string | undefined;
  for (let i = 0; i < forms.length; i++) {
    const f = String(forms[i]).toUpperCase();
    // Common fundraising-related forms
    if (/^(424B\d|8-K|S-1|S-3|D)$/.test(f)) {
      const dt = dates[i];
      if (!best || dt > best) best = dt;
    }
  }
  return best; // YYYY-MM-DD
}

// OTC markets daily dollar volume (stub). Replace with your OTCMarkets provider later.
async function pullOTCVolumeUSD(_ticker: string): Promise<number | undefined> {
  return undefined;
}

// ---------------- Snapshot refresh ----------------

async function refreshSnapshot(): Promise<Snapshot> {
  const date = todayET();

  if (UNIVERSE.length === 0) {
    try {
      UNIVERSE = await buildUniverse();
      console.log(`[universe] loaded ${UNIVERSE.length} tickers`);
    } catch (e) {
      console.error("universe load failed", e);
      // fallback tiny universe if SEC mapping fails
      UNIVERSE = [
        { ticker: "VCTR", exchange: "NASDAQ" },
        { ticker: "HBRF", exchange: "NYSE" },
        { ticker: "EDEN", exchange: "OTC" },
        { ticker: "QMIN", exchange: "OTC" },
      ];
    }
  }

  const out: Company[] = [];

  for (const u of UNIVERSE) {
    const cik = u.cik;
    const name = u.name || u.ticker;
    let facts: Partial<Company> = {};
    let subs: any | undefined;

    if (cik) {
      // Be polite to SEC - tiny delay between requests
      await sleep(120);
      facts = await pullFacts(cik);
      await sleep(80);
      subs = await fetchSubmissions(cik);
    }

    const advUSD =
      u.exchange === "OTC" ? await pullOTCVolumeUSD(u.ticker) : undefined;

    out.push({
      ticker: u.ticker,
      cik,
      name,
      exchange: u.exchange,
      location: estimateLocationFromSubs(subs),
      lastFundraisingDate: estimateLastFundraisingDateFromSubs(subs),
      advUSD,
      ...facts,
    });
  }

  SNAPSHOT = { date, items: out };
  console.log(`[snapshot ${date}] companies=${out.length}`);
  return SNAPSHOT;
}

// initial & scheduled daily refresh
refreshSnapshot().catch(console.error);
cron.schedule(
  "30 6 * * *",
  () => {
    refreshSnapshot().catch(console.error);
  },
  { timezone: TIMEZONE }
);

// ---------------- Express API ----------------

const app = express();
app.use(cors());
app.use(express.json());

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

app.get("/", (_req, res) => {
  res
    .type("text/html")
    .send(`
    <h2>EDGAR+OTC Deal Screener API</h2>
    <p>Daily snapshot (6:30am ET). Try:</p>
    <ul>
      <li><a href="/api/health">/api/health</a></li>
      <li><a href="/api/search?exchanges=NYSE,NASDAQ,OTC">/api/search?exchanges=NYSE,NASDAQ,OTC</a></li>
      <li><a href="/api/search?exchanges=NASDAQ,OTC&revenue_min=10000000">/api/search with filters</a></li>
    </ul>`);
});

app.get("/api/health", (_req, res) => res.json({ ok: true, date: SNAPSHOT.date }));

app.post("/api/refresh", async (_req, res) => {
  const snap = await refreshSnapshot();
  res.json({ ok: true, date: snap.date, count: snap.items.length });
});

function ensureFresh() {
  return async (_req: any, _res: any, next: any) => {
    try {
      if (SNAPSHOT.date !== todayET()) {
        await refreshSnapshot();
      }
    } catch (e) {
      console.error("ensureFresh error", e);
    } finally {
      next();
    }
  };
}

app.get("/api/search", ensureFresh(), (req, res) => {
  const q = Q.safeParse(req.query);
  if (!q.success) {
    return res.status(400).json({ error: "bad query", details: q.error.flatten() });
  }
  const p = q.data;
  const exAllowed = p.exchanges
    ? (p.exchanges.split(",").map((s) => s.trim().toUpperCase()) as Exchange[])
    : undefined;

  const filtered = SNAPSHOT.items.filter((c) => {
    if (exAllowed && !exAllowed.includes(c.exchange)) return false;
    if (p.location && (c.location || "").toLowerCase() !== p.location.toLowerCase()) return false;
    if (p.revenue_min != null && (c.revenueLTMUSD ?? -Infinity) < p.revenue_min) return false;
    if (p.revenue_max != null && (c.revenueLTMUSD ?? Infinity) > p.revenue_max) return false;
    if (p.cfo_min != null && (c.cfoLTMUSD ?? -Infinity) < p.cfo_min) return false;
    if (p.debt_max != null && (c.totalDebtUSD ?? Infinity) > p.debt_max) return false;
    if (p.ap_max != null && (c.accountsPayableUSD ?? Infinity) > p.ap_max) return false;
    if (p.adv_min != null && (c.advUSD ?? 0) < p.adv_min) return false;
    return true;
  });

  res.json({ date: SNAPSHOT.date, count: filtered.length, items: filtered });
});

app.listen(PORT, () =>
  console.log(`EDGAR+OTC backend on :${PORT}, daily 6:30am ET refresh`)
);
```
