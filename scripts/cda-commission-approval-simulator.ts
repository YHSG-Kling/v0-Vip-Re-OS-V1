#!/usr/bin/env tsx
/**
 * scripts/cda-commission-approval-simulator.ts   (npm run test:cda-commission-approval)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the Finance Manager gap is closed: after the broker signs the CDA, the related
 * commission auto-advances pending → approved (previously it stalled in 'pending' forever
 * unless a broker separately remembered to call markCommissionApproved — a stale manual step
 * the leak reaper couldn't even catch, since a pending commission WITH a dashboard row is
 * invisible to it). The broker signing the CDA IS the broker approving the commission.
 *
 * SOURCE scan: brokerSignCdaAction wires markCommissionApproved (pending, by transaction, best-
 * effort); markCommissionApproved stays broker-gated + transition-validated. (Server-only modules
 * can't be imported in tsx, so we assert the wiring by scanning source — like the egress guards.)
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function main() {
  const portal = src("app/actions/cda-portal.ts")

  console.log("\n[broker signs the CDA → commission auto-approves]")
  check("brokerSignCdaAction calls markCommissionApproved", /brokerSignCdaAction[\s\S]*?markCommissionApproved/.test(portal))
  check("it targets the PENDING commission for THIS transaction", /agent_commissions[\s\S]*?transaction_id[\s\S]*?status[\s\S]*?pending/.test(portal))
  check("it uses the broker as the approver (approvedBy: auth.userId)", /markCommissionApproved\([\s\S]*?approvedBy:\s*auth\.userId/.test(portal))
  check("it is best-effort — wrapped in try/catch so it never blocks the sign-off", /markCommissionApproved[\s\S]*?catch\s*{[\s\S]*?best-effort/.test(portal) || /try\s*{[\s\S]*?markCommissionApproved[\s\S]*?}\s*catch/.test(portal))

  console.log("\n[it's wired into the CANONICAL compliance path (cda-portal), not the agent-tab drift]")
  check("the wire lives in brokerSignCdaAction (cda-portal), the broker-sign step", portal.includes("export async function brokerSignCdaAction") && /brokerSignCdaAction[\s\S]*?markCommissionApproved/.test(portal))

  console.log("\n[markCommissionApproved stays governed]")
  const fin = src("lib/kernel/financial.ts")
  check("markCommissionApproved is broker-gated (broker/admin/superadmin only)", /markCommissionApproved[\s\S]*?\["broker",\s*"admin",\s*"superadmin"\]/.test(fin))
  check("it validates the pending → approved transition (no illegal jumps)", /COMMISSION_STATUS_TRANSITIONS\b/.test(fin) && /pending:\s*\[\s*"approved"/.test(fin))
  check("it stamps approved_at + approved_by (audit trail)", /approved_at:\s*approvedAt,\s*approved_by:\s*approvedBy/.test(fin))
  check("it emits a COMMISSION_APPROVED lifecycle event", /COMMISSION_APPROVED/.test(fin))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CDA_COMMISSION_APPROVAL_FAIL"); process.exit(1) }
  console.log(" ✅ CDA_COMMISSION_APPROVAL_PASS — broker signs → commission auto-approves; no stale pending, governed + audited")
}
main()
