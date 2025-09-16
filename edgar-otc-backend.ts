// edgar-otc-backend.ts — Loan-fit screener (SEC EDGAR)
// ----------------------------------------------------
import express, { Request, Response, NextFunction, RequestHandler } from "express";
import cors from "cors";
import cron from "node-cron";
import { z } from "zod";

// --- Config ---
const PORT = Number(process.env.PORT || 4000);
const TIMEZONE = "America/New_York";
const SEC_UA = process.env.SEC_UA || "contact@yourfirm.com";
const UNIVERSE_LIMIT = Number(process.env.UNIVERSE_LIMIT || 300);

// --- Types ---
type Exchange = "NYSE" | "NASDAQ" | "OTC" | "PRIVATE";

type Company = {
  ticker?: string;
  cik?: string;
  name: string;
  exchange: Exchange;
  location?: string;

  // core
  revenueLTMUSD?: number;
  cfoLTMUSD?: number;
  totalDebtUSD?: number;
  accountsPayableUSD?: number;

  // assets for borrowing base
  arUSD?: number;
  inventoryUSD?: number;
  ppeUSD?: number;

  borrowingBaseUSD?: number;       // 80% AR + 50% INV + 25% PPE
  paybackYearsAtLoan?: number;     // computed per-request
  loanCoverage?: number;           // BB / loan_size

  advUSD?: number;                 // stub for now
  lastFundraisingDate?: string;
};

type Snapshot = { date: string; items: Company[] };
let SNAPSHOT: Snapshot = { date: "", items: [] };

let UNIVERSE: { ticker: string; cik?: string; exchange: Exchange; name?: string }[] = [];

