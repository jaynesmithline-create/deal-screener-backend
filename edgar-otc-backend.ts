app.get("/api/search", ensureFresh(), (req, res) => {
  const r = Q.safeParse(req.query);
  if (!r.success) return res.status(400).json({ error: "bad query", details: r.error.flatten() });
  const p = r.data;

  const loan = p.loan_size;
  const maxYears = p.max_payback_years;
  const runPayback = loan != null && maxYears != null && loan > 0 && maxYears > 0;

  const exAllowed = p.exchanges
    ? (p.exchanges.split(",").map(s => s.trim().toUpperCase()) as Exchange[])
    : undefined;

  const filtered = SNAPSHOT.items.filter(c => {
    // Exchanges & location
    if (exAllowed && !exAllowed.includes(c.exchange)) return false;
    if (p.location && (c.location || "").toLowerCase() !== p.location.toLowerCase()) return false;

    // Basic metric filters (only if provided by user)
    if (p.revenue_min != null && (c.revenueLTMUSD ?? -Infinity) < p.revenue_min) return false;
    if (p.revenue_max != null && (c.revenueLTMUSD ?? Infinity)  > p.revenue_max) return false;
    if (p.cfo_min     != null && (c.cfoLTMUSD     ?? -Infinity) < p.cfo_min)     return false;
    if (p.debt_max    != null && (c.totalDebtUSD  ?? Infinity)  > p.debt_max)    return false;
    if (p.ap_max      != null && (c.accountsPayableUSD ?? Infinity) > p.ap_max)  return false;
    if (p.adv_min     != null && (c.advUSD ?? 0) < p.adv_min)                    return false;

    // Borrowing base (only if the user sets a minimum)
    if (p.min_borrow_base != null) {
      const bb = c.borrowingBaseUSD ?? 0;
      if (bb < p.min_borrow_base) return false;
    }

    // Payback test (only if *both* loan_size and max_payback_years are provided)
    if (runPayback) {
      const cfo = c.cfoLTMUSD;
      if (cfo == null || cfo <= 0) return false;            // payback requires positive CFO
      const paybackYears = loan! / cfo;
      c.paybackYearsAtLoan = paybackYears;
      c.loanCoverage = (c.borrowingBaseUSD ?? 0) / loan!;
      if (paybackYears > maxYears!) return false;
    }

    return true;
  });

  // Sort: if payback is computed, prioritize shorter payback, then coverage; else by revenue desc as a simple proxy
  filtered.sort((a, b) => {
    const ap = a.paybackYearsAtLoan, bp = b.paybackYearsAtLoan;
    if (ap != null && bp != null && ap !== bp) return ap - bp;
    const ac = a.loanCoverage ?? 0, bc = b.loanCoverage ?? 0;
    if (ac !== bc) return bc - ac;
    const ar = a.revenueLTMUSD ?? 0, br = b.revenueLTMUSD ?? 0;
    return br - ar;
  });

  res.json({ date: SNAPSHOT.date, count: filtered.length, items: filtered });
});
