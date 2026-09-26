#!/usr/bin/env tsx
/**
 * scripts/cda-financial-wiring-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MONEY RAIL STOPPED IN THREE PLACES, AND NONE OF THEM SAID SO.
 *
 * 1. THE SEND WAS NEVER RECORDED. sendCdaToTitleAction emailed the disbursement
 *    authorization to the closing agent and then wrote status:"delivered" — a value the
 *    live CHECK (closing_disclosure_agreement_status_check: awaiting_preliminary_cd |
 *    pending | drafting | submitted | changes_requested | approved | rejected | cancelled)
 *    REJECTS. supabase-js resolves a failed update instead of throwing and the result was
 *    never destructured, so the whole row update was a silent no-op: sent_to_title_at,
 *    _recipient and _method were never written. The owner's requirement is "sent to the
 *    closing agent WITH A RECORD OF THE SEND" and there was no record. The compliance
 *    queue buckets delivery off sent_to_title_at, so the signed CDA also sat in "awaiting
 *    delivery" forever and could be re-sent without limit.
 *
 * 2. THE AGENT COULD NOT SUBMIT. The CDA page gated its Submit button on status ===
 *    "pending", but draftOrUpdateCdaAction moves the row pending → DRAFTING the moment the
 *    agent opens it for drafting (and changes_requested → drafting on a re-edit). The
 *    button disappeared as soon as the agent started work and never came back.
 *
 * 3. NO COMMISSION COULD BE PAID BY HAND. The kernel enforces pending → approved → paid
 *    (COMMISSION_STATUS_TRANSITIONS) and markCommissionPaid VALIDATES it, so pending → paid
 *    is refused outright. markCommissionApprovedAction — the only manual pending → approved
 *    step — had no caller anywhere, and the commissions page rendered "Mark as Paid" on
 *    exactly the pending rows the kernel would refuse, swallowing the refusal.
 *
 * Plus the tail of the chain (final CD back from title, copy of the commission check, close
 * the file) and the CDA revision audit log had no surface at all.
 *
 * SOURCE layer: the wires exist, the illegal status write is gone, the error paths are
 * checked, and the approve step sits between pending and paid.
 * LIVE layer (creds-gated): prove against the real database that "delivered" is rejected
 * and the delivery columns are not, that non_cda_payout_method is CHECK-constrained, and
 * that agent_commissions refuses the two writes app/actions/agents.ts used to make.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/** Strip comments so an assertion can never be satisfied by prose describing the fix. */
const code = (p: string) => stripComments(src(p))