// --- Helpers ---
function todayET(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = fmt.formatToParts(new Date());
  const y = p.find(x => x.type === "year")!.value;
  const m = p.find(x => x.type === "month")!.value;
  const d = p.find(x => x.type === "day")!.value;
  return `${y}-${m}-${d}`;
}
function padCIK(raw: string) { return raw.padStart(10, "0"); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function secJSON(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": SEC_UA, "Accept": "application/json" } as any });
  if (!res.ok) throw new Error(`SEC ${res.status} ${url}`);
  return res.json();
}
function classifyExchange(t: string): Exchange {
  const u = t.toUpperCase();
  if (u.length === 5 || u.includes(".") || u.endsWith("F")) return "OTC";
  return "NASDAQ";
}

async function buildUniverse() {
  const data = await secJSON("https://www.sec.gov/files/company_tickers.json");
  const rows = Object.keys(data).map(k => data[k]) as Array<{ cik: number; ticker: string; title: string }>;
  const CLEAN = rows.filter(r => !/(ETF|FUND|TRUST|ETN|ETP|INCOME|DIVIDEND)/i.test(r.title || ""));
  return CLEAN.slice(0, UNIVERSE_LIMIT).map(r => ({
    ticker: r.ticker.toUpperCase(),
    cik: padCIK(String(r.cik)),
    exchange: classifyExchange(r.ticker),
    name: r.title,
  }));
}

function pickUSDLatest(usgaap: any, tag: string): number | undefined {
  const arr = (usgaap?.[tag]?.units?.USD as any[]) || [];
  if (!arr.length) return undefined;
  const sorted = [...arr].sort((a, b) => String(b.end || "").localeCompare(String(a.end || "")));
  const v = Number(sorted[0]?.val);
  return Number.isFinite(v) ? v : undefined;
}

async function pullFacts(cik: string): Promise<Partial<Company>> {
  try {
    const facts = await secJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
    const usgaap = facts.facts?.["us-gaap"] || {};

    const revenue =
      pickUSDLatest(usgaap, "Revenues") ??
      pickUSDLatest(usgaap, "SalesRevenueNet") ??
      pickUSDLatest(usgaap, "RevenueFromContractWithCustomerExcludingAssessedTax");

    const cfo = pickUSDLatest(usgaap, "NetCashProvidedByUsedInOperatingActivities");

    const ltd = pickUSDLatest(usgaap, "LongTermDebtNoncurrent") ?? pickUSDLatest(usgaap, "LongTermDebt") ?? 0;
    const std = pickUSDLatest(usgaap, "ShortTermBorrowings") ?? pickUSDLatest(usgaap, "DebtCurrent") ?? 0;
    const ap  = pickUSDLatest(usgaap, "AccountsPayableCurrent");

    const ar  = pickUSDLatest(usgaap, "AccountsReceivableNetCurrent") ?? pickUSDLatest(usgaap, "AccountsReceivableNet");
    const inv = pickUSDLatest(usgaap, "InventoryNet") ?? pickUSDLatest(usgaap, "Inventory");
    const ppe = pickUSDLatest(usgaap, "PropertyPlantAndEquipmentNet");

    return {
      revenueLTMUSD: revenue,
      cfoLTMUSD: cfo,
      totalDebtUSD: (ltd || 0) + (std || 0),
      accountsPayableUSD: ap,
      arUSD: ar,
      inventoryUSD: inv,
      ppeUSD: ppe,
    };
  } catch {
    return {};
  }
}

async function fetchSubs(cik: string) {
  try { return await secJSON(`https://data.sec.gov/submissions/CIK${cik}.json`); } catch { return undefined; }
}
function subsLocation(subs: any): string | undefined {
  return subs?.stateOfIncorporation ||
         subs?.addresses?.business?.stateOrCountry ||
         subs?.addresses?.mailing?.stateOrCountry ||
         subs?.stateOfIncorporationDescription ||
         undefined;
}
function subsLastRaise(subs: any): string | undefined {
  const forms: string[] = subs?.filings?.recent?.form || [];
  const dates: string[] = subs?.filings?.recent?.filingDate || [];
  let best: string | undefined;
  for (let i = 0; i < forms.length; i++) {
    const f = String(forms[i]).toUpperCase();
    if (/^(424B\d|8-K|S-1|S-3|D)$/.test(f)) {
      const dt = dates[i];
      if (!best || dt > best) best = dt;
    }
  }
  return best;
}

async function pullOTCVolumeUSD(_t: string): Promise<number | undefined> {
  return undefined; // wire OTCMarkets API later
}

function borrowingBase(ar?: number, inv?: number, ppe?: number) {
  return (ar || 0) * 0.80 + (inv || 0) * 0.50 + (ppe || 0) * 0.25;
}

// --- Snapshot refresh ---
async function refreshSnapshot(): Promise<Snapshot> {
  const date = todayET();

  if (UNIVERSE.length === 0) {
    try {
      UNIVERSE = await buildUniverse();
      console.log(`[universe] ${UNIVERSE.length}`);
    } catch (e) {
      console.error("universe build failed", e);
      UNIVERSE = [{ ticker: "VCTR", exchange: "NASDAQ" }];
    }
  }

  const out: Company[] = [];
  for (const u of UNIVERSE) {
    const cik = u.cik;
    const name = u.name || u.ticker;

    let f: Partial<Company> = {};
    let subs: any | undefined;

    if (cik) {
      await sleep(120); f = await pullFacts(cik);
      await sleep(80);  subs = await fetchSubs(cik);
    }

    const bb = borrowingBase(f.arUSD, f.inventoryUSD, f.ppeUSD);

    out.push({
      ticker: u.ticker,
      cik,
      name,
      exchange: u.exchange,
      location: subsLocation(subs),
      lastFundraisingDate: subsLastRaise(subs),
      borrowingBaseUSD: bb,
      ...f,
      advUSD: u.exchange === "OTC" ? await pullOTCVolumeUSD(u.ticker) : undefined,
    });
  }

  SNAPSHOT = { date, items: out };
  console.log(`[snapshot ${date}] companies=${out.length}`);
  return SNAPSHOT;
}

// initial + daily 6:30am ET
refreshSnapshot().catch(console.error);
cron.schedule("30 6 * * *", () => { refreshSnapshot().catch(console.error); }, { timezone: TIMEZONE });

// --- Server & schema ---
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
  exchanges: z.string().optional(),

  // loan-fit (optional)
  loan_size: z.coerce.number().optional(),
  max_payback_years: z.coerce.number().optional(),
  min_borrow_base: z.coerce.number().optional(),
});

