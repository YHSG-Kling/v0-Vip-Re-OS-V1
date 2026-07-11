/**
 * lib/documents/deadline-derivation.ts
 *
 * DOCUMENT-DERIVED DEADLINES — document kernel Phase A. The dates buried
 * in scanned deal documents become tracked, watched deadlines on the
 * EXISTING transaction_deadlines rail (the same table the milestone
 * seeder, the contingency planner, and the deadline-watcher already
 * share — NOT a parallel system), with provenance back to the document
 * and field each date came from (source_document_id / source_field_key).
 *
 * How it composes with the existing rails:
 *   · milestone-service seeds the canonical five (earnest_money,
 *     inspection, appraisal, financing, closing) from contractTerms.
 *   · contingency-deadlines seeds non-standard contingency_* types.
 *   · THIS deriver treats the document as EVIDENCE for the same deadline
 *     identities: a missing deadline gets inserted (green), a matching
 *     one gets its source stamped (green), a CONFLICTING one raises a
 *     gated amber proposal on the inter-manager bus — the kernel never
 *     silently moves a date another rail or a human recorded.
 *
 * Every candidate — acted on or not — records a policy_decisions row
 * first (decideDeadlinePolicy), so the green/amber/red trail is complete.
 *
 * The candidate planner is PURE (unit-tested); deriveDeadlinesFromDocument
 * does the idempotent I/O. Runs as a post-scan hook, shadow→assisted:
 * green actions are additive-only, everything else goes through a human.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { decideDeadlinePolicy, recordPolicyDecision } from "./policy-decisions"

type Svc = SupabaseClient<any, any, any>

export interface DeadlineCandidate {
  /** canonical transaction_deadlines.deadline_type (shared vocabulary). */
  deadlineType: string
  /** ISO date YYYY-MM-DD. */
  date: string
  /** the extracted field(s) the date came from — source_field_key provenance. */
  fieldKey: string
  /** human-readable derivation, written into the deadline notes. */
  basis: string
}

