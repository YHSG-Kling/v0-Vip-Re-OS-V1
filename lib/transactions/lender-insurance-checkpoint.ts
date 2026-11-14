// lib/transactions/lender-insurance-checkpoint.ts
//
// THE LENDER-REQUIRED INSURANCE CHECKPOINT — the I/O half (wave 153, lane 153C; directive §153C C3; owner ruling 7).
// The pure rule is lib/transactions/hazard-insurance.ts readLenderInsuranceCheckpoint; this module reads the facts it needs
// (tenant-pinned, every error read), writes the lender's requirement onto transaction_lenders.insurance_requirement (m907), records
// the acceptance of the evidence, settles the computed compliance row the existing closing gate reads, and opens the settlement /
// Closing Disclosure recheck request when the premium changes. No coverage, amount or deadline is ever invented.
//
//   requirement   the assigned LENDER (on the platform) → source lender_portal; the agent / TC relaying the lender → agent/tc_reported.
//                 "Not required" is the LENDER's statement only (a relayed "not required" could clear a hold nobody verified).
//   acceptance    the lender, or compliance / an admin reviewing the binder against the lender's written requirement.
//   the hold      transaction_compliance_log row `lender_insurance_evidence` through the ONE settle helper
//                 (lib/compliance/trid-disclosure-clock-evidence.ts settleLenderComplianceRow) — blocking or warning per the
//                 tenant's policy once the checkpoint is due; passed when accepted / not required / cash / seller side.
//   premium       a changed annual premium on a financed deal opens ONE ledgered `compliance_correction` request naming the lender,
//                 which the settlement reconciliation already counts as an open correction (lib/offers/closing-cost-accuracy.ts).

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  LENDER_INSURANCE_COVERAGES,
  LENDER_INSURANCE_ESCROW,
  LENDER_INSURANCE_SOURCES,
  LENDER_INSURANCE_VERIFIERS,
  normalizeLenderInsuranceRequirement,
  readHazardInsurance,
  readLenderInsuranceCheckpoint,
  readLenderInsuranceCheckpointPolicy,
  selectHazardService,
  type HazardServiceRow,
  type LenderInsuranceCheckpoint,
  type LenderInsuranceRequirement,
} from "@/lib/transactions/hazard-insurance"

type Svc = SupabaseClient<any, any, any>

const CHECK = { type: "lender_insurance_evidence", label: "Lender-required insurance evidence" } as const
const PREMIUM_RECHECK_TITLE = "[Compliance correction] Homeowner's insurance premium changed"

interface Facts {
  checkpoint: LenderInsuranceCheckpoint
  requirement: LenderInsuranceRequirement | null
  lenderRowId: string | null
  financing: "cash" | "financed" | null
  representsBuyer: boolean
  policyDocumentId: string | null
  lender: { vendorId: string | null; name: string | null; onPlatform: boolean }
}

