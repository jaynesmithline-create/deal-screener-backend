// edgar-otc-backend.ts — Loan-fit screener (SEC EDGAR)
// ----------------------------------------------------------------------
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { z } from "zod";

const PORT = process.env.PORT || 4000;
const TIMEZONE = "America/New_York";
const SEC_UA = process.env.SEC_UA || "contact@yourfirm.com";
const UNIVERSE_LIMIT = Number(process.env.UNIVERSE_LIMIT || 300);

// ---------- Types ----------
type Exchange = "NYSE" | "NASDAQ" | "OTC" | "PRIVATE";
type Company = {
  ticker?: string;
  cik?: string;
  name: string;
  exchange: Exchange;
  location?: string;

  // Core metrics
  revenueLTMUSD?: number;
  cfoLTMUSD?: number;
  totalDebtUSD?: number;
  accountsPayableUSD?: number;

  // Asset components (for borrowing base)
  arUSD?: number;         // Accounts Receivable, net
  inventoryUSD?: number;  // Inventory, net
  ppeUSD?: number;        // Property, Plant & Equipment, net

  // Derived loan-fit metrics
  borrowingBaseUSD?: number;
  paybackYearsAtLoan?: number; // loan_size / CFO
  loanCoverage?: number;       // borrowingBaseUSD / loan_size

  // Other
  advUSD?: number;             // (stub for now)
  lastFundraisingDate?: string;
};

type Snapshot = { date: string; items: Company[] };
let SNAPSHOT: Snapshot = { date: "", items: [] };
let UNIVERSE: { ticker: string; cik?: string; exchange: Exchange; name?: string }[] = [];