/** Parse a scanner-extracted date-ish value to YYYY-MM-DD, or null. */
export function parseDocDate(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null
  const s = v.trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) {
    const t = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`)
    return Number.isNaN(t) ? null : `${iso[1]}-${iso[2]}-${iso[3]}`
  }
  const t = Date.parse(s)
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString().slice(0, 10)
}

const addDays = (isoDate: string, days: number): string =>
  new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

/**
 * PURE: which deadline dates does this classification + field set assert?
 * Only fields the SCAN_PROMPT shapes actually produce; only dates that
 * are genuinely deadlines (an inspection_date that already happened is a
 * record, not a deadline — excluded on purpose).
 */
export function deriveDeadlineCandidates(
  classification: string,
  fields: Record<string, unknown>,
): DeadlineCandidate[] {
  const out: DeadlineCandidate[] = []

  if (classification === "signed_contract" || classification === "counter_offer") {
    // Earnest money: due N days after the contract took effect.
    const dueDaysRaw = fields.earnest_money_due_days
    const dueDays = typeof dueDaysRaw === "number" ? dueDaysRaw : parseInt(String(dueDaysRaw ?? ""), 10)
    const anchor = parseDocDate(
      classification === "signed_contract" ? fields.contract_effective_date : fields.seller_signed_at,
    )
    if (anchor && Number.isFinite(dueDays) && dueDays > 0) {
      out.push({
        deadlineType: "earnest_money",
        date: addDays(anchor, dueDays),
        fieldKey: "earnest_money_due_days",
        basis: `contract effective ${anchor} + ${dueDays} day EM window`,
      })
    }
  }

  if (classification === "closing_disclosure") {
    const d = parseDocDate(fields.closing_date)
    if (d) out.push({ deadlineType: "closing", date: d, fieldKey: "closing_date", basis: `closing disclosure states closing ${d}` })
  }

  if (classification === "pre_approval_letter") {
    const d = parseDocDate(fields.expires_at)
    if (d) out.push({ deadlineType: "pre_approval_expiration", date: d, fieldKey: "expires_at", basis: `pre-approval letter expires ${d}` })
  }

  if (classification === "commission_agreement") {
    const d = parseDocDate(fields.expires_at)
    if (d) out.push({ deadlineType: "commission_agreement_expiration", date: d, fieldKey: "expires_at", basis: `commission agreement expires ${d}` })
  }

  return out
}

export interface DerivationResult {
  candidates: number
  inserted: number
  confirmed: number
  conflictsProposed: number
  proposed: number
  /** ambers acted on autonomously under a broker-granted ratchet shape. */
  autoResolved: number
  reason?: string
}

/**
 * Post-scan hook: derive deadlines from one scanned document. Idempotent —
 * dedupes against existing (transaction_id, deadline_type) rows; conflict
 * proposals dedupe 14d on the signal bus. Best-effort (never fails a scan).
 */
export async function deriveDeadlinesFromDocument(
  svc: Svc,
  input: {
    documentId: string
    brokerageId: string
    transactionId: string | null
    classification: string
    confidence: "high" | "medium" | "low"
    fields: Record<string, unknown>
  },
): Promise<DerivationResult> {
  const zero: DerivationResult = { candidates: 0, inserted: 0, confirmed: 0, conflictsProposed: 0, proposed: 0, autoResolved: 0 }
  if (!input.transactionId) return { ...zero, reason: "no transaction — deadlines are transaction-scoped" }

  const candidates = deriveDeadlineCandidates(input.classification, input.fields ?? {})
  if (candidates.length === 0) return { ...zero, reason: "no date-bearing fields for this classification" }

  const result: DerivationResult = { ...zero, candidates: candidates.length }

  // THE AUTONOMY RATCHET — amber shapes this broker has GRANTED (earned
  // from their own approval history) act autonomously; everything else
  // still proposes. Fail-closed: no grant record, no autonomous act.
  const { loadDocKernelGrants, shapeKey } = await import("./autonomy-ratchet")
  const grants = await loadDocKernelGrants(svc, input.brokerageId)

  // A human-verified field is the strongest evidence there is — a candidate
  // whose source field was verified derives at HIGH confidence regardless of
  // the original scan's doc-level confidence (the amber→green upgrade loop:
  // verify the fact, re-derive, the proposal becomes an autonomous insert).
  const { data: verifiedRows } = await svc
    .from("document_field_extractions")
    .select("field_key")
    .eq("document_id", input.documentId)
    .not("verified_at", "is", null)
  const verifiedKeys = new Set(((verifiedRows ?? []) as Array<{ field_key: string }>).map((r) => r.field_key))

  const { data: existingRows } = await svc
    .from("transaction_deadlines")
    .select("id, deadline_type, deadline_date, status, source_document_id")
    .eq("transaction_id", input.transactionId)
    .in("deadline_type", candidates.map((c) => c.deadlineType))
  const existingByType = new Map(
    ((existingRows ?? []) as any[]).map((r) => [r.deadline_type as string, r]),
  )

  for (const c of candidates) {
    const existing = existingByType.get(c.deadlineType)
    // A completed/waived deadline is settled history — nothing to decide.
    if (existing && (existing.status === "completed" || existing.status === "waived")) continue

    const effectiveConfidence = verifiedKeys.has(c.fieldKey) ? "high" : input.confidence
    const verdict = decideDeadlinePolicy({
      confidence: effectiveConfidence,
      derivedDate: c.date,
      existingDate: existing ? String(existing.deadline_date).slice(0, 10) : null,
    })

    await recordPolicyDecision(svc, {
      brokerageId: input.brokerageId,
      transactionId: input.transactionId,
      documentId: input.documentId,
      targetType: "transaction_deadline",
      targetId: c.deadlineType,
      verdict,
      evidence: {
        classification: input.classification,
        field_key: c.fieldKey,
        derived_date: c.date,
        basis: c.basis,
        existing_date: existing ? String(existing.deadline_date).slice(0, 10) : null,
        scan_confidence: input.confidence,
        effective_confidence: effectiveConfidence,
        field_verified: verifiedKeys.has(c.fieldKey),
      },
    })

    if (verdict.decision === "green" && verdict.recommendedAction === "insert_deadline") {
      const { error } = await svc.from("transaction_deadlines").insert({
        transaction_id: input.transactionId,
        brokerage_id: input.brokerageId,
        deadline_type: c.deadlineType,
        deadline_date: c.date,
        status: "pending",
        source_document_id: input.documentId,
        source_field_key: c.fieldKey,
        notes: `Derived from the scanned ${input.classification.replace(/_/g, " ")}: ${c.basis}.`,
      })
      if (!error) result.inserted++
    } else if (verdict.decision === "green" && verdict.recommendedAction === "stamp_source_provenance") {
      // The document confirms the tracked date — record where the evidence lives.
      if (existing && !existing.source_document_id) {
        await svc.from("transaction_deadlines")
          .update({ source_document_id: input.documentId, source_field_key: c.fieldKey })
          .eq("id", existing.id)
      }
      result.confirmed++
    } else if (verdict.decision === "amber") {
      const isConflict = verdict.recommendedAction === "confirm_deadline_correction"
      const grantedShape = shapeKey(isConflict ? "deadline_correction" : "deadline_propose", c.deadlineType)
      if (grants.has(grantedShape)) {
        // Broker-granted shape: act autonomously, record the grant on the ledger.
        if (isConflict && existing) {
          const { error } = await svc.from("transaction_deadlines").update({
            deadline_date: c.date,
            source_document_id: input.documentId,
            source_field_key: c.fieldKey,
            notes: [((existing as any).notes as string | null) ?? null, `Corrected to ${c.date} from the scanned ${input.classification.replace(/_/g, " ")} (broker-granted autonomy: ${grantedShape}).`]
              .filter(Boolean).join(" "),
          }).eq("id", existing.id)
          if (!error) result.autoResolved++
        } else if (!isConflict) {
          const { error } = await svc.from("transaction_deadlines").insert({
            transaction_id: input.transactionId,
            brokerage_id: input.brokerageId,
            deadline_type: c.deadlineType,
            deadline_date: c.date,
            status: "pending",
            source_document_id: input.documentId,
            source_field_key: c.fieldKey,
            notes: `Tracked from the scanned ${input.classification.replace(/_/g, " ")}: ${c.basis} (broker-granted autonomy: ${grantedShape}).`,
          })
          if (!error) result.autoResolved++
        }
        await recordPolicyDecision(svc, {
          brokerageId: input.brokerageId,
          transactionId: input.transactionId,
          documentId: input.documentId,
          targetType: "transaction_deadline",
          targetId: c.deadlineType,
          verdict: {
            decision: "green",
            reasons: [`acted under broker-granted autonomy (${grantedShape})`, c.basis],
            recommendedAction: isConflict ? "auto_adopted_granted" : "auto_tracked_granted",
            requiredApproverRole: null,
          },
          evidence: { granted_shape: grantedShape, derived_date: c.date, field_key: c.fieldKey },
        })
        continue
      }
      const raised = await proposeDeadlineReview(svc, {
        brokerageId: input.brokerageId,
        transactionId: input.transactionId,
        documentId: input.documentId,
        deadlineType: c.deadlineType,
        proposedDate: c.date,
        currentDate: existing ? String(existing.deadline_date).slice(0, 10) : null,
        basis: c.basis,
        fieldKey: c.fieldKey,
      })
      if (raised) {
        if (isConflict) result.conflictsProposed++
        else result.proposed++
      }
    }
    // red → the policy row IS the outcome; nothing moves.
  }

  return result
}

/** Amber path: a GATED review proposal on the inter-manager bus (deduped
 *  14d per transaction+deadline pair — an unactioned proposal stands). */
async function proposeDeadlineReview(
  svc: Svc,
  input: {
    brokerageId: string
    transactionId: string
    documentId: string
    deadlineType: string
    proposedDate: string
    currentDate: string | null
    basis: string
    fieldKey: string
  },
): Promise<boolean> {
  const dedupSince = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const { data: dup } = await svc.from("manager_signals")
    .select("id")
    .eq("brokerage_id", input.brokerageId)
    .eq("signal_type", "deadline_conflict_finding")
    .contains("payload", { transaction_id: input.transactionId, deadline_type: input.deadlineType })
    .gte("created_at", dedupSince)
    .limit(1)
    .maybeSingle()
  if (dup) return false

  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const message = input.currentDate
    ? `The scanned document says the ${input.deadlineType.replace(/_/g, " ")} deadline is ${input.proposedDate}, but ${input.currentDate} is tracked (${input.basis}). Confirm which date is right before anything moves.`
    : `The scanned document supports a ${input.deadlineType.replace(/_/g, " ")} deadline of ${input.proposedDate} (${input.basis}), but the scan wasn't confident enough to track it automatically. Confirm to add it.`
  await publishManagerSignal({
    brokerageId: input.brokerageId,
    fromManager: "deal_coordinator",
    toManager: "compliance_officer",
    signalType: "deadline_conflict_finding",
    message,
    entityType: "transaction",
    entityId: input.transactionId,
    payload: {
      transaction_id: input.transactionId,
      deadline_type: input.deadlineType,
      proposed_date: input.proposedDate,
      current_date: input.currentDate,
      document_id: input.documentId,
      field_key: input.fieldKey,
    },
  }, svc)
  return true
}
