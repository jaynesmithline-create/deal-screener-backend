// Backend — Fast EDGAR (concurrent) + Market Cap (Yahoo)
import express, { Request, Response, NextFunction, RequestHandler } from "express";
import cors from "cors";
import cron from "node-cron";
import { z } from "zod";

const PORT = Number(process.env.PORT || 4000);
const TIMEZONE = "America/New_York";
const SEC_UA = process.env.SEC_UA || "contact@yourfirm.com";
const UNIVERSE_LIMIT = Number(process.env.UNIVERSE_LIMIT || 300);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 5));
const BUILD_ID = process.env.RENDER_GIT_COMMIT || new Date().toISOString();

type Exchange = "NYSE" | "NASDAQ" | "OTC" | "PRIVATE";
type Company = {
  ticker?: string; cik?: string; name: string; exchange: Exchange; location?: string;
  revenueLTMUSD?: number; cfoLTMUSD?: number; totalDebtUSD?: number; accountsPayableUSD?: number;
  arUSD?: number; inventoryUSD?: number; ppeUSD?: number;
  borrowingBaseUSD?: number; paybackYearsAtLoan?: number; loanCoverage?: number;
  marketCapUSD?: number; advUSD?: number; lastFundraisingDate?: string;
};
type Snapshot = { date: string; items: Company[] };
let SNAPSHOT: Snapshot = { date: "", items: [] };
let REFRESHING: Promise<Snapshot> | null = null;

function todayET(): string {
  const fmt = new Intl.DateTimeFormat("en-CA",{timeZone:TIMEZONE,year:"numeric",month:"2-digit",day:"2-digit"});
  const p = fmt.formatToParts(new Date());
  return `${p.find(x=>x.type==="year")!.value}-${p.find(x=>x.type==="month")!.value}-${p.find(x=>x.type==="day")!.value}`;
}
function padCIK(raw: string) { return raw.padStart(10, "0"); }
async function secJSON(url: string) {
  const r = await fetch(url,{headers:{ "User-Agent": SEC_UA, "Accept":"application/json"} as any});
  if (!r.ok) throw new Error(`SEC ${r.status} ${url}`);
  return r.json();
}
function classifyExchange(t: string): Exchange {
  const u = t.toUpperCase();
  if (u.length > 4 || u.includes(".") || u.endsWith("F")) return "OTC";
  if (u.length <= 3) return "NYSE";
  return "NASDAQ";
}
function pickUSDLatest(usgaap: any, tag: string): number|undefined {
  const arr = (usgaap?.[tag]?.units?.USD as any[]) || [];
  if (!arr.length) return undefined;
  const latest = [...arr].sort((a,b)=>String(b.end||"").localeCompare(String(a.end||"")))[0];
  const v = Number(latest?.val);
  return Number.isFinite(v) ? v : undefined;
}
async function pullFacts(cik: string): Promise<Partial<Company>> {
  try {
    const facts = await secJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
    const usgaap = facts.facts?.["us-gaap"] || {};
    const revenue = pickUSDLatest(usgaap,"Revenues")
      ?? pickUSDLatest(usgaap,"SalesRevenueNet")
      ?? pickUSDLatest(usgaap,"RevenueFromContractWithCustomerExcludingAssessedTax");
    const cfo = pickUSDLatest(usgaap,"NetCashProvidedByUsedInOperatingActivities");
    const ltd = pickUSDLatest(usgaap,"LongTermDebtNoncurrent") ?? pickUSDLatest(usgaap,"LongTermDebt") ?? 0;
    const std = pickUSDLatest(usgaap,"ShortTermBorrowings") ?? pickUSDLatest(usgaap,"DebtCurrent") ?? 0;
    const ap  = pickUSDLatest(usgaap,"AccountsPayableCurrent");
    const ar  = pickUSDLatest(usgaap,"AccountsReceivableNetCurrent") ?? pickUSDLatest(usgaap,"AccountsReceivableNet");
    const inv = pickUSDLatest(usgaap,"InventoryNet") ?? pickUSDLatest(usgaap,"Inventory");
    const ppe = pickUSDLatest(usgaap,"PropertyPlantAndEquipmentNet");
    return { revenueLTMUSD: revenue, cfoLTMUSD: cfo, totalDebtUSD: (ltd||0)+(std||0),
             accountsPayableUSD: ap, arUSD: ar, inventoryUSD: inv, ppeUSD: ppe };
  } catch { return {}; }
}
async function fetchSubs(cik: string) { try { return await secJSON(`https://data.sec.gov/submissions/CIK${cik}.json`);} catch { return undefined; } }
function subsLocation(subs:any){ return subs?.stateOfIncorporation || subs?.addresses?.business?.stateOrCountry || subs?.addresses?.mailing?.stateOrCountry || subs?.stateOfIncorporationDescription; }
function subsLastRaise(subs:any){ const f=subs?.filings?.recent?.form||[], d=subs?.filings?.recent?.filingDate||[]; let best; for(let i=0;i<f.length;i++){ const F=String(f[i]).toUpperCase(); if(/^(424B\\d|8-K|S-1|S-3|D)$/.test(F)){ const dt=d[i]; if(!best||dt>best) best=dt; }} return best; }
function borrowingBase(ar?:number,inv?:number,ppe?:number){ return (ar||0)*0.80 + (inv||0)*0.50 + (ppe||0)*0.25; }

