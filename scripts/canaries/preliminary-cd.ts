/**
 * scripts/canaries/preliminary-cd.ts — PRELIMINARY HUD / CLOSING DISCLOSURE canary (wave 142, lane 142J):
 *   the TITLE COMPANY supplies it → agent + TC notified → attached as a VERSION → discrepancy vs the executed contract
 *   + waterfall identified (never fabricated) → correction request → revised statement → waterfall reconciled →
 *   the broker approves on corrected values
 * through the survivors at HEAD: app/actions/title-portal.ts uploadTitleDocument (the authorized title actor's upload —
 * session-bound, asserted on STRIPPED source), app/actions/cda-portal.ts uploadPreliminaryCdAction /
 * notifyAgentOfPreliminaryCdAction / requestCdaChangesAction / approveCdaAction (session-bound; the preliminary_cd_*
 * version columns, the revisions table written on every state change, the CD_RECEIVED kernel event),
 * lib/transactions/cda-template-fields.ts (resolveCdaTemplateFields — EVERY field carries the typed value AND the
 * computed EXPECTED baseline, so a discrepancy is a comparison, not a guess) and cdaWaterfallContext (the deterministic
 * numbers a statement is checked against). Owner (wave 142): "the TITLE COMPANY supplies it … AI may identify/explain
 * discrepancies, never fabricate values; never alter the title company's document."
 *
 * THE UNWIRED EDGE THIS CANARY HOLDS (SURVIVORS142 §4): a settlement statement uploaded through the title portal never
 * reaches closing_disclosure_agreement.preliminary_cd_* and notifies nobody — only the CDA workflow client calls the
 * preliminary-CD doors. Lane 142C's bridge is a WAVE142 HOOK. In-memory only (closing_disclosure_agreement: 0 live rows).
 */
import { LIVE, canary } from "./_harness"
import { hooksFor, readRepo, strippedRepo } from "./_registry"
import { exportedAsyncBodies } from "./crm-inbound"