// ---------- Helpers ----------
function todayET(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = fmt.formatToParts(new Date());
  const y = p.find((x) => x.type === "year")!.value;
  const m = p.find((x) => x.type === "month")!.value;
  const d = p.find((x) => x.type === "day")!.value;
  return `${y}-${m}-${d}`;
}
function padCIK(raw: string) { return raw.padStart(10, "0"); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
async function secJSON(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": SEC_UA, Accept: "application/json" } as any });
  if (!res.ok) throw new Error(`SEC ${res.status} ${url}`);
  return res.json();
}
function classifyExchange(t: string): Exchange {
  const u = t.toUpperCase();
  if (u.length === 5 || u.includes(".") || u.endsWith("F")) return "OTC";
  return "NASDAQ";
}

// Build a larger ticker universe from SEC mapping; skip funds/ETFs/trusts
async function buildUniverse(): Promise<{ ticker: string; cik?: string; exchange: Exchange; name?: string }[]> {
  const data = await secJSON("https://www.sec.gov/files/company_tickers.json");
  const rows = Object.keys(data).map((k) => data[k]) as Array<{ cik: number; ticker: string; title: string }>;
  const CLEAN = rows.filter((r) => !/(ETF|FUND|TRUST|ETN|ETP|INCOME|DIVIDEND)/i.test(r.title || ""));
  return CLEAN.slice(0, UNIVERSE_LIMIT).map((r) => ({
    ticker: r.ticker.toUpperCase(),
    cik: padCIK(String(r.cik)),
    exchange: classifyExchange(r.ticker),
    name: r.title,
  }));
}

// Most-recent USD value for a tag
function pickUSDLatest(usgaap: any, tag: string): number | undefined {
  const arr = (usgaap?.[tag]?.units?.USD as any[]) || [];
  if (!arr.length) return undefined;
  const sorted = [...arr].sort((a, b) => String(b.end || "").localeCompare(String(a.end || "")));
  const v = Number(sorted[0]?.val);
  return Number.isFinite(v) ? v : undefined;
}

// Pull XBRL company facts and compute ABL base
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

    // Asset components
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

// Submissions → location + last fundraising date
async function fetchSubs(cik: string): Promise<any | undefined> {
  try { return await secJSON(`https://data.sec.gov/submissions/CIK${cik}.json`); } catch { return undefined; }
}
function getLocation(subs: any): string | undefined {
  return (
    subs?.stateOfIncorporation ||
    subs?.addresses?.business?.stateOrCountry ||
    subs?.addresses?.mailing?.stateOrCountry ||
    subs?.stateOfIncorporationDescription ||
    undefined
  );
}
function lastRaise(subs: any): string | undefined {
  const forms: string[] = subs?.filings?.recent?.form || [];
  const dates: string[] = subs?.filings?.recent?.filingDate || [];
  let best: string | undefined;
  for (let i = 0; i < forms.length; i++) {
    const f = String(forms[i]).toUpperCase();
    if (/^(424B\d|8-K|S-1|S-3|D)$/.test(f)) { const dt = dates[i]; if (!best || dt > best) best = dt; }
  }
  return best;
}

// OTC ADV stub (wire OTCMarkets later)
async function pullOTCVolumeUSD(_t: string): Promise<number | undefined> { return undefined; }

// ---------- Snapshot ----------
function computeBorrowingBase(ar?: number, inv?: number, ppe?: number) {
  const arPart  = (ar  || 0) * 0.80;
  const invPart = (inv || 0) * 0.50;
  const ppePart = (ppe || 0) * 0.25;
  return arPart + invPart + ppePart;
}

async function refreshSnapshot(): Promise<Snapshot> {
  const date = todayET();
  if (UNIVERSE.length === 0) {
    try { UNIVERSE = await buildUniverse(); console.log(`[universe] ${UNIVERSE.length}`); }
    catch (e) { console.error("universe failed", e); UNIVERSE = [{ ticker: "VCTR", exchange: "NASDAQ" }]; }
  }

  const out: Company[] = [];
  for (const u of UNIVERSE) {
    const cik = u.cik; const name = u.name || u.ticker;
    let f: Partial<Company> = {}; let subs: any | undefined;
    if (cik) {
      await sleep(120); f = await pullFacts(cik);
      await sleep(80);  subs = await fetchSubs(cik);
    }
    const bb = computeBorrowingBase(f.arUSD, f.inventoryUSD, f.ppeUSD);
    out.push({
      ticker: u.ticker, cik, name, exchange: u.exchange,
      location: getLocation(subs),
      lastFundraisingDate: lastRaise(subs),
      borrowingBaseUSD: bb,
      ...f,
      advUSD: u.exchange === "OTC" ? await pullOTCVolumeUSD(u.ticker) : undefined,
    });
  }
  SNAPSHOT = { date, items: out };
  console.log(`[snapshot ${date}] companies=${out.length}`);
  return SNAPSHOT;
}

refreshSnapshot().catch(console.error);
cron.schedule("30 6 * * *", () => { refreshSnapshot().catch(console.error); }, { timezone: TIMEZONE });

// ---------- API ----------
const app = express();
app.use(cors());
app.use(express.json());

const Q = z.object({
  // basic
  revenue_min: z.coerce.number().optional(),
  revenue_max: z.coerce.number().optional(),
  cfo_min: z.coerce.number().optional(),
  debt_max: z.coerce.number().optional(),
  ap_max: z.coerce.number().optional(),
  adv_min: z.coerce.number().optional(),
  location: z.string().optional(),
  exchanges: z.string().optional(),

  // loan-fit
  loan_size: z.coerce.number().optional(),          // default 3_000_000
  max_payback_years: z.coerce.number().optional(),  // default 4
  min_borrow_base: z.coerce.number().optional(),    // default = loan_size
});

app.get("/", (_req, res) => {
  res.type("text/html").send(
    '<h3>EDGAR Loan-Fit Screener</h3><p>Try <a href="/api/search?exchanges=NASDAQ,OTC,NYSE&loan_size=3000000&max_payback_years=4">/api/search</a></p>'
  );
});
app.get("/api/health", (_req, res) => res.json({ ok: true, date: SNAPSHOT.date }));
app.post("/api/refresh", async (_req, res) => { const s = await refreshSnapshot(); res.json({ ok: true, date: s.date, count: s.items.length }); });

function ensureFresh() {
  return async (_req: any, _res: any, next: any) => {
    try { if (SNAPSHOT.date !== todayET()) await refreshSnapshot(); } catch (e) { console.error(e); } finally { next(); }
  };
}

app.get("/api/search", ensureFresh(), (req, res) => {
  const r = Q.safeParse(req.query);
  if (!r.success) return res.status(400).json({ error: "bad query", details: r.error.flatten() });
  const p = r.data;

  const loan = p.loan_size ?? 3_000_000;
  const maxYears = p.max_payback_years ?? 4;
  const minBB = p.min_borrow_base ?? loan;

  const exAllowed = p.exchanges ? (p.exchanges.split(",").map(s => s.trim().toUpperCase()) as Exchange[]) : undefined;

  const filtered = SNAPSHOT.items.filter(c => {
    if (exAllowed && !exAllowed.includes(c.exchange)) return false;
    if (p.location && (c.location || "").toLowerCase() !== p.location.toLowerCase()) return false;

    // Basic metrics (optional)
    if (p.revenue_min != null && (c.revenueLTMUSD ?? -Infinity) < p.revenue_min) return false;
    if (p.revenue_max != null && (c.revenueLTMUSD ?? Infinity) > p.revenue_max) return false;
    if (p.cfo_min     != null && (c.cfoLTMUSD     ?? -Infinity) < p.cfo_min)     return false;
    if (p.debt_max    != null && (c.totalDebtUSD  ?? Infinity)  > p.debt_max)    return false;
    if (p.ap_max      != null && (c.accountsPayableUSD ?? Infinity) > p.ap_max)  return false;
    if (p.adv_min     != null && (c.advUSD ?? 0) < p.adv_min)                    return false;

    // Loan-fit rules
    const cfo = c.cfoLTMUSD ?? 0;
    if (cfo <= 0) return false; // need positive cash flow to service debt

    const bb = c.borrowingBaseUSD ?? 0;
    if (bb < minBB) return false;

    const paybackYears = loan > 0 && cfo > 0 ? loan / cfo : Infinity;
    c.paybackYearsAtLoan = paybackYears;
    c.loanCoverage = bb > 0 ? bb / loan : 0;

    if (paybackYears > maxYears) return false;

    return true;
  });

  // Sort by strongest fit: lower payback first, then larger coverage
  filtered.sort((a, b) => {
    const pa = a.paybackYearsAtLoan ?? Infinity, pb = b.paybackYearsAtLoan ?? Infinity;
    if (pa !== pb) return pa - pb;
    const ca = a.loanCoverage ?? 0, cb = b.loanCoverage ?? 0;
    return cb - ca;
  });

  res.json({ date: SNAPSHOT.date, count: filtered.length, items: filtered });
});

app.listen(PORT, () => console.log(`Loan-fit EDGAR backend :${PORT} (daily 6:30am ET)`));
