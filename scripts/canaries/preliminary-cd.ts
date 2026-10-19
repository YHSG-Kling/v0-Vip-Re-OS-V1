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
  c.step("MEASURED AT HEAD (the unwired edge, lane 142C's contract): the title upload notifies NOBODY (no notification / notify helper in its body) and never reaches the CDA's preliminary_cd_* columns — only the CDA workflow client calls uploadPreliminaryCdAction", !/notif/i.test(upload) && !/preliminary_cd_|uploadPreliminaryCd|notifyAgentOfPreliminaryCd/.test(title) && /uploadPreliminaryCdAction/.test(strippedRepo("app/dashboard/transactions/[id]/cda/cda-workflow-client.tsx") ?? ""), "")

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
    c.step(`${h.lane} landed (${at}) — wire its export into this canary and assert the contract (WAVE142 HOOK (integrator): ${h.lane}): drive the title upload of a settlement statement through the bridge, assert the agent + TC bells, the preliminary_cd_* version, the correction request row and the revised version`, false, h.contract.slice(0, 120))
  }
  c.blind("Both doors are 'use server' (title actor session / CDA actor session) and are asserted on stripped source; the pure resolver ran on fixtures. The AI's EXPLANATION of a discrepancy (lane 142C) is not driven. No storage upload happens.")
  return c.report([], 0)
}