const homeHtml =
  '<h2>EDGAR Loan-Fit Screener</h2>' +
  "<p>Daily snapshot (6:30am ET). Try:</p>" +
  '<ul>' +
  '<li><a href="/api/health">/api/health</a></li>' +
  '<li><a href="/api/refresh">/api/refresh</a></li>' +
  '<li><a href="/api/search?exchanges=NASDAQ,OTC,NYSE">/api/search?exchanges=NASDAQ,OTC,NYSE</a></li>' +
  "</ul>";

app.get("/", (_req: Request, res: Response) => res.type("text/html").send(homeHtml));
app.get("/api/health", (_req: Request, res: Response) => res.json({ ok: true, date: SNAPSHOT.date }));
app.post("/api/refresh", async (_req: Request, res: Response) => { const s = await refreshSnapshot(); res.json({ ok: true, date: s.date, count: s.items.length }); });

// ensure snapshot is for today
function ensureFresh(): RequestHandler {
  return async (_req: Request, _res: Response, next: NextFunction) => {
    try { if (SNAPSHOT.date !== todayET()) await refreshSnapshot(); }
    catch (e) { console.error("ensureFresh", e); }
    finally { next(); }
  };
}

// --- SEARCH (patched behavior: filters only apply when provided) ---
app.get("/api/search", ensureFresh(), (req: Request, res: Response) => {
  const r = Q.safeParse(req.query);
  if (!r.success) return res.status(400).json({ error: "bad query", details: r.error.flatten() });
  const p = r.data;

  const exAllowed = p.exchanges
    ? (p.exchanges.split(",").map(s => s.trim().toUpperCase()) as Exchange[])
    : undefined;

  const loan = p.loan_size;
  const maxYears = p.max_payback_years;
  const runPayback = loan != null && maxYears != null && loan > 0 && maxYears > 0;

  const filtered = SNAPSHOT.items.filter(c => {
    if (exAllowed && !exAllowed.includes(c.exchange)) return false;
    if (p.location && (c.location || "").toLowerCase() !== p.location.toLowerCase()) return false;

    // apply basic filters only if provided
    if (p.revenue_min != null && (c.revenueLTMUSD ?? -Infinity) < p.revenue_min) return false;
    if (p.revenue_max != null && (c.revenueLTMUSD ??  Infinity) > p.revenue_max) return false;
    if (p.cfo_min     != null && (c.cfoLTMUSD     ?? -Infinity) < p.cfo_min)     return false;
    if (p.debt_max    != null && (c.totalDebtUSD  ??  Infinity) > p.debt_max)    return false;
    if (p.ap_max      != null && (c.accountsPayableUSD ?? Infinity) > p.ap_max)  return false;
    if (p.adv_min     != null && (c.advUSD ?? 0) < p.adv_min)                    return false;

    // borrowing base (only if user sets a floor)
    if (p.min_borrow_base != null) {
      const bb = c.borrowingBaseUSD ?? 0;
      if (bb < p.min_borrow_base) return false;
    }

    // payback test (only if both loan_size & max_payback_years provided)
    if (runPayback) {
      const cfo = c.cfoLTMUSD;
      if (cfo == null || cfo <= 0) return false;
      const payback = loan! / cfo;
      c.paybackYearsAtLoan = payback;
      c.loanCoverage = (c.borrowingBaseUSD ?? 0) / loan!;
      if (payback > maxYears!) return false;
    }

    return true;
  });

  // sort: if payback present, shortest first → then coverage; else revenue desc as proxy
  filtered.sort((a, b) => {
    if (a.paybackYearsAtLoan != null && b.paybackYearsAtLoan != null && a.paybackYearsAtLoan !== b.paybackYearsAtLoan) {
      return (a.paybackYearsAtLoan as number) - (b.paybackYearsAtLoan as number);
    }
    const ac = a.loanCoverage ?? 0, bc = b.loanCoverage ?? 0;
    if (ac !== bc) return bc - ac;
    return (b.revenueLTMUSD ?? 0) - (a.revenueLTMUSD ?? 0);
  });

  res.json({ date: SNAPSHOT.date, count: filtered.length, items: filtered });
});

app.listen(PORT, () => console.log(`Loan-fit EDGAR backend :${PORT} (daily 6:30am ET)`));