/** Read every fact the checkpoint rule needs for ONE deal. A refused read returns ok:false — the caller holds, never passes. */
export async function loadLenderInsuranceCheckpoint(svc: Svc, input: { brokerageId: string; transactionId: string; today?: string }): Promise<{ ok: true; facts: Facts } | { ok: false; error: string }> {
  const B = input.brokerageId, T = input.transactionId
  const { data: tx, error: txErr } = await svc.from("transactions").select("id, financing_type, close_date, appraisal_deadline, financing_deadline, deal_type").eq("id", T).eq("brokerage_id", B).maybeSingle()
  if (txErr) return { ok: false, error: `the deal could not be read: ${txErr.message}` }
  if (!tx) return { ok: false, error: "the deal was not found in this account" }
  const { lenderPresence } = await import("@/lib/compliance/trid-disclosure-clock-evidence")
  const [lenders, services, settings, lp] = await Promise.all([
    svc.from("transaction_lenders").select("id, insurance_requirement").eq("brokerage_id", B).eq("transaction_id", T).order("created_at", { ascending: false }).limit(1),
    svc.from("transaction_vendor_services").select("id, service_type, status, vendor_name, vendor_id, quote_amount, cost, policy").eq("brokerage_id", B).eq("transaction_id", T).eq("service_type", "insurance_quote").order("created_at", { ascending: false }).limit(50),
    svc.from("brokerage_settings").select("settings").eq("brokerage_id", B).maybeSingle(),
    lenderPresence(svc, B, T),
  ])
  if (lenders.error) return { ok: false, error: `the lender record could not be read: ${lenders.error.message}` }
  if (services.error) return { ok: false, error: `the insurance record could not be read: ${services.error.message}` }
  if (settings.error) return { ok: false, error: `the account's checkpoint setting could not be read: ${settings.error.message}` }
  if (!lp.ok) return { ok: false, error: lp.error }
  const t = tx as { financing_type: string | null; close_date: string | null; appraisal_deadline: string | null; financing_deadline: string | null; deal_type: string | null }
  const { financingKindFor } = await import("@/lib/compliance/checklist-dimensions")
  const financing = financingKindFor(t.financing_type) ?? null
  const representsBuyer = t.deal_type === "buyer" || t.deal_type === "dual" || t.deal_type == null
  const lenderRow = ((lenders.data ?? []) as Array<{ id: string; insurance_requirement: unknown }>)[0] ?? null
  const requirement = normalizeLenderInsuranceRequirement(lenderRow?.insurance_requirement ?? null)
  const policy = readHazardInsurance({ service: selectHazardService((services.data ?? []) as unknown as HazardServiceRow[]), closeDate: t.close_date, now: new Date(), representsBuyer, financing })
  const policySetting = readLenderInsuranceCheckpointPolicy(((settings.data ?? null) as { settings?: Record<string, unknown> | null } | null)?.settings?.lender_insurance_checkpoint ?? null)
  const checkpoint = readLenderInsuranceCheckpoint({
    financing, representsBuyer, requirement, policy,
    appraisalDeadline: t.appraisal_deadline ? String(t.appraisal_deadline).slice(0, 10) : null,
    financingDeadline: t.financing_deadline ? String(t.financing_deadline).slice(0, 10) : null,
    closeDate: t.close_date ? String(t.close_date).slice(0, 10) : null,
    policySetting, lenderOnPlatform: lp.lender.onPlatform, today: input.today ?? new Date().toISOString().slice(0, 10),
  })
  return { ok: true, facts: { checkpoint, requirement, lenderRowId: lenderRow?.id ?? null, financing, representsBuyer, policyDocumentId: policy.documentId, lender: lp.lender } }
}

/** Settle the computed compliance row from the checkpoint. Idempotent; called after every write and by the daily sweep. */
export async function syncLenderInsuranceCheckpoint(svc: Svc, input: { brokerageId: string; transactionId: string; today?: string }): Promise<{ ok: true; checkpoint: LenderInsuranceCheckpoint; changed: boolean } | { ok: false; error: string }> {
  const loaded = await loadLenderInsuranceCheckpoint(svc, input)
  if (!loaded.ok) return loaded
  const c = loaded.facts.checkpoint
  const clears = ["verified", "not_required", "not_applicable_cash", "not_our_side"].includes(c.state)
  const verdict: "pass" | "hold" | "warn" | "leave" = c.hold === "blocking" ? "hold" : c.hold === "warning" ? "warn" : clears ? "pass" : "leave"
  const { settleLenderComplianceRow } = await import("@/lib/compliance/trid-disclosure-clock-evidence")
  const s = await settleLenderComplianceRow(svc, {
    brokerageId: input.brokerageId, transactionId: input.transactionId, checkType: CHECK.type, checkLabel: CHECK.label, verdict,
    reason: `${c.label}: ${c.detail}${c.coaching ? ` ${c.coaching}` : ""}`, createIfMissing: verdict === "hold" || verdict === "warn",
  })
  if (!s.ok) return { ok: false, error: s.error ?? "the insurance compliance row could not be settled" }
  return { ok: true, checkpoint: c, changed: s.changed }
}

type Outcome = { ok: true; checkpoint: LenderInsuranceCheckpoint } | { ok: false; code: "invalid" | "forbidden" | "not_found" | "unavailable"; error: string }

