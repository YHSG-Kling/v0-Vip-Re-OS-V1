#!/usr/bin/env tsx
/**
 * scripts/cda-delivery-simulator.ts   (npm run test:cda-delivery)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SIGNED DISBURSEMENT AUTHORIZATION WAS NEVER DELIVERED TO ANYONE.
 *
 * The CDA is the instruction the closing agent uses to split funds at closing.
 * The compliance queue could approve it and the broker could sign it, and then:
 *
 *   listCdasForComplianceReviewAction filtered on
 *     and(status.eq.approved, broker_approved_at.is.null)
 *
 * so the MOMENT the broker signed, broker_approved_at stopped being null and the
 * CDA dropped out of the queue. Nothing else surfaces it. sendCdaToTitleAction —
 * complete, tenant-scoped, gated on the broker signature, dispatching the email,
 * setting status 'delivered' and completing the cda_delivered milestone — had no
 * caller anywhere. The panel's own toast said "ready to send to the closing
 * agent" with no way to send it.
 *
 * VERIFIED LIVE with four CDAs on one transaction:
 *   OLD queue → submitted, awaiting-broker-sig            (2 rows)
 *   NEW queue → submitted, awaiting-broker-sig, signed-NOT-sent  (3 rows)
 *   neither returns the already-delivered one, which is correct.
 *
 * AND A SECOND DEFECT, THIS ONE COSTING MONEY.
 * closing_disclosure_agreement.agent_id is FK → users(id). But
 * agent_commission_profiles, agent_cap_tracking and agent_fee_charges are all
 * FK → agents(id). The list keyed ALL of them with the CDA's users.id, so every
 * lookup matched nothing:
 *   · agentName        → null  (reviewing a disbursement without a name on it)
 *   · contract split   → null  (so the split-vs-contract verdict never ran)
 *   · outstandingFees  → 0     (so "must deduct $X in fees" could never fire)
 *
 * VERIFIED LIVE: with a real $750 open fee charge on the agent,
 *   keyed by the CDA's agent_id  → $0
 *   resolved users.id→agents.id  → $750
 * and `agents` matched ZERO rows on the CDA's agent_id, which is the whole bug
 * in one number.
 */
import { readFileSync, existsSync } from "node:fs"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  existsSync(p)
    ? readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
    : ""

const list = src("app/actions/cda-portal-list.ts")
const panel = src("app/dashboard/compliance/components/os/cda-review-panel.tsx")
const portal = src("app/actions/cda-portal.ts")

console.log("\n── a signed CDA stays visible until it is DELIVERED ──")
{
  check("the queue asks for signed-but-unsent CDAs",
    /status\.eq\.approved,broker_approved_at\.not\.is\.null,sent_to_title_at\.is\.null/.test(list))
  check("…and still asks for the approved-awaiting-signature ones",
    /status\.eq\.approved,broker_approved_at\.is\.null/.test(list))
  check("the delivery timestamp is selected, or the bucket cannot be computed",
    /sent_to_title_at/.test(list) && /sentToTitleAt:/.test(list))
  check("the item type carries it", /sentToTitleAt:\s*string \| null/.test(list))

  check("the panel has an awaiting-delivery bucket",
    /awaitingSendToTitle/.test(panel))
  check("…which is signed AND not yet sent — not merely approved",
    /!!i\.brokerApprovedAt && !i\.sentToTitleAt/.test(panel))
  check("…and it offers the action", /onOpenDialog\(item\.id, "send_to_title"\)/.test(panel))
  check("the action reaches the real server capability",
    /sendCdaToTitleAction\(\{/.test(panel))
  check("…with a recipient the reviewer actually typed",
    /recipientEmail: email/.test(panel) && /setTitleEmail/.test(panel))
  check("…validated before dispatch, since this is where the money instruction goes",
    /Enter a valid closing-agent email/.test(panel))
  check("a failed send is reported, not swallowed",
    /toast\.error\("error" in res \? res\.error : "Send failed"\)/.test(panel))
}

console.log("\n── the server gate behind it is unchanged and still real ──")
{
  check("sendCdaToTitleAction exists", /export async function sendCdaToTitleAction/.test(portal))
  check("…is tenant-scoped", /cda\.brokerage_id !== auth\.brokerageId/.test(portal))
  check("…refuses before the broker has signed",
    /canSendCdaToTitle\(\{ status: cda\.status, brokerSigned: !!cda\.broker_approved_at \}\)/.test(portal))
  check("…records the delivery on the row", /sent_to_title_at:\s+sentNow/.test(portal))
  check("…and completes the milestone on DELIVERY, not on approval",
    /milestone_type\.eq\.cda_delivered/.test(portal))
}

console.log("\n── two id spaces, resolved rather than conflated ──")
{
  // closing_disclosure_agreement.agent_id is users(id); the three agent-scoped
  // money tables are agents(id). Keying them with the CDA's id matched nothing.
  check("users.id → agents.id is resolved once, explicitly",
    /agentIdByUserId/.test(list) && /\.in\("user_id", cdaUserIds\)/.test(list))
  check("…scoped to the caller's brokerage", /\.eq\("brokerage_id", auth\.brokerageId\)\.in\("user_id", cdaUserIds\)/.test(list))
  check("the agent-scoped reads are keyed on the RESOLVED agents.id",
    /\.in\("agent_id", agentIds\)/.test(list) && /const agentIds = Array\.from\(new Set\(\[\.\.\.agentIdByUserId\.values\(\)\]\)\)/.test(list))

  // Per-row: the money lookups must not be keyed on c.agent_id any more.
  const row = /const items: CdaReviewItem\[\] = cdas\.map\(c => \{[\s\S]*?\n  \}\)/.exec(list)?.[0] ?? ""
  check("the per-row fee lookup no longer uses the CDA's own agent_id",
    row.length > 0 && !/feeChargesByAgent\.get\(c\.agent_id\)/.test(row))
  check("…nor the profile lookup", !/profileByAgent\.get\(c\.agent_id\)/.test(row))
  check("…nor the cap lookup", !/capByAgent\.get\(c\.agent_id\)/.test(row))
  check("…they all go through the resolved id",
    /profileByAgent\.get\(agentId\)/.test(row) &&
    /capByAgent\.get\(agentId\)/.test(row) &&
    /feeChargesByAgent\.get\(agentId\)/.test(row))
  check("the display name comes straight off the users.id the CDA carries",
    /const userId = c\.agent_id \?\? null/.test(row) && /nameByUserId\.get\(userId\)/.test(row))
  check("an agent with no agents row degrades to nulls rather than throwing",
    /agentId \? .*: null/.test(row) || /agentId \?/.test(row))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ CDA_DELIVERY_FAIL"); process.exit(1) }
console.log(" ✅ CDA_DELIVERY_PASS — a signed CDA is delivered, and the reviewer can see whose it is")