export async function run() {
  const c = canary("Preliminary HUD/CD: title supplies → agent + TC told → versioned → discrepancy identified, never fabricated → correction → revised → reconciled → broker approves on corrected values")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — closing_disclosure_agreement holds 0 live rows")
  const title = strippedRepo("app/actions/title-portal.ts") ?? ""
  const cda = strippedRepo("app/actions/cda-portal.ts") ?? ""
  const upload = exportedAsyncBodies(title).find((f) => f.name === "uploadTitleDocument")?.body ?? ""

  // ── 1 · the title company's upload door (session-bound; stripped source) ──
  const gateAt = upload.search(/\brequireTitleActor\s*\(/), clientAt = upload.search(/\bcreateClient\s*\(/)
  c.step("TITLE SUPPLIES IT: uploadTitleDocument gates on requireTitleActor BEFORE any client, proves the transaction is assigned to the actor's title company (transaction_title_escrow by its email) and inside the actor's brokerage, and files the document as uploaded_by_type 'title' with settlement_statement / final_closing_disclosure among its types", gateAt >= 0 && clientAt > gateAt && /transaction_title_escrow/.test(upload) && /title_company_email/.test(upload) && /uploaded_by_type:\s*["']title["']/.test(upload) && /"settlement_statement"/.test(title) && /"final_closing_disclosure"/.test(title), "")
  // THE RULE (lane 142C landed, app/actions/title-portal.ts:336-368 — the 141J/142J waypoint "notifies nobody" is gone).
  c.step("THE BRIDGE (landed 142C): a settlement_statement uploaded by TITLE is handed IN THE SAME REQUEST to notifyAgentOfPreliminaryCdAction (the CDA's versioned attach + the bells), a final_closing_disclosure to attachFinalStatementFromTitle (uploadFinalCdAction when a CDA exists, else the commission finalization lock); the result is READ (r.success) and carried on the response (cda_bridge); a refusal is escalated at once to the brokerage's admins (title_statement_unattached) — never a document nobody was told about; the title portal lists the CDA among the documents it may read", /notifyAgentOfPreliminaryCdAction\(/.test(upload) && /attachFinalStatementFromTitle\(/.test(upload) && /["']settlement_statement["']/.test(upload) && /["']final_closing_disclosure["']/.test(upload) && /r\.success/.test(upload) && /notifyBrokerageAdmins\(/.test(upload) && /title_statement_unattached/.test(upload) && /cda_bridge/.test(upload) && /uploadFinalCdAction\(/.test(title) && /["']cda["']/.test(title) && /uploadPreliminaryCdAction/.test(strippedRepo("app/dashboard/transactions/[id]/cda/cda-workflow-client.tsx") ?? ""), "")

  // ── 2 · the CDA's own preliminary-CD doors: version columns, revisions, the immediate bell, the kernel event ──
  const prelim = exportedAsyncBodies(cda).find((f) => f.name === "uploadPreliminaryCdAction")?.body ?? ""
  const notifyPrelim = exportedAsyncBodies(cda).find((f) => f.name === "notifyAgentOfPreliminaryCdAction")?.body ?? ""
  c.step("ATTACHED AS A VERSION: uploadPreliminaryCdAction (tenant-pinned) files the statement as a transaction_documents row (doc_type preliminary_closing_disclosure) and DELEGATES to notifyAgentOfPreliminaryCdAction, which stamps preliminary_cd_uploaded_at / _document_id / _uploaded_by on the CDA, rings the agent (preliminary_cd_received), records the activity and emits the CD_RECEIVED kernel event; every CDA state change writes a closing_disclosure_agreement_revisions row (versions retained, never overwritten)", /\.from\(\s*["']transaction_documents["']\s*\)\s*\.insert/.test(prelim) && /["']preliminary_closing_disclosure["']/.test(prelim) && /brokerage_id\s*!==\s*auth\.brokerageId/.test(prelim) && /return\s+notifyAgentOfPreliminaryCdAction\(/.test(prelim) && /preliminary_cd_uploaded_at/.test(notifyPrelim) && /preliminary_cd_document_id/.test(notifyPrelim) && /preliminary_cd_uploaded_by/.test(notifyPrelim) && /preliminary_cd_received/.test(notifyPrelim) && /emitKernelEvent/.test(notifyPrelim) && /CD_RECEIVED/.test(notifyPrelim) && /\.from\(\s*["']closing_disclosure_agreement_revisions["']\s*\)\s*\.insert/.test(cda), "")
  const snapshot = readRepo("scripts/schema-snapshot.ts") ?? ""
  c.step("the live schema carries the version columns and the revisions table (schema-snapshot: closing_disclosure_agreement.preliminary_cd_uploaded_at + closing_disclosure_agreement_revisions)", /closing_disclosure_agreement_revisions/.test(snapshot) && /preliminary_cd_uploaded_at/.test(snapshot) && /final_cd_/.test(snapshot), "")
  const corrections = exportedAsyncBodies(cda).find((f) => f.name === "requestCdaChangesAction")?.body ?? ""
  const approve = exportedAsyncBodies(cda).find((f) => f.name === "approveCdaAction")?.body ?? ""
  c.step("CORRECTION LOOP + BROKER REVIEW exist on the CDA: requestCdaChangesAction records a reason and moves the CDA to changes_requested (the live status vocabulary), approveCdaAction gates through the pure policy (canApproveCda — separation of duties)", /changes_requested/.test(corrections) && /reason/.test(corrections) && /canApproveCda\(/.test(approve), "")

  // ── 3 · DISCREPANCY IDENTIFICATION, never fabrication (pure) ──
  const { resolveCdaTemplateFields, cdaWaterfallContext } = await import("../../lib/transactions/cda-template-fields")
  const waterfall = cdaWaterfallContext({ gross_commission: 24_000, agent_net: 16_800, brokerage_net: 7_200, distributions: [{ distribution_type: "fee", calculated_amount: 350 }, { distribution_type: "team", calculated_amount: 1_000 }] })
  c.step("the WATERFALL CONTEXT is deterministic arithmetic (gross 24,000 / agent 16,800 → 70% split; fees + team split summed by type) — the baseline every statement line is checked against; no model anywhere in it", waterfall.agent_split_percent === 70 && waterfall.fees === 350 && waterfall.team_split === 1_000 && waterfall.gross_commission === 24_000, JSON.stringify(waterfall))
  const defs = [
    { field_key: "sales_price", label: "Sales price", source: "transaction" as const, source_key: "sales_price", field_type: "currency" as const, required: true, pdf_field: "SalesPrice" },
    { field_key: "gross_commission", label: "Gross commission", source: "waterfall" as const, source_key: "gross_commission", field_type: "currency" as const, required: true, pdf_field: "GrossCommission" },
    { field_key: "agent_net", label: "Net to agent", source: "waterfall" as const, source_key: "agent_net", field_type: "currency" as const, required: true, pdf_field: "AgentNet" },
  ]
  const ctx = { waterfall, transaction: { sales_price: 400_000 }, agentInputs: {} as Record<string, string> }
  const untouched = resolveCdaTemplateFields(defs, ctx)
  const money = untouched.fields.filter((f) => f.source === "waterfall")
  c.step("the STATEMENT'S figures vs the contract + waterfall: an objective transaction fact (sales price) pre-fills; every MONEY line is blank until a human enters it and carries its EXPECTED baseline beside it ('expected $24,000.00') — the comparison the agent / TC review makes", untouched.fields.find((f) => f.field_key === "sales_price")?.value === 400_000 && money.every((f) => f.value === null && f.expected !== null) && money.find((f) => f.field_key === "gross_commission")?.expectedFormatted === "$24,000.00" && untouched.missingRequired.join() === "gross_commission,agent_net", untouched.missingRequired.join(","))
  const typed = resolveCdaTemplateFields(defs, { ...ctx, agentInputs: { gross_commission: "$24,000", agent_net: "17,000" } })
  const discrepancies = typed.fields.filter((f) => f.source === "waterfall" && f.value !== null && f.expected !== null && f.value !== f.expected).map((f) => ({ field: f.field_key, statement: f.formatted, expected: f.expectedFormatted }))
  c.step("DISCREPANCY IDENTIFIED, NOT FABRICATED: the statement's net-to-agent (17,000) differs from the waterfall's expected 16,800 → exactly ONE discrepancy named with both figures; the matching gross line is not one; neither value was altered by the resolver (the typed figure stays the typed figure)", discrepancies.length === 1 && discrepancies[0].field === "agent_net" && discrepancies[0].statement === "$17,000.00" && discrepancies[0].expected === "$16,800.00" && typed.fields.find((f) => f.field_key === "agent_net")?.value === 17_000, JSON.stringify(discrepancies))
  const corrected = resolveCdaTemplateFields(defs, { ...ctx, agentInputs: { gross_commission: "$24,000", agent_net: "$16,800" } })
  c.step("REVISED STATEMENT → reconciled: with the corrected figure entered (the revised official statement, a new version) the waterfall reconciles — 0 discrepancies, nothing required left blank — the state the broker approves on", corrected.fields.filter((f) => f.source === "waterfall" && f.value !== f.expected).length === 0 && corrected.missingRequired.length === 0, "")
  c.step("POSITIVE CONTROL: a required money line left blank keeps the CDA unsubmittable (missingRequired names it) — a blank is never read as 'matches'", resolveCdaTemplateFields(defs, { ...ctx, agentInputs: { gross_commission: "$24,000" } }).missingRequired.join() === "agent_net", "")
  const modelInCda = ["app/actions/cda-portal.ts", "lib/transactions/cda-template-fields.ts", "lib/transactions/cda-pdf-fill.ts", "app/actions/title-portal.ts"].filter((f) => /generateText|generateObject|gatewayChat|Routed\(/.test(strippedRepo(f) ?? ""))
  c.step("NEVER ALTERED BY A MODEL: the CDA doors, the field resolver, the PDF fill plan and the title upload name no model call (0 of 4) — the title company's document is attached as uploaded", modelInCda.length === 0, modelInCda.join(",") || "0 of 4")

  // ── WAVE142 HOOK (integrator): 142C — title upload → CDA version + immediate agent/TC bell; the discrepancy → correction-request → revised-statement loop. ──
  for (const h of hooksFor("preliminary-cd")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, "measured above: uploadTitleDocument writes transaction_documents and revalidates a path; no bell, no preliminary_cd_* stamp, no documented correction request to title"); continue }
    // WAVE142 HOOK (integrator): 142C — wired 142K: the review chain the doors call, driven PURE end to end
    // (lib/transactions/cda-closing-policy.ts); the session doors asserted on stripped source.
    const P = await import("../../lib/transactions/cda-closing-policy")
    const v1 = P.nextPreliminaryStatementVersion([]), v2 = P.nextPreliminaryStatementVersion([{ doc_type: "settlement_statement" }, { doc_type: "cda" }])
    const review1 = P.reviewOnNewStatementVersion(null, { version: v1, documentId: "doc-1", at: "2026-10-19T12:00:00.000Z" })
    const expected = { sales_price: 400_000, gross_commission: 24_000, agent_net: 16_800, brokerage_net: 7_200 }
    const cmp = P.comparePreliminaryStatementFigures({ sales_price: 400_000, gross_commission: 24_000, agent_net: 15_000, seller_credits: 3_000 }, expected)
    const lines = P.describePreliminaryDiscrepancies(cmp.discrepancies)
    const route = P.cdaDeliveryRoute({ titlePortalUserId: "u-title", titleEmail: "title@canary.test" })
    const requested = P.reviewOnCorrectionRequested(review1, { items: cmp.discrepancies, by: "tc-user", at: "2026-10-19T13:00:00.000Z", delivery: { route: route.route, recipient: "u-title", message_id: null, at: "2026-10-19T13:00:00.000Z" }, note: "net to agent differs from the waterfall" })
    const gateBlocked = P.cdaFigureGate(requested)
    const review2 = P.reviewOnNewStatementVersion(requested, { version: v2, documentId: "doc-2", at: "2026-10-20T09:00:00.000Z" })
    const cmp2 = P.comparePreliminaryStatementFigures({ sales_price: 400_000, gross_commission: 24_000, agent_net: 16_800 }, expected)
    const confirmed = P.reviewOnConfirmed(review2, "tc-user", "2026-10-20T10:00:00.000Z", "reconciled to the executed contract + waterfall")
    const roundTrip = P.preliminaryReviewOf({ preliminary_statement: confirmed })
    c.step(`${h.lane} landed (${at}) — THE REVIEW CHAIN (pure, the policy every door calls): version 1 opens pending_review on receipt; the comparison IDENTIFIES exactly one discrepancy (net to agent $15,000 vs the waterfall's $16,800: −$1,800, 10.7 %, a BLOCKER) over the fields BOTH sides state and lists the rest as unverifiable (never $0 invented); the correction request DOCUMENTS the items and how it reached title (the Deal-Team portal inbox wins over email); the broker CANNOT approve while a correction is outstanding (preliminary_statement_correction_pending); the REVISED statement opens version 2 with version 1's correction_requested RETAINED in history; its figures reconcile (0 discrepancies) → reviewed → the figure gate opens; the review survives the field_values round trip`, v1 === 1 && v2 === 2 && review1.status === "pending_review" && review1.version === 1 && cmp.compared.join() === "sales_price,gross_commission,agent_net" && cmp.unverifiable.includes("brokerage_net") && cmp.unverifiable.includes("seller_credits") && cmp.discrepancies.length === 1 && cmp.discrepancies[0].field === "agent_net" && cmp.discrepancies[0].severity === "blocker" && cmp.discrepancies[0].delta === -1_800 && lines.length === 1 && /15,000/.test(lines[0]) && /16,800/.test(lines[0]) && /must be corrected/.test(lines[0]) && route.route === "portal" && requested.status === "correction_requested" && requested.items.length === 1 && requested.delivery?.route === "portal" && !gateBlocked.ok && gateBlocked.error === "preliminary_statement_correction_pending" && review2.status === "pending_review" && review2.version === 2 && review2.history.length === 1 && review2.history[0].version === 1 && review2.history[0].status === "correction_requested" && cmp2.discrepancies.length === 0 && confirmed.status === "reviewed" && P.cdaFigureGate(confirmed).ok && roundTrip?.status === "reviewed" && roundTrip.history.length === 1 && P.cdaFigureGate(null).ok, `discrepancy: ${lines[0]?.slice(0, 120)}`)
    const correctionDoor = exportedAsyncBodies(cda).find((f) => f.name === "requestPreliminaryCdCorrectionAction")?.body ?? "", confirmDoor = exportedAsyncBodies(cda).find((f) => f.name === "confirmPreliminaryCdReviewAction")?.body ?? ""
    c.step(`${h.lane} the DOORS (stripped source): notifyAgentOfPreliminaryCdAction counts the version (nextPreliminaryStatementVersion over the prior statements), re-opens the review on every statement (reviewOnNewStatementVersion → field_values.preliminary_statement) and rings the agent AND the TC immediately; approveCdaAction asks cdaFigureGate; requestPreliminaryCdCorrectionAction records the documented discrepancies with their delivery (portal inbox or email) and confirmPreliminaryCdReviewAction marks the version reviewed — the title company's document is attached as uploaded, never altered (asserted above)`, /nextPreliminaryStatementVersion\(/.test(notifyPrelim) && /reviewOnNewStatementVersion\(/.test(notifyPrelim) && /preliminary_statement/.test(notifyPrelim) && /coordinator/i.test(notifyPrelim) && /cdaFigureGate\(/.test(approve) && /reviewOnCorrectionRequested\(/.test(correctionDoor) && /cdaDeliveryRoute\(/.test(correctionDoor) && /reviewOnConfirmed\(/.test(confirmDoor), "")
  }
  c.blind("Both doors are 'use server' (title actor session / CDA actor session) and are asserted on stripped source; the pure resolver ran on fixtures. The AI's EXPLANATION of a discrepancy (lane 142C) is not driven. No storage upload happens.")
  return c.report([], 0)
}