// Yahoo Finance quote for market cap (best-effort; may be undefined for some OTC)
async function fetchMarketCapYahoo(ticker: string): Promise<number|undefined>{
  try{
    const u = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`;
    const r = await fetch(u, { headers: { "Accept": "application/json" } as any });
    if(!r.ok) return undefined;
    const j:any = await r.json();
    const q = j?.quoteResponse?.result?.[0];
    const cap = q?.marketCap, px = q?.regularMarketPrice, sh = q?.sharesOutstanding;
    if (typeof cap === "number" && isFinite(cap)) return cap;
    if (typeof px === "number" && typeof sh === "number" && isFinite(px) && isFinite(sh)) return px*sh;
    return undefined;
  }catch{ return undefined; }
}

async function pMap<T,R>(items:T[],limit:number,fn:(item:T,idx:number)=>Promise<R>):Promise<R[]>{
  const out:R[] = new Array(items.length) as any;
  let i=0;
  async function worker(){ while(i<items.length){ const cur=i++; out[cur]=await fn(items[cur],cur);} }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}

async function buildUniverse(){ 
  const data = await secJSON("https://www.sec.gov/files/company_tickers.json");
  const rows = Object.keys(data).map(k=>data[k]) as Array<{cik:number;ticker:string;title:string}>;
  const CLEAN = rows.filter(r=>!/(ETF|FUND|TRUST|ETN|ETP|INCOME|DIVIDEND)/i.test(r.title||\"\")); 
  return CLEAN.slice(0,UNIVERSE_LIMIT).map(r=>({ ticker:r.ticker.toUpperCase(), cik:padCIK(String(r.cik)), exchange: classifyExchange(r.ticker), name:r.title }));
}

async function refreshSnapshot(): Promise<Snapshot>{
  const date = todayET();
  let U = await buildUniverse();
  const items: Company[] = await pMap(U, CONCURRENCY, async (u) => {
    const cik = u.cik; const name = u.name || u.ticker;
    let facts: Partial<Company> = {}; let subs:any|undefined; let mcap:number|undefined;
    try{
      const [f,s,cap] = await Promise.all([ cik?pullFacts(cik):Promise.resolve({}), cik?fetchSubs(cik):Promise.resolve(undefined), fetchMarketCapYahoo(u.ticker) ]);
      facts=f; subs=s; mcap=cap;
    }catch{}
    const bb = borrowingBase(facts.arUSD, facts.inventoryUSD, facts.ppeUSD);
    return { ticker:u.ticker, cik, name, exchange:u.exchange, location:subsLocation(subs), lastFundraisingDate: subsLastRaise(subs),
             borrowingBaseUSD: bb, marketCapUSD: mcap, ...facts, advUSD: undefined };
  });
  SNAPSHOT = { date, items };
  console.log(`[snapshot ${date}] companies=${items.length}`);
  return SNAPSHOT;
}
function scheduleRefresh(){ if(!REFRESHING){ REFRESHING = refreshSnapshot().finally(()=>{ REFRESHING=null; }); } }
scheduleRefresh();
cron.schedule("30 6 * * *", ()=>scheduleRefresh(), { timezone: TIMEZONE });

const app = express();
app.use(cors()); app.use(express.json());
app.use((_,res,next)=>{ res.setHeader("X-Backend-Build", BUILD_ID); next(); });

const Q = z.object({
  revenue_min: z.coerce.number().optional(),
  revenue_max: z.coerce.number().optional(),
  cfo_min:     z.coerce.number().optional(),
  debt_max:    z.coerce.number().optional(),
  ap_max:      z.coerce.number().optional(),
  adv_min:     z.coerce.number().optional(),
  market_cap_max: z.coerce.number().optional(),   // NEW
  location: z.string().optional(),
  exchanges: z.string().optional(),
  loan_size: z.coerce.number().optional(),
  max_payback_years: z.coerce.number().optional(),
  min_borrow_base: z.coerce.number().optional(),
});

app.get("/", (_req,res)=>res.type("text/html").send(`<h2>EDGAR Loan-Fit Screener</h2><p>Build: ${BUILD_ID}</p><ul><li><a href=\"/api/health\">/api/health</a></li><li><a href=\"/api/refresh\">/api/refresh</a></li><li><a href=\"/api/search?exchanges=NASDAQ,OTC,NYSE&market_cap_max=500000000\">/api/search?exchanges=NASDAQ,OTC,NYSE&market_cap_max=500000000</a></li></ul>`));
app.get("/api/health", (_req,res)=>res.json({ ok:true, date:SNAPSHOT.date, build:BUILD_ID, universe_limit:UNIVERSE_LIMIT, concurrency:CONCURRENCY, cap_provider:"yahoo" }));
app.post("/api/refresh", async (_req,res)=>{ try{ const s=await refreshSnapshot(); res.json({ ok:true, date:s.date, count:s.items.length }); }catch(e:any){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }});

// serve snapshot while background refresh runs if stale
function ensureFreshNonBlocking(): RequestHandler {
  return async (_req,_res,next)=>{ try{ if(SNAPSHOT.date!==todayET() && !REFRESHING) scheduleRefresh(); }catch(e){ console.error(e);} finally{ next(); } };
}

app.get("/api/search", ensureFreshNonBlocking(), (req:Request,res:Response)=>{
  const r = Q.safeParse(req.query);
  if(!r.success) return res.status(400).json({ error:"bad query", details:r.error.flatten() });
  const p = r.data;
  const exAllowed = p.exchanges ? (p.exchanges.split(\",\").map(s=>s.trim().toUpperCase()) as Exchange[]) : undefined;
  const runPayback = p.loan_size!=null && p.max_payback_years!=null && p.loan_size>0 && p.max_payback_years>0;

  const out = SNAPSHOT.items.filter(c=>{
    if (exAllowed && !exAllowed.includes(c.exchange)) return false;
    if (p.location && (c.location||\"\").toLowerCase() !== p.location.toLowerCase()) return false;
    if (p.revenue_min!=null && (c.revenueLTMUSD ?? -Infinity) < p.revenue_min) return false;
    if (p.revenue_max!=null && (c.revenueLTMUSD ??  Infinity) > p.revenue_max) return false;
    if (p.cfo_min    !=null && (c.cfoLTMUSD     ?? -Infinity) < p.cfo_min)     return false;
    if (p.debt_max   !=null){ const td=c.totalDebtUSD; if (td==null || td>p.debt_max) return false; }
    if (p.ap_max     !=null && (c.accountsPayableUSD ?? 0) > p.ap_max) return false;
    if (p.adv_min    !=null && (c.advUSD ?? Infinity) < p.adv_min) return false;
    if (p.market_cap_max!=null){ const m=c.marketCapUSD; if (m!=null && m>p.market_cap_max) return false; } // unknown caps pass
    if (p.min_borrow_base!=null && (c.borrowingBaseUSD ?? 0) < p.min_borrow_base) return false;

    if (runPayback){ const cfo=c.cfoLTMUSD; if (cfo==null || cfo<=0) return false;
      c.paybackYearsAtLoan = p.loan_size! / cfo;
      c.loanCoverage       = (c.borrowingBaseUSD ?? 0) / p.loan_size!;
      if (c.paybackYearsAtLoan > p.max_payback_years!) return false;
    }
    return true;
  });

  out.sort((a,b)=> {
    if (a.paybackYearsAtLoan!=null && b.paybackYearsAtLoan!=null && a.paybackYearsAtLoan!==b.paybackYearsAtLoan) return a.paybackYearsAtLoan - b.paybackYearsAtLoan;
    const ac=a.loanCoverage??0, bc=b.loanCoverage??0; if (ac!==bc) return bc-ac;
    const am=a.marketCapUSD??Infinity, bm=b.marketCapUSD??Infinity; if (am!==bm) return am-bm; // smaller caps first
    return (b.revenueLTMUSD??0)-(a.revenueLTMUSD??0);
  });

  res.json({ date: SNAPSHOT.date, count: out.length, items: out });
});

app.listen(PORT, ()=>console.log(`EDGAR backend (concurrent+cap) listening :${PORT} — Build ${BUILD_ID}`));
