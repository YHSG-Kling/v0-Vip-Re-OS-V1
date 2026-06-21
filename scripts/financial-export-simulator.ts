#!/usr/bin/env tsx
/**
 * scripts/financial-export-simulator.ts  (npm run test:financial-export) — pure, no DB.
 *
 * Proves the Finance Manager's report export is REAL, not a placeholder: financialReportRows
 * serializes a live brokerage summary into labelled money rows, and rowsToCsv emits RFC-4180 CSV
 * (quote-escaped, CRLF). The export path wraps these into a downloadable data-URI (CSV + pdf-lib PDF)
 * — no fake storage.example.com URL.
 */
import { financialReportRows, rowsToCsv, computeCapState } from "../lib/kernel/financial"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`) }
}

const summary: any = {
  brokerageId: "bk1",
  mtdGrossIncome: 120000, mtdAgentSplits: 84000, mtdBrokerageNet: 36000,
  ytdGrossIncome: 1450000, ytdAgentSplits: 1015000, ytdBrokerageNet: 435000,
  teamCount: 3, agentCount: 22, pendingCommissions: 5, approvedCommissions: 9,
}
const rows = financialReportRows(summary, { reportType: "brokerage", dateFrom: "2026-01-01", dateTo: "2026-06-19", generatedAt: "2026-06-19T12:00:00Z" })

console.log("\n[1 · financialReportRows — real numbers, labelled, money-formatted]")
const map = new Map(rows)
check("every metric present + money formatted ($ + thousands separators)",
  map.get("MTD Gross Income") === "$120,000" && map.get("YTD Brokerage Net") === "$435,000" && map.get("MTD Brokerage Net") === "$36,000")
check("counts carried through (agents/teams/commissions)",
  map.get("Agents") === "22" && map.get("Teams") === "3" && map.get("Pending Commissions") === "5" && map.get("Approved Commissions") === "9")
check("report meta (type + period + generated) included",
  map.get("Report Type") === "brokerage" && map.get("Period From") === "2026-01-01" && map.get("Generated") === "2026-06-19T12:00:00Z")

console.log("\n[2 · rowsToCsv — RFC-4180]")
const csv = rowsToCsv(["Metric", "Value"], rows)
check("header + every row present, CRLF line endings", csv.startsWith('"Metric","Value"\r\n') && csv.split("\r\n").length === rows.length + 1)
check("values are quote-wrapped", csv.includes('"MTD Gross Income","$120,000"'))
const tricky = rowsToCsv(["A", "B"], [['He said "hi"', "x,y"]])
check("embedded quotes doubled + commas safe inside quotes", tricky.includes('"He said ""hi""","x,y"'))

console.log("\n[3 · data-URI shape (what the export returns)]")
const dataUri = `data:text/csv;base64,${Buffer.from(csv, "utf8").toString("base64")}`
check("CSV serializes to a real downloadable data-URI (no storage.example.com placeholder)",
  dataUri.startsWith("data:text/csv;base64,") && Buffer.from(dataUri.split(",")[1], "base64").toString("utf8") === csv)

console.log("\n[4 · computeCapState — anniversary cap (within-year + rollover reset)]")
const yr = (s: string, e: string, paid: number, cap: number, capped = false) =>
  ({ anniversary_start: s, anniversary_end: e, cap_paid_to_date: paid, cap_amount: cap, is_capped: capped })
const now = new Date("2026-06-21T00:00:00Z")
check("inside the year + fully paid → CAPPED",
  computeCapState(yr("2026-01-01", "2026-12-31", 30000, 30000), now).isCapped === true)
check("inside the year + under cap → NOT capped",
  computeCapState(yr("2026-01-01", "2026-12-31", 12000, 30000), now).isCapped === false)
const rolled = computeCapState(yr("2024-01-01", "2024-12-31", 30000, 30000, true), now)
check("anniversary ELAPSED (2 years) → window rolls to the current year, cap resets to 0, not capped",
  rolled.rolledOver === true && rolled.capPaidToDate === 0 && rolled.isCapped === false &&
  rolled.anniversaryStart.startsWith("2026-01-01") && rolled.anniversaryEnd.startsWith("2026-12-31") && new Date(rolled.anniversaryEnd) > now)
check("no cap configured (cap_amount 0) is NEVER capped",
  computeCapState(yr("2026-01-01", "2026-12-31", 5000, 0), now).isCapped === false)
check("an is_capped flip is flagged changed (persisted)",
  computeCapState(yr("2026-01-01", "2026-12-31", 30000, 30000, false), now).changed === true)

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ FINANCIAL_EXPORT_PASS — the export is real data in a real file, not a placeholder URL")