/** Write the requirement onto the lender's row (insert one when the deal has none), ledgered, then sync the checkpoint. */
async function writeRequirement(svc: Svc, input: { brokerageId: string; transactionId: string; userId: string; lenderName: string | null; next: Record<string, unknown>; action: string; today?: string }): Promise<Outcome> {
  // The derived source / verifier must be in the ONE vocabulary the m907 CHECK mirrors (refused here, never as a silent PostgREST refusal).
  const src = input.next.source, ver = input.next.evidence_verified_source
  if ((src != null && !(LENDER_INSURANCE_SOURCES as readonly unknown[]).includes(src)) || (ver != null && !(LENDER_INSURANCE_VERIFIERS as readonly unknown[]).includes(ver))) {
    return { ok: false, code: "invalid", error: "This insurance record could not be classified. Nothing was saved." }
  }
  const loaded = await loadLenderInsuranceCheckpoint(svc, { brokerageId: input.brokerageId, transactionId: input.transactionId, today: input.today })
  if (!loaded.ok) return { ok: false, code: "unavailable", error: "The deal's lender record could not be read right now. Nothing was saved." }
  const B = input.brokerageId, T = input.transactionId
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const result = await withActionLedger<{ error: string | null }>(
    {
      brokerageId: B, action: input.action, actor: { type: "user", userId: input.userId }, subject: { type: "transaction", id: T },
      reasonCode: "TRANSACTION_MILESTONE", reasonDetail: "lender insurance requirement / evidence", riskClass: "LOW_RISK_WRITE", systemSource: "lender_insurance_checkpoint",
      idempotencyKey: `lender-insurance:${B}:${T}:${input.action}:${JSON.stringify(input.next).length}:${String(input.next.recorded_at ?? input.next.evidence_verified_at ?? "")}`,
      detail: { required: input.next.required ?? null, source: input.next.source ?? null, verified: !!input.next.evidence_verified_at },
    },
    async () => {
      if (loaded.facts.lenderRowId) {
        const { data, error } = await svc.from("transaction_lenders").update({ insurance_requirement: input.next, updated_at: new Date().toISOString() })
          .eq("id", loaded.facts.lenderRowId).eq("brokerage_id", B).select("id")
        if (error) return { error: error.message }
        if (!data || data.length === 0) return { error: "the lender record was not updated — it no longer exists in this account" }
        return { error: null }
      }
      const { data, error } = await svc.from("transaction_lenders").insert({ transaction_id: T, brokerage_id: B, lender_name: input.lenderName ?? loaded.facts.lender.name ?? null, insurance_requirement: input.next }).select("id")
      if (error) return { error: error.message }
      return { error: (data ?? []).length === 1 ? null : "the lender record was not written" }
    },
    { settle: (x) => x.error ? { status: "failed", outcome: "refused", error: x.error } : { status: "executed", outcome: "recorded" }, replay: () => ({ error: null }) },
    { client: svc as never },
  )
  if (result.error) return { ok: false, code: "unavailable", error: "The insurance requirement could not be saved right now. Nothing was saved." }
  const synced = await syncLenderInsuranceCheckpoint(svc, { brokerageId: B, transactionId: T, today: input.today })
  if (!synced.ok) return { ok: false, code: "unavailable", error: "The requirement was saved, but the closing checklist could not be refreshed yet — it refreshes on the next check." }
  return { ok: true, checkpoint: synced.checkpoint }
}

/**
 * Record WHAT THE LENDER REQUIRES. `kind` is resolved by the governed door from the session: the assigned lender (re-checked here
 * against the deal's lender assignment), or the agent / TC relaying the lender. Only the lender may state "not required".
 */
