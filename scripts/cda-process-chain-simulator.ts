#!/usr/bin/env tsx
/**
 * scripts/cda-process-chain-simulator.ts (npm run test:cda-process-chain)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMMISSION DISBURSEMENT AUTHORIZATION RAN ON TWO ENGINES, AND THE ONE THE
 * AGENT CLICKED WAS BROKEN.
 *
 * Owner's process, verbatim:
 *   the agent is notified the PRELIMINARY HUD is in from title or the closing
 *   attorney → the agent fills out the CDA (if the broker offers this) from a
 *   TEMPLATE FORM THE ADMIN UPLOADED for the brokerage → FULL COMPLIANCE OF ALL
 *   DOCUMENTS IN THE FILE IS RUN BEFORE THE CDA IS ACCEPTED → the compliance
 *   officer looks it over (a solo or team subscription routes to their own
 *   transaction provider) → if approved it is sent to the title or attorney
 *   closer through the app or by email, AND THERE MUST BE A RECORD OF THIS.
 *
 * WHAT THE AUDIT FOUND.
 *
 * 1. TWO RAILS ON ONE TABLE. app/actions/cda-portal.ts (15 actions) implements
 *    the process above. lib/transactions/cda-workflow.ts was a second, weaker
 *    implementation over the same closing_disclosure_agreement table — no
 *    signature gate, no contract/split gate, and approveCDA shipped the
 *    disbursement authorization to the closing agent THE MOMENT COMPLIANCE
 *    APPROVED, skipping the broker's signature entirely. The compliance panel
 *    used the portal rail; the agent-facing transaction tab used the weak one.
 *
 * 2. THE AGENT-FACING CREATE PATH THREW ON EVERY CLICK. generateCDAPreview
 *    inserted transaction.agent_id — an AGENTS id — into
 *    closing_disclosure_agreement.agent_id, which FKs USERS. Verified live:
 *    23503, "Key (agent_id)=(…) is not present in table users". This is the
 *    THIRD instance of the same identity bug on the same column (m356 fixed
 *    notifyAgentOfPreliminaryCdAction, m364 fixed draftOrUpdateCdaAction) and
 *    the only one on the path an agent actually uses.
 *
 * 3. THE OWNER'S COMPLIANCE STEP WAS MISSING FROM THE SURVIVING RAIL.
 *    submitCdaForApprovalAction had a signature pre-scan and a contract/fee
 *    audit but never checked the deal FILE, so a CDA could reach the compliance
 *    officer with disclosures missing, documents rejected, or signatures still
 *    out. runFinalComplianceCheck — the canonical gate — lived only in the rail
 *    that was about to be deleted.
 *
 * 4. THE CHAIN HAD NO BEGINNING. uploadPreliminaryCdAction and
 *    notifyAgentOfPreliminaryCdAction were complete, tenant-scoped, and had NO
 *    CALLER ANYWHERE. Nothing told the agent the HUD had arrived, no task was
 *    opened, and the CD_RECEIVED kernel event never fanned out.
 *
 * 5. THE OWNING AGENT COULD NOT OPEN THE PAGE. The CDA page gated on
 *    `transaction.agent_id === user.id` — an agents id compared to a users id,
 *    false for everyone — so the agent whose CDA it was got redirected, and the
 *    split/cap panel read blank because the agents lookup keyed user_id with an
 *    agents id.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { evaluateFinalCompliance } from "../lib/transactions/final-compliance-check"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  existsSync(p)
    ? stripComments(readFileSync(p, "utf8"))
    : ""

/** Body of a top-level function, skipping the parameter list and any generics. */
function fnBody(source: string, name: string): string {
  const at = source.indexOf(`function ${name}`)
  if (at < 0) return ""
  let i = source.indexOf("(", at)
  if (i < 0) return ""
  let depth = 0
  for (; i < source.length; i++) {
    if (source[i] === "(") depth++
    else if (source[i] === ")") { depth--; if (depth === 0) { i++; break } }
  }
  const open = source.indexOf("{", i)
  if (open < 0) return ""
  depth = 0
  for (let j = open; j < source.length; j++) {
    if (source[j] === "{") depth++
    else if (source[j] === "}") { depth--; if (depth === 0) return source.slice(open, j + 1) }
  }
  return source.slice(open)
}