/**
 * Body of one exported function, up to the next top-level `export ` in the same file.
 * The `(` is part of the anchor on purpose: without it `foo` also matches `fooX`, and an
 * "exists" assertion that survives a rename proves nothing.
 */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`)
  if (start < 0) return ""
  const rest = source.slice(start + 10)
  const next = rest.indexOf("\nexport ")
  return next < 0 ? rest : rest.slice(0, next)
}

const PORTAL = "app/actions/cda-portal.ts"
const KERNEL_ACTIONS = "app/actions/financial-kernel.ts"
const CDA_PAGE = "app/dashboard/transactions/[id]/cda/cda-workflow-client.tsx"
const APPROVE_BTN = "app/components/features/financial/ApproveCommissionButton.tsx"
const PAYOUT_BTN = "app/components/features/financial/PayoutButton.tsx"
const COMMISSIONS_PAGE = "app/dashboard/financials/commissions/page.tsx"
const PAYOUTS_PAGE = "app/dashboard/financials/payouts/page.tsx"
const REPORTS_CLIENT = "app/dashboard/financials/reports/reports-client.tsx"

/** The statuses the live CHECK constraint actually permits on the CDA row. */
const LIVE_CDA_STATUSES = [
  "awaiting_preliminary_cd", "pending", "drafting", "submitted",
  "changes_requested", "approved", "rejected", "cancelled",
]

function sendRecordLayer() {
  console.log("\n[source · the record of the send]")
  const portal = code(PORTAL)
  const send = fnBody(portal, "sendCdaToTitleAction")

  check("sendCdaToTitleAction exists", send.length > 0)

  // Assert the CONSTRUCT, not the spelling: whatever this function writes into the CDA
  // row's `status` must be a value the live CHECK permits. Any other literal fails the
  // WHOLE update, taking the delivery record down with it. Scoped to the CDA table's own
  // update blocks — the milestone row on another table has its own vocabulary.
  const cdaUpdateBlocks = [...send.matchAll(/from\("closing_disclosure_agreement"\)\s*\.update\(\{([\s\S]*?)\}\)/g)].map(m => m[1])
  check("the send actually updates the CDA row", cdaUpdateBlocks.length > 0)
  const statusWrites = cdaUpdateBlocks.flatMap(b => [...b.matchAll(/status:\s*"([a-z_]+)"/g)].map(m => m[1]))
  check("the send never writes a CDA status the live CHECK rejects",
    statusWrites.every(s => LIVE_CDA_STATUSES.includes(s)))

  check("...and the delivery IS recorded (sent_to_title_at + recipient + method)",
    /sent_to_title_at:/.test(send) && /sent_to_title_recipient:/.test(send) && /sent_to_title_method:/.test(send))

  // supabase-js RESOLVES a failed write. Without destructuring `error`, a rejected update
  // is indistinguishable from a successful one — which is exactly how the record of the
  // send disappeared while the caller was told it worked.
  check("...and the write is error-checked, not fire-and-forget",
    /const\s*\{\s*(data:\s*\w+,\s*)?error:\s*\w+\s*\}\s*=\s*await\s+supabase[\s\S]{0,400}?sent_to_title_at/.test(send)
    || /sent_to_title_at[\s\S]{0,400}?\.eq\("id",\s*cda\.id\)[\s\S]{0,200}?if\s*\(\s*\w*[Ee]rr\w*\s*\)/.test(send))

  check("...a failed delivery write returns failure to the caller",
    /return\s*\{\s*success:\s*false[\s\S]{0,120}?delivery_not_recorded/.test(send))

  // The filter itself, not a mention of the milestone name anywhere in the function.
  check("the cda_delivered milestone still completes on the real delivery",
    /from\("transaction_milestones"\)\s*\.update\(\{\s*status:\s*"completed"[\s\S]{0,300}?\.or\("[^"]*cda_delivered[^"]*"\)/.test(send))

  console.log("\n[source · the audit log is written AND checked]")
  check("recordRevision destructures the insert error",
    /async function recordRevision[\s\S]{0,900}?const\s*\{\s*error\s*\}\s*=\s*await\s+supabase\s*\.from\("closing_disclosure_agreement_revisions"\)/.test(portal))
}

function tailLayer() {
  console.log("\n[source · the tail of the chain has a way in]")
  const portal = code(PORTAL)

  check("recordCdaClosingArtifactAction records the document AND attaches it",
    /export async function recordCdaClosingArtifactAction/.test(portal) &&
    /from\("transaction_documents"\)[\s\S]{0,600}?\.insert\(/.test(fnBody(portal, "recordCdaClosingArtifactAction")) &&
    /uploadFinalCdAction\(/.test(fnBody(portal, "recordCdaClosingArtifactAction")) &&
    /uploadCdaCheckCopyAction\(/.test(fnBody(portal, "recordCdaClosingArtifactAction")))

  check("...it is tenant-scoped to the caller's brokerage",
    /\.eq\("brokerage_id",\s*auth\.brokerageId\)/.test(fnBody(portal, "recordCdaClosingArtifactAction")))

  // Each of these updates a money record. An unchecked update reports success on a write
  // that never happened — and for the final CD it would also skip the finalization lock.
  for (const fn of ["uploadFinalCdAction", "uploadCdaCheckCopyAction", "closeCdaAction", "recordNonCdaPayoutPreferenceAction"]) {
    const body = fnBody(portal, fn)
    check(`${fn} checks the update error and a no-match`,
      /(error:\s*\w+|,\s*error)\s*\}\s*=\s*await\s+supabase/.test(body) &&
      /if\s*\(\s*\w*[Ee]rr\w*\s*\)\s*return\s*\{\s*success:\s*false/.test(body) &&
      /not_found/.test(body))
  }

  check("uploadFinalCdAction still fires the 'cd_uploaded' finalization lock",
    /finalizeTransactionCommission\(supabase,\s*finalTxnId,\s*"cd_uploaded"\)/.test(fnBody(portal, "uploadFinalCdAction")))

  check("closeCdaAction is role-gated (closing a disbursement file is not an agent action)",
    /COMPLIANCE_ROLES\.has\(auth\.userType\)/.test(fnBody(portal, "closeCdaAction")))

  console.log("\n[source · the signature pre-scan speaks the database's vocabulary]")
  const scan = fnBody(portal, "runSignatureCheckForCdaAction")
  // "received" / "signed" / "complete" are not in transaction_documents' status CHECK —
  // they could never match a row, so they were decoration on a money gate.
  check("no phantom transaction_documents statuses remain in the pass-list",
    !/"received"/.test(scan) && !/\["received"/.test(scan))
  check("a document in the terminal SIGNED state is not reported as unsigned",
    /DOC_SIGNED_OFF[\s\S]{0,120}?"signed"/.test(scan))
  check("a failed scan write returns failure (a dropped write would leave the gate OPEN)",
    /scanErr[\s\S]{0,120}?return\s*\{\s*success:\s*false/.test(scan))
}

function cdaSurfaceLayer() {
  console.log("\n[source · the agent-facing CDA page]")
  const page = code(CDA_PAGE)

  for (const fn of ["recordCdaClosingArtifactAction", "closeCdaAction", "recordNonCdaPayoutPreferenceAction", "getCdaForTransactionAction"]) {
    check(`${fn} is imported AND called from the CDA page`,
      new RegExp(`import[\\s\\S]{0,900}?\\b${fn}\\b[\\s\\S]{0,900}?from "@/app/actions/cda-portal"`).test(page) &&
      new RegExp(`await\\s+${fn}\\(`).test(page))
  }

  // THE SEVERED MIDDLE. Assert the construct: the page's submittable set must contain
  // every status submitCdaForApprovalAction itself accepts — not just "pending".
  const portal = code("app/actions/cda-portal.ts")
  const submitBody = fnBody(portal, "submitCdaForApprovalAction")
  const accepted = [...(submitBody.match(/\[([^\]]*)\]\.includes\(cda\.status\)/) ?? [])[1]
    ?.matchAll(/"([a-z_]+)"/g) ?? []].map(m => m[1])
  check("the action still names the statuses it accepts", accepted.length >= 3)
  const gate = (page.match(/const\s+SUBMITTABLE\s*=\s*\[([^\]]*)\]/) ?? [])[1] ?? ""
  const gated = [...gate.matchAll(/"([a-z_]+)"/g)].map(m => m[1])
  check("the Submit button is offered for EVERY status the action accepts",
    accepted.length > 0 && accepted.every(s => gated.includes(s)))
  check("...and the gate is what actually drives canSubmit",
    /canSubmit\s*=\s*!!cda\s*&&\s*SUBMITTABLE\.includes\(cdaStatus\)/.test(page))

  check("drafting and changes_requested are no longer rendered as 'Not Started'",
    /case\s+"drafting"/.test(page) && /case\s+"changes_requested"/.test(page))
}

function payoutLadderLayer() {
  console.log("\n[source · pending → approved → paid]")
  const kernel = code("lib/kernel/financial.ts")

  // The premise the whole wire rests on: the kernel refuses pending → paid.
  const transitions = (kernel.match(/COMMISSION_STATUS_TRANSITIONS[^=]*=\s*\{([\s\S]*?)\n\}/) ?? [])[1] ?? ""
  const pendingTargets = (transitions.match(/pending:\s*\[([^\]]*)\]/) ?? [])[1] ?? ""
  check("the kernel still refuses pending → paid (approval is mandatory)",
    pendingTargets.includes("approved") && !pendingTargets.includes("paid"))
  check("...and markCommissionPaid enforces that table",
    /COMMISSION_STATUS_TRANSITIONS\[oldStatus\]\?\.includes\(newStatus\)/.test(fnBody(kernel, "markCommissionPaid")))

  const actions = code(KERNEL_ACTIONS)
  check("markCommissionApprovedAction attributes the approval to the SESSION, not the client",
    /approvedBy:\s*input\.approvedBy\s*\?\?\s*ctx\.userId/.test(fnBody(actions, "markCommissionApprovedAction")))

  const btn = code(APPROVE_BTN)
  check("an approve surface exists and calls markCommissionApprovedAction",
    /markCommissionApprovedAction\(\{/.test(btn) &&
    /from "@\/app\/actions\/financial-kernel"/.test(btn))
  // On the FAILURE branch specifically — a setError(null) reset at the top of the handler
  // is not the same thing as telling the broker the approval was refused.
  check("...and it surfaces a refusal instead of swallowing it",
    /else\s*\{[\s\S]{0,300}?setError\([^)]*result/.test(btn))

  const payoutBtn = code(PAYOUT_BTN)
  check("the payout button no longer swallows the kernel's refusal",
    /else\s*\{[\s\S]{0,200}?setError\(/.test(payoutBtn))

  for (const [label, path] of [["commissions", COMMISSIONS_PAGE], ["payouts", PAYOUTS_PAGE]] as const) {
    const p = code(path)
    check(`the ${label} page mounts the approve step`, /<ApproveCommissionButton/.test(p))
    // The ladder: approve is offered on pending, payout only on approved. Offering payout
    // on a pending row is the defect — a button that cannot ever pay.
    check(`...and offers payout only on APPROVED rows on the ${label} page`,
      /status\s*===\s*'approved'[\s\S]{0,200}?<PayoutButton/.test(p) &&
      !/status\s*===\s*'pending'[\s\S]{0,160}?<PayoutButton/.test(p))
  }

  console.log("\n[source · brokerage-level reporting]")
  const reports = code(REPORTS_CLIENT)
  check("exportFinancialReportAction is called from the reports surface",
    /await\s+exportFinancialReportAction\(\{/.test(reports))
  check("emailFinancialReportAction is called from the reports surface",
    /await\s+emailFinancialReportAction\(\{/.test(reports))
  check("...gated to broker/admin (it reads WHOLE-brokerage financials)",
    /isBrokerAdmin/.test(reports) && /isBrokerAdmin\s*&&/.test(reports))
}

function agentsLedgerLayer() {
  // ── RETARGETED IN WAVE 27 ──────────────────────────────────────────────────
  // This layer asserted its four rules against app/actions/agents.ts:
  // addAgentCommission — the SECOND commission writer, which could never have
  // run (it omitted the NOT NULL brokerage anchor and inserted two GENERATED
  // ALWAYS columns). Wave 26 ported the only two things it carried that the
  // canonical creator did not — the caller's real `close_date` and the deal
  // `side` — onto lib/kernel/financial.ts:createCommissionRecord, and wave 27
  // retired the duplicate (tombstone in app/actions/agents.ts naming that
  // survivor).
  //
  // The rules did not move with the duplicate; they moved onto the writer that
  // now has to obey them. Every one is kept, and two got STRICTER in the move:
  // the brokerage anchor is asserted as the SESSION's tenant (`ctx.brokerageId`)
  // rather than one re-derived from a body-supplied agent id, and the
  // splits-ledger check is now scoped to the survivor's body instead of being
  // matched anywhere in a 1,500-line action file.
  //
  // The first check is this layer's positive control: fnBody returns "" for a
  // function that is absent or renamed, so a slice that silently stopped
  // resolving fails here rather than reporting a clean bill of health.
  console.log("\n[source · the ONE commission writer on this rail]")
  const kernel = code("lib/kernel/financial.ts")
  const create = fnBody(kernel, "createCommissionRecord")

  // agent_commission / brokerage_commission are GENERATED ALWAYS columns; inserting into
  // them is rejected by Postgres outright.
  // Scoped to the agent_commissions insert itself — the splits-ledger insert further down
  // carries a brokerage_id too, and would otherwise satisfy the anchor assertion for it.
  const commissionInsert = (create.match(/from\("agent_commissions"\)\s*\.insert\(\{([\s\S]*?)\}\)/) ?? [])[1] ?? ""
  check("the canonical creator still inserts into the commission ledger", commissionInsert.length > 0)
  check("it does not insert the GENERATED columns",
    commissionInsert.length > 0
    && !/agent_commission:\s/.test(commissionInsert) && !/brokerage_commission:\s/.test(commissionInsert))
  check("...and supplies the NOT NULL brokerage anchor FROM THE SESSION",
    /brokerage_id:\s*ctx\.brokerageId/.test(commissionInsert))
  check("...and checks the splits-ledger write",
    /const\s*\{\s*error:\s*splitErr\s*\}\s*=\s*await\s+supabase\.from\("commission_splits"\)/.test(create))
  // The single-writer rule the retirement establishes, asserted on STRIPPED
  // source so the tombstone that records it cannot satisfy it.
  check("agents.ts holds no second writer of the commission ledger",
    !/from\("agent_commissions"\)\s*\.insert\(/.test(code("app/actions/agents.ts")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the source layer proved the shape"); return }
  console.log("\n[live · what the database actually accepts]")
  const svc = createClient(url, key, { auth: { persistSession: false } })

  const stamp = `zz_cdawire_${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: brk } = await svc.from("brokerages").insert({ name: stamp }).select("id").single()
    if (!brk) { console.log("  ⊘ could not seed a brokerage — skipping live"); return }
    const brokerageId = (brk as any).id as string
    cleanup.push({ table: "brokerages", id: brokerageId })

    const { data: usr } = await svc.from("users").insert({
      email: `${stamp}@example.invalid`, brokerage_id: brokerageId,
      user_type: "agent", first_name: "ZZ", last_name: "CdaWire",
    }).select("id").single()
    if (!usr) { console.log("  ⊘ could not seed a user — skipping live"); return }
    cleanup.push({ table: "users", id: (usr as any).id })

    const { data: ag } = await svc.from("agents")
      .insert({ user_id: (usr as any).id, brokerage_id: brokerageId }).select("id").single()
    if (!ag) { console.log("  ⊘ could not seed an agent — skipping live"); return }
    const agentId = (ag as any).id as string
    cleanup.push({ table: "agents", id: agentId })

    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, agent_id: agentId, status: "closed", deal_name: stamp,
    }).select("id").single()
    if (!txn) { console.log("  ⊘ could not seed a transaction — skipping live"); return }
    const transactionId = (txn as any).id as string
    cleanup.push({ table: "transactions", id: transactionId })

    const { data: cda } = await svc.from("closing_disclosure_agreement").insert({
      transaction_id: transactionId, brokerage_id: brokerageId, agent_id: agentId,
      status: "approved", revision_number: 1,
      broker_approved_at: new Date().toISOString(),
    }).select("id").single()
    if (!cda) { console.log("  ⊘ could not seed a CDA — skipping live"); return }
    const cdaId = (cda as any).id as string
    cleanup.push({ table: "closing_disclosure_agreement", id: cdaId })

    // THE DEFECT, PROVEN: the status the old send wrote is rejected by the constraint.
    const { error: deliveredErr } = await svc.from("closing_disclosure_agreement")
      .update({ status: "delivered" }).eq("id", cdaId)
    check("live: status 'delivered' is REJECTED by the CHECK (the old write was a no-op)",
      !!deliveredErr)

    // THE FIX: the delivery columns take the record, and the status stays legal.
    const sentAt = new Date().toISOString()
    const { error: sendErr } = await svc.from("closing_disclosure_agreement")
      .update({ sent_to_title_at: sentAt, sent_to_title_recipient: "closer@title.invalid", sent_to_title_method: "email" })
      .eq("id", cdaId)
    check("live: the delivery record IS accepted", !sendErr)

    const { data: after } = await svc.from("closing_disclosure_agreement")
      .select("status, sent_to_title_at, sent_to_title_recipient").eq("id", cdaId).maybeSingle()
    check("live: the record of the send is on the row and the status is unharmed",
      !!(after as any)?.sent_to_title_at && (after as any)?.status === "approved" &&
      (after as any)?.sent_to_title_recipient === "closer@title.invalid")

    // non_cda_payout_method is CHECK-constrained to the two values the action offers.
    const { error: badPayout } = await svc.from("closing_disclosure_agreement")
      .update({ non_cda_payout_method: "wire" }).eq("id", cdaId)
    check("live: an off-vocabulary payout method is rejected", !!badPayout)
    const { error: okPayout } = await svc.from("closing_disclosure_agreement")
      .update({ uses_cda: false, non_cda_payout_method: "direct_deposit" }).eq("id", cdaId)
    check("live: 'direct_deposit' — what the surface offers — is accepted", !okPayout)

    // The two writes app/actions/agents.ts used to make against the commission ledger.
    const { error: genErr } = await svc.from("agent_commissions").insert({
      brokerage_id: brokerageId, agent_id: agentId, transaction_id: transactionId,
      gross_commission: 10000, agent_split_percent: 70,
      close_date: new Date().toISOString().slice(0, 10),
      agent_commission: 7000, brokerage_commission: 3000, status: "pending",
    } as any)
    check("live: inserting the GENERATED commission columns is rejected", !!genErr)

    const { error: anchorErr } = await svc.from("agent_commissions").insert({
      agent_id: agentId, transaction_id: transactionId,
      gross_commission: 10000, agent_split_percent: 70,
      close_date: new Date().toISOString().slice(0, 10), status: "pending",
    } as any)
    check("live: a commission with no brokerage anchor is rejected", !!anchorErr)

    const { data: comm, error: commErr } = await svc.from("agent_commissions").insert({
      brokerage_id: brokerageId, agent_id: agentId, transaction_id: transactionId,
      gross_commission: 10000, agent_split_percent: 70,
      close_date: new Date().toISOString().slice(0, 10), status: "pending",
    }).select("id, agent_commission").single()
    check("live: the corrected shape inserts and the database computes the split",
      !commErr && Number((comm as any)?.agent_commission) === 7000)
    if (comm) cleanup.push({ table: "agent_commissions", id: (comm as any).id })

    // The ladder the approve button exists to complete.
    if (comm) {
      const { error: approveErr } = await svc.from("agent_commissions")
        .update({ status: "approved", approved_at: new Date().toISOString() }).eq("id", (comm as any).id)
      check("live: pending → approved is a legal state for the ledger row", !approveErr)
      const { error: paidErr } = await svc.from("agent_commissions")
        .update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", (comm as any).id)
      check("live: approved → paid is a legal state for the ledger row", !paidErr)
    }
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let leftover = 0
    for (const c of cleanup) {
      const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id)
      leftover += count ?? 0
    }
    check("live: cleanup count == 0", leftover === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" CDA + FINANCIAL WIRING — the record of the send, the submit the agent")
  console.log(" could never click, and the approval no commission could ever get")
  console.log("══════════════════════════════════════════════════════════════════════")
  sendRecordLayer()
  tailLayer()
  cdaSurfaceLayer()
  payoutLadderLayer()
  agentsLedgerLayer()
  await liveLayer()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`CDA/FINANCIAL WIRING — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
    console.log("\nThis is the disbursement rail. A status the CHECK rejects, an unchecked")
    console.log("update, or a payout offered on an unapprovable row all fail the same way:")
    console.log("silently, with the user told it worked and the money left where it was.")
    process.exit(1)
  }
  console.log("✅ CDA_FINANCIAL_WIRING_PASS — the send is recorded, the agent can submit,")
  console.log("   and a commission has a route from pending to paid")
}

main().catch((e) => { console.error(e); process.exit(1) })