export async function recordLenderInsuranceRequirement(svc: Svc, input: {
  brokerageId: string; transactionId: string; actor: { userId: string; kind: "lender" | "agent" | "tc"; lenderVendorId?: string | null }
  required: boolean; coverages?: string[]; otherCoverage?: string | null; mortgageeClause?: string | null; escrowTreatment?: string | null
  evidenceRecipient?: string | null; dueDate?: string | null; lenderName?: string | null; today?: string
}): Promise<Outcome> {
  if (!input.brokerageId || !input.transactionId || !input.actor?.userId) return { ok: false, code: "forbidden", error: "Sign in to record the lender's insurance requirement." }
  if (typeof input.required !== "boolean") return { ok: false, code: "invalid", error: "Say whether the lender requires insurance evidence." }
  const kind = input.actor.kind
  if (!input.required && kind !== "lender") return { ok: false, code: "forbidden", error: "Only the lender can state that no insurance evidence is required — ask the lender to confirm it." }
  const coverages = [...new Set(input.coverages ?? [])]
  if (!coverages.every((c) => (LENDER_INSURANCE_COVERAGES as readonly string[]).includes(c))) return { ok: false, code: "invalid", error: "One of the coverage types is not recognized." }
  if (input.required && coverages.length === 0) return { ok: false, code: "invalid", error: "Choose the coverage the lender requires (homeowner's / hazard, flood, wind, earthquake or other)." }
  if (coverages.includes("other") && !(input.otherCoverage ?? "").trim()) return { ok: false, code: "invalid", error: "Describe the other coverage the lender requires." }
  if (input.escrowTreatment && !(LENDER_INSURANCE_ESCROW as readonly string[]).includes(input.escrowTreatment)) return { ok: false, code: "invalid", error: "Choose how the premium is handled at closing." }
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) return { ok: false, code: "invalid", error: "The lender's due date must be a date." }
  if (kind === "lender") {
    const { lenderPresence } = await import("@/lib/compliance/trid-disclosure-clock-evidence")
    const lp = await lenderPresence(svc, input.brokerageId, input.transactionId)
    if (!lp.ok) return { ok: false, code: "unavailable", error: "The deal's lender could not be checked right now. Nothing was saved." }
    if (!input.actor.lenderVendorId || lp.lender.vendorId !== input.actor.lenderVendorId) return { ok: false, code: "forbidden", error: "Only the lender assigned to this deal can record its insurance requirement." }
  }
  const loaded = await loadLenderInsuranceCheckpoint(svc, { brokerageId: input.brokerageId, transactionId: input.transactionId, today: input.today })
  if (!loaded.ok) return { ok: false, code: "unavailable", error: "The deal's lender record could not be read right now. Nothing was saved." }
  const prev = loaded.facts.requirement
  const now = new Date().toISOString()
  const next: Record<string, unknown> = {
    required: input.required, coverages: input.required ? coverages : [],
    source: kind === "lender" ? "lender_portal" : kind === "tc" ? "tc_reported" : "agent_reported", recorded_by: input.actor.userId, recorded_at: now,
  }
  for (const [k, v] of [["other_coverage", input.otherCoverage], ["mortgagee_clause", input.mortgageeClause], ["escrow_treatment", input.escrowTreatment], ["evidence_recipient", input.evidenceRecipient], ["due_date", input.dueDate]] as const) {
    if (typeof v === "string" && v.trim()) next[k] = v.trim().slice(0, k === "mortgagee_clause" ? 1000 : 300)
  }
  // An ACCEPTANCE stands only while the requirement it was accepted against is unchanged.
  const sameRequirement = !!prev && prev.required === input.required && [...prev.coverages].sort().join(",") === [...(next.coverages as string[])].sort().join(",")
  if (sameRequirement && prev?.evidence_verified_at) {
    for (const k of ["evidence_verified_at", "evidence_verified_by", "evidence_verified_source", "evidence_document_id"] as const) if (prev[k]) next[k] = prev[k]
  }
  return writeRequirement(svc, { brokerageId: input.brokerageId, transactionId: input.transactionId, userId: input.actor.userId, lenderName: input.lenderName ?? null, next, action: "transaction.lender_insurance.requirement", today: input.today })
}

/** ACCEPT the insurance evidence against the lender's requirement — the lender itself, or compliance / an admin. */
export async function acceptLenderInsuranceEvidence(svc: Svc, input: {
  brokerageId: string; transactionId: string; actor: { userId: string; kind: "lender" | "staff"; lenderVendorId?: string | null }; documentId?: string | null; today?: string
}): Promise<Outcome> {
  const loaded = await loadLenderInsuranceCheckpoint(svc, { brokerageId: input.brokerageId, transactionId: input.transactionId, today: input.today })
  if (!loaded.ok) return { ok: false, code: "unavailable", error: "The deal's insurance record could not be read right now. Nothing was saved." }
  const f = loaded.facts
  if (input.actor.kind === "lender" && (!input.actor.lenderVendorId || f.lender.vendorId !== input.actor.lenderVendorId)) return { ok: false, code: "forbidden", error: "Only the lender assigned to this deal can accept its insurance evidence." }
  if (!f.requirement || f.requirement.required !== true) return { ok: false, code: "invalid", error: "Record the lender's insurance requirement before accepting evidence against it." }
  const documentId = input.documentId ?? f.policyDocumentId
  if (!documentId) return { ok: false, code: "invalid", error: "File the binder or declarations page on the deal first." }
  const { data: doc, error } = await svc.from("transaction_documents").select("id").eq("id", documentId).eq("brokerage_id", input.brokerageId).eq("transaction_id", input.transactionId).maybeSingle()
  if (error) return { ok: false, code: "unavailable", error: "The evidence document could not be checked right now. Nothing was saved." }
  if (!doc) return { ok: false, code: "not_found", error: "The evidence document is not on this deal." }
  const next: Record<string, unknown> = { ...stripNulls(f.requirement), evidence_verified_at: new Date().toISOString(), evidence_verified_by: input.actor.userId, evidence_verified_source: input.actor.kind === "lender" ? "lender_portal" : "staff_review", evidence_document_id: documentId }
  return writeRequirement(svc, { brokerageId: input.brokerageId, transactionId: input.transactionId, userId: input.actor.userId, lenderName: null, next, action: "transaction.lender_insurance.accept", today: input.today })
}

/** The m907 CHECK pins keys — write only the keys that carry a value (an absent key is "not stated"). */
function stripNulls(r: LenderInsuranceRequirement): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) if (v !== null && v !== undefined) out[k] = v
  return out
}