const PORTAL = "app/actions/cda-portal.ts"
const CLIENT = "app/dashboard/transactions/[id]/cda/cda-workflow-client.tsx"
const PAGE   = "app/dashboard/transactions/[id]/cda/page.tsx"
const DEAD   = "lib/transactions/cda-workflow.ts"

const portal = src(PORTAL)
const client = src(CLIENT)
const page   = src(PAGE)

console.log("\n── ONE rail, not two ──")
{
  check("the duplicate CDA rail is gone from disk", !existsSync(DEAD))
  const walk = (dir: string): string[] => {
    if (!existsSync(dir)) return []
    return readdirSync(dir).flatMap((e: string) => {
      const full = `${dir}/${e}`
      if (statSync(full).isDirectory()) return walk(full)
      return /\.tsx?$/.test(e) ? [full] : []
    })
  }
  const importers = ["app", "lib", "hooks"]
    .flatMap(walk)
    .filter((f) => /from ['"][^'"]*transactions\/cda-workflow['"]/.test(src(f)))
  check("nothing imports the deleted rail", importers.length === 0)
  check("lib/transactions no longer re-exports it",
    !/from '\.\/cda-workflow'/.test(src("lib/transactions/index.ts")))

  // The three verbs the deleted rail owned must not reappear as a second engine.
  for (const gone of ["generateCDAPreview", "submitCDA", "approveCDA"]) {
    check(`the agent-facing page no longer calls ${gone}`,
      !new RegExp(`\\b${gone}\\s*\\(`).test(client))
  }
  check("…and it calls the portal rail instead",
    /submitCdaForApprovalAction\s*\(/.test(client) &&
    /approveCdaAction\s*\(/.test(client) &&
    /draftOrUpdateCdaAction\s*\(/.test(client))
}

console.log("\n── the owner's step 3: FULL document compliance, BEFORE acceptance ──")
{
  const submit = fnBody(portal, "submitCdaForApprovalAction")
  check("submitCdaForApprovalAction exists", submit.length > 0)
  check("it runs the canonical final compliance check",
    /runFinalComplianceCheck\s*\(/.test(submit))
  // A check whose result is ignored is decoration. It must return early.
  check("…and a failure REFUSES the submission rather than warning",
    /if\s*\(\s*!\s*\w*[Cc]heck\.passed\s*\)[\s\S]{0,200}?return\s*\{[\s\S]{0,200}?success:\s*false/.test(submit))
  check("…and names the blockers, so the agent knows what to fix",
    /blockers:\s*\w*[Cc]heck\.blockers/.test(submit))

  // ORDER MATTERS. A gate that runs after the row is already flipped to
  // 'submitted' has not gated anything.
  const gateAt  = submit.indexOf("runFinalComplianceCheck")
  const writeAt = submit.indexOf('status: "submitted"')
  check("the gate runs BEFORE the CDA is flipped to submitted",
    gateAt >= 0 && writeAt >= 0 && gateAt < writeAt)

  // The gate is only as honest as its verdict.
  check("a clean file passes",
    evaluateFinalCompliance({ pendingSignatures: 0, missingDocs: 0, rejectedDocs: 0, blockingComplianceFailures: 0 }).passed)
  for (const key of ["pendingSignatures", "missingDocs", "rejectedDocs", "blockingComplianceFailures"] as const) {
    const input = { pendingSignatures: 0, missingDocs: 0, rejectedDocs: 0, blockingComplianceFailures: 0, [key]: 1 }
    const v = evaluateFinalCompliance(input)
    check(`an open ${key} blocks, and says so`, !v.passed && v.blockers.length === 1)
  }
}

console.log("\n── nothing was lost when the duplicate went away ──")
{
  const submit  = fnBody(portal, "submitCdaForApprovalAction")
  const approve = fnBody(portal, "approveCdaAction")
  check("the kernel still records cda.submitted", /eventType:\s*"cda\.submitted"/.test(submit))
  check("the kernel still records cda.approved",  /eventType:\s*"cda\.approved"/.test(approve))
  check("a contract discrepancy still raises the review activity",
    /activity_type:\s*"cda_review_required"/.test(submit))
}

console.log("\n── approval is NOT delivery — the broker signs in between ──")
{
  const approve = fnBody(portal, "approveCdaAction")
  // The deleted rail delivered to title inside approve. The owner's process puts
  // the broker's signature between approval and delivery, so approval must not
  // ship the money instruction.
  check("approveCdaAction does not send the CDA to the closing agent",
    !/deliverCdaToClosingAgent/.test(approve) && !/sent_to_title_at:/.test(approve))
  check("…and does not complete the delivery milestone",
    !/cda_delivered/.test(approve))
  check("delivery lives with the send, and records it",
    /sent_to_title_at/.test(fnBody(portal, "sendCdaToTitleAction")))
  check("the broker signature is its own explicit step",
    /export async function brokerSignCdaAction/.test(readFileSync(PORTAL, "utf8")))
}

console.log("\n── the chain has a beginning ──")
{
  check("the preliminary HUD upload is reachable from a screen",
    /uploadPreliminaryCdAction\s*\(/.test(client))
  check("…the screen captures WHO sent it (title / attorney / TC)",
    /uploadedByRole:/.test(client) &&
    /closing_attorney/.test(client) && /title_agent/.test(client))
  check("…and recording it notifies the agent",
    /notifyAgentOfPreliminaryCdAction/.test(fnBody(portal, "uploadPreliminaryCdAction")))
  const notify = fnBody(portal, "notifyAgentOfPreliminaryCdAction")
  check("the notification opens a task, not just a bell",
    /from\("tasks"\)[\s\S]{0,400}?insert/.test(notify))
  check("…and fans out CD_RECEIVED so sequences and portals hear it",
    /KernelEvent\.CD_RECEIVED/.test(notify))
}

console.log("\n── identity: RESOLVE, never substitute ──")
{
  // transactions.agent_id is an AGENTS id; user.id / cda.agent_id are USERS ids.
  check("the page resolves agents.id → user_id before the ownership test",
    /from\("agents"\)[\s\S]{0,300}?\.eq\("id",\s*transaction\.agent_id\)/.test(page))
  check("…and never compares the two id spaces directly",
    !/transaction\.agent_id\s*===\s*user\.id/.test(page))
  check("the agent record is no longer looked up by user_id using an agents id",
    !/\.eq\("user_id",\s*transaction\.agent_id\)/.test(page))
  // The create path that threw 23503 on every click is gone with the rail.
  check("no surviving path inserts an agents id into the users-FK column",
    !/agent_id:\s*transaction\.agent_id/.test(client) &&
    !/agentId:\s*transaction\.agent_id/.test(client))
}

console.log("\n── the solo / team route still bypasses the in-app broker steps ──")
{
  const submit  = fnBody(portal, "submitCdaForApprovalAction")
  const approve = fnBody(portal, "approveCdaAction")
  check("submit resolves the disposition route", /resolveDispositionRoute/.test(submit))
  check("…an off-platform brokerage routes to their own form platform",
    /external_form_platform/.test(submit))
  check("…and in-app approval refuses for that route",
    /external_form_platform/.test(approve) && /handled_via_external_form_platform/.test(approve))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ CDA_PROCESS_CHAIN_FAIL"); process.exit(1) }
console.log(" ✅ CDA_PROCESS_CHAIN_PASS — one rail, compliance runs before acceptance, the broker signs before it ships")
