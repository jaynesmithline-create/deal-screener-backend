// edgar-otc-backend.ts — Daily refreshed search API (SEC EDGAR + OTC stub)
// ----------------------------------------------------------------------
// WHAT THIS DOES
// - Refreshes a daily snapshot every morning (6:30 AM America/New_York)
// - Pulls key fundamentals from SEC EDGAR companyfacts (Revenue, CFO, Debt, AP)
// - Estimates last fundraising date from submissions (424B*, S-1/S-3, 8-K, Form D)
// - Tries to infer company location from submissions (state/country)
// - Serves /api/search so your web UI can filter companies by your criteria
//
// RENDER ENV
//   TZ=America/New_York
//   SEC_UA=you@yourfirm.com
//   UNIVERSE_LIMIT=300
// ----------------------------------------------------------------------

import express from "express";
import cors from "cors";
import cron from "node-cron";
import { z } from "zod";

const PORT = process.env.PORT || 4000;
const TIMEZONE = "America/New_Y_