/**
 * A CHANGED PREMIUM ON A FINANCED DEAL → the settlement / Closing Disclosure is rechecked. Opens (or refreshes) ONE ledgered
 * `compliance_correction` request naming the lender — the category the settlement reconciliation already counts — assigned to the
 * deal's TC, else its agent. The platform does not contact the lender itself. A cash deal has no CD and is not asked.
 */
export async function requestSettlementRecheckForPremium(svc: Svc, input: { brokerageId: string; transactionId: string; previousPremium: number; newPremium: number }): Promise<{ opened: number; refreshed: number; error: string | null }> {
  const B = input.brokerageId, T = input.transactionId
  if (!(Number.isFinite(input.previousPremium) && Number.isFinite(input.newPremium)) || input.previousPremium === input.newPremium) return { opened: 0, refreshed: 0, error: null }
  const { data: tx, error: txErr } = await svc.from("transactions").select("financing_type").eq("id", T).eq("brokerage_id", B).maybeSingle()
  if (txErr) return { opened: 0, refreshed: 0, error: `the deal could not be read: ${txErr.message}` }
  const { financingKindFor } = await import("@/lib/compliance/checklist-dimensions")
  if (financingKindFor((tx as { financing_type?: string | null } | null)?.financing_type ?? null) !== "financed") return { opened: 0, refreshed: 0, error: null }
  const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const description = `The homeowner's insurance annual premium changed from ${usd(input.previousPremium)} to ${usd(input.newPremium)}. Ask the lender to confirm the Closing Disclosure and the settlement statement reflect the new premium (prepaids / escrow), and file the corrected statement on the deal.\n\nWho corrects it: the lender (the Closing Disclosure) and the settlement agent (the settlement statement). A premium change alone does not restart the three-business-day waiting period unless the lender determines otherwise.`
  const { data: open, error: oErr } = await svc.from("transaction_tasks").select("id, description").eq("brokerage_id", B).eq("transaction_id", T).eq("category", "compliance_correction").eq("title", PREMIUM_RECHECK_TITLE).in("status", ["pending", "in_progress"]).limit(1)
  if (oErr) return { opened: 0, refreshed: 0, error: `the open requests could not be read: ${oErr.message}` }
  const existing = ((open ?? []) as Array<{ id: string; description: string | null }>)[0]
  if (existing) {
    if (existing.description === description) return { opened: 0, refreshed: 0, error: null }
    const { data: upd, error: uErr } = await svc.from("transaction_tasks").update({ description, updated_at: new Date().toISOString() }).eq("id", existing.id).eq("brokerage_id", B).select("id")
    if (uErr || !upd || upd.length === 0) return { opened: 0, refreshed: 0, error: `the recheck request was not refreshed${uErr ? `: ${uErr.message}` : ""}` }
    return { opened: 0, refreshed: 1, error: null }
  }
  const { resolveTransactionTeamUsers } = await import("@/lib/kernel/deal-save-huddle")
  const team = await resolveTransactionTeamUsers(svc as any, T, B)
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const made = await withActionLedger<{ inserted: number }>(
    {
      brokerageId: B, action: "compliance.settlement_recheck.open", actor: { type: "manager", managerKey: "compliance_officer" }, subject: { type: "transaction", id: T, ref: "insurance_premium" },
      reasonCode: "COMPLIANCE_NOTICE", reasonDetail: "homeowner's insurance premium changed", riskClass: "LOW_RISK_WRITE", systemSource: "lender_insurance_checkpoint",
      idempotencyKey: `settlement-recheck:${B}:${T}:premium:${input.previousPremium}>${input.newPremium}`,
      detail: { previous_premium: input.previousPremium, new_premium: input.newPremium, assigned_user_id: team.coordinatorUserId ?? team.agentUserId ?? null },
    },
    async () => {
      const { data: ins, error } = await svc.from("transaction_tasks").insert({
        transaction_id: T, brokerage_id: B, title: PREMIUM_RECHECK_TITLE, description, priority: "high", category: "compliance_correction",
        ai_generated: false, status: "pending", assigned_user_id: team.coordinatorUserId ?? team.agentUserId ?? null,
      }).select("id")
      if (error) throw new Error(`the recheck request was not written: ${error.message}`)
      return { inserted: (ins ?? []).length }
    },
    { settle: (x) => x.inserted === 1 ? { status: "executed", outcome: "recheck_requested" } : { status: "failed", outcome: "no_row" }, replay: () => ({ inserted: 0 }) },
    { client: svc as never },
  )
  return { opened: made.inserted, refreshed: 0, error: null }
}
