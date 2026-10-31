// lib/kernel/ingress-reconciliation.ts
//
// THE REPLAY SIDE of ingress continuity (moved verbatim from lib/kernel/ingress-continuity.ts — wave 147, integrator,
// proxy-graph budget; see the tombstone there). One runner per dead-letter event_kind, each replaying the EXACT ingest path
// its webhook runs (the same idempotent finalizers — lib/esign-webhooks/finalize-packet — and the same Meta / ShowingTime
// ingest rails), plus the daily reconciliation worker that rides the deal-health-scan cron: replay what has a destination now,
// age what has none, abandon + escalate to platform staff what will never match. Every replay and abandonment is ledgered on
// self_heal_events — the OS's repairs stay a visible fact. The parking / quarantine / pull-drift half stays in
// lib/kernel/ingress-continuity.ts, which is all a page ever needs.
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INGRESS_MAX_ATTEMPTS, decideIngressAction, envelopeHasAnyArtifact, ensureEsignIngressContinuity, type EsignIngressProvider } from "./ingress-continuity"

type Svc = SupabaseClient<any, any, any>

export interface IngressReconciliationResult {
  scanned: number
  replayed: number
  waiting: number
  abandoned: number
}

interface ReplayAttempt {
  /** replayed = landed · failed = destination exists but the replay errored · unmatched = destination still missing */
  result: "replayed" | "failed" | "unmatched"
  /** the FLOW_CONTRACTS key this letter ledgers under */
  flow: string
  /** the ledger action for a heal/fail */
  action: string
  brokerageId?: string | null
}

interface DeadLetterRow { id: string; provider: string; event_kind: string; external_ref: string; payload: Record<string, any> | null; attempts: number | null }

/**
 * THE REPLAY REGISTRY — one runner per event_kind. Each replays the EXACT
 * ingest path its webhook runs (shared helpers, so the paths can never
 * drift), and reports whether the destination has appeared yet.
 */
async function attemptReplay(svc: Svc, letter: DeadLetterRow): Promise<ReplayAttempt> {
  if (letter.event_kind === "esign_envelope_completed") {
    const base: ReplayAttempt = { result: "unmatched", flow: "esign_ingress_orphan", action: "reconcile_esign_ingress" }
    const matched = await envelopeHasAnyArtifact(svc, letter.external_ref).catch(() => false)
    if (!matched) return base
    try {
      const { finalizeVoiceCockpitPacket, finalizeLegacyEsignArtifacts } = await import("@/lib/esign-webhooks/finalize-packet")
      await finalizeVoiceCockpitPacket(svc as any, letter.external_ref, letter.provider as any)
      await finalizeLegacyEsignArtifacts(svc as any, letter.external_ref)
      return { ...base, result: "replayed" }
    } catch {
      return { ...base, result: "failed" }
    }
  }

  if (letter.event_kind === "meta_lead_received") {
    const base: ReplayAttempt = { result: "unmatched", flow: "meta_lead_orphan", action: "replay_meta_lead" }
    const p = letter.payload ?? {}
    if (!p.pageId) return base // no page ref → can never match; ages to abandonment
    try {
      const { ingestMetaLeadByRef } = await import("@/lib/ads/ad-lead-intake")
      const r = await ingestMetaLeadByRef(svc as any, {
        pageId: String(p.pageId),
        leadgenId: p.leadgenId ? String(p.leadgenId) : null,
        formId: p.formId ? String(p.formId) : null,
        inlineFields: Array.isArray(p.field_data) ? p.field_data : null,
      })
      if (r.ok) return { ...base, result: "replayed", brokerageId: r.brokerageId ?? null }
      // 'rejected' = fields resolved but unusable — a terminal fact the
      // brokerage should hear about via abandonment, not an infinite retry.
      return { ...base, result: "unmatched", brokerageId: r.brokerageId ?? null }
    } catch {
      return { ...base, result: "failed" }
    }
  }

  if (letter.event_kind === "showingtime_appointment_requested") {
    const base: ReplayAttempt = { result: "unmatched", flow: "showingtime_request_orphan", action: "replay_showingtime_request" }
    const appt = (letter.payload ?? {}).appointment as Record<string, any> | undefined
    if (!appt?.property?.mls_number || !appt?.requested_at) return base // nothing to match on — ages to abandonment
    try {
      const { resolveShowingTimeListing, ingestShowingTimeRequest } = await import("@/lib/showings/showingtime-ingest")
      const resolved = await resolveShowingTimeListing(svc, {
        listingId: appt.property.listing_id ?? null,
        mlsNumber: appt.property.mls_number,
        brokerageId: null,
      })
      if (!resolved) return base // listing still hasn't appeared — wait
      const r = await ingestShowingTimeRequest(svc, { appt: appt as any, listingId: resolved.listingId, brokerageId: resolved.brokerageId })
      return r.ok
        ? { ...base, result: "replayed", brokerageId: resolved.brokerageId }
        : { ...base, result: "failed", brokerageId: resolved.brokerageId }
    } catch {
      return { ...base, result: "failed" }
    }
  }

  if (letter.event_kind === "schema_drift_quarantine") {
    // IMMUNIZATION: a quarantined payload re-adapts against the CURRENT
    // contract each tick — the moment an engineer teaches the contract the
    // new alias, the quarantine drains itself. Never guessed, only re-read.
    const base: ReplayAttempt = { result: "unmatched", flow: "schema_drift", action: "adapt_payload" }
    const p = letter.payload ?? {}
    if (!p.raw) return base

    if (p.source === "esign_completion") {
      // Readable now? Chain into the SAME rail the webhook runs: finalize,
      // then hand any still-unmatched envelope to the orphan reconciler.
      try {
        const { adaptPayload, ESIGN_COMPLETION_CONTRACTS } = await import("@/lib/kernel/schema-adaptation")
        const contract = ESIGN_COMPLETION_CONTRACTS[letter.provider]
        if (!contract) return base
        const re = adaptPayload(contract, p.raw)
        if (!re.ok) return base // contract still can't read it — wait / age out
        const envelopeId = String(re.canonical.envelope_id)
        const { finalizeVoiceCockpitPacket, finalizeLegacyEsignArtifacts } = await import("@/lib/esign-webhooks/finalize-packet")
        await finalizeVoiceCockpitPacket(svc as any, envelopeId, letter.provider as any)
        await finalizeLegacyEsignArtifacts(svc as any, envelopeId)
        await ensureEsignIngressContinuity(svc, { provider: letter.provider as EsignIngressProvider, envelopeId })
        return { ...base, result: "replayed" }
      } catch {
        return { ...base, result: "failed" }
      }
    }

    if (p.source === "dotloop_event") {
      // Dotloop quarantines carry event-specific branch logic — once readable,
      // route a human-visible abandonment is wrong, but blind replay of a
      // multi-branch webhook is riskier than the e-sign finalizers. HONEST
      // MIDDLE: only the completion-shaped events replay (through the same
      // idempotent finalizers, keyed by loop id); anything else waits for a
      // taught contract + engineer review via abandonment.
      try {
        const { adaptPayload, DOTLOOP_EVENT_CONTRACT } = await import("@/lib/kernel/schema-adaptation")
        const re = adaptPayload(DOTLOOP_EVENT_CONTRACT, p.raw)
        if (!re.ok) return base
        const loopId = (re.canonical.loop_id as string | null) ?? null
        const evt = String(re.canonical.event ?? "")
        if (!loopId || (evt !== "transaction.completed" && evt !== "document.signed")) return base
        const { finalizeVoiceCockpitPacket, finalizeLegacyEsignArtifacts } = await import("@/lib/esign-webhooks/finalize-packet")
        await finalizeVoiceCockpitPacket(svc as any, loopId, "dotloop" as any)
        await finalizeLegacyEsignArtifacts(svc as any, loopId)
        await ensureEsignIngressContinuity(svc, { provider: "dotloop", envelopeId: loopId })
        return { ...base, result: "replayed" }
      } catch {
        return { ...base, result: "failed" }
      }
    }

    if (p.source !== "showingtime_appointment") return base
    try {
      const { adaptPayload, SHOWINGTIME_APPOINTMENT_CONTRACT } = await import("@/lib/kernel/schema-adaptation")
      const adapted = adaptPayload(SHOWINGTIME_APPOINTMENT_CONTRACT, p.raw)
      if (!adapted.ok) return base // contract still can't read it — wait / age out
      if (p.event_type !== "appointment.requested") return { ...base, result: "replayed" } // readable now; nothing further to deliver
      const c = adapted.canonical
      const { resolveShowingTimeListing, ingestShowingTimeRequest } = await import("@/lib/showings/showingtime-ingest")
      const resolved = await resolveShowingTimeListing(svc, {
        listingId: (c.listing_id as string) ?? null,
        mlsNumber: (c.mls_number as string) ?? null,
        brokerageId: null,
      })
      if (!resolved) return base // readable but the listing hasn't appeared — keep waiting
      const r = await ingestShowingTimeRequest(svc, {
        appt: {
          id: String(c.id),
          property: { address: (c.address as string) ?? undefined, city: (c.city as string) ?? undefined, state: (c.state as string) ?? undefined, mls_number: (c.mls_number as string) ?? undefined },
          buyer_agent: { name: (c.agent_name as string) ?? undefined, email: (c.agent_email as string) ?? undefined, phone: (c.agent_phone as string) ?? undefined, license: (c.agent_license as string) ?? undefined },
          requested_at: String(c.requested_at),
          duration_minutes: (c.duration_minutes as number) ?? undefined,
          notes: (c.notes as string) ?? undefined,
        },
        listingId: resolved.listingId,
        brokerageId: resolved.brokerageId,
      })
      return r.ok ? { ...base, result: "replayed", brokerageId: resolved.brokerageId } : { ...base, result: "failed", brokerageId: resolved.brokerageId }
    } catch {
      return { ...base, result: "failed" }
    }
  }

  // Unknown kind: never replay blindly — age it to abandonment + escalation.
  return { result: "unmatched", flow: "ingress_unknown_kind", action: "none" }
}

/**
 * The reconciliation worker (rides the deal-health-scan cron beside
 * flow-integrity): replay letters whose artifact has appeared, age the rest,
 * abandon + escalate what will never match. Every replay and abandonment is
 * ledgered on self_heal_events — the OS's repairs stay a visible fact.
 */
export async function runIngressReconciliation(svc: Svc, now: Date = new Date()): Promise<IngressReconciliationResult> {
  const out: IngressReconciliationResult = { scanned: 0, replayed: 0, waiting: 0, abandoned: 0 }
  const { data: letters } = await svc.from("ingress_dead_letters")
    .select("id, provider, event_kind, external_ref, payload, attempts")
    .eq("status", "pending").order("created_at", { ascending: true }).limit(200)
  const rows = ((letters ?? []) as DeadLetterRow[])
  out.scanned = rows.length
  if (rows.length === 0) return out

  const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
  const nowIso = now.toISOString()
  const abandonedRefs: string[] = []

  for (const letter of rows) {
    const attempt = await attemptReplay(svc, letter)
    const decision = attempt.result === "unmatched"
      ? decideIngressAction({ matched: false, attempts: letter.attempts ?? 0 })
      : "replay" // matched (replayed or failed-during-replay) — never ages toward abandonment

    if (decision === "replay") {
      const ok = attempt.result === "replayed"
      if (ok) {
        const { error: reconciledErr } = await svc.from("ingress_dead_letters")
          .update({ status: "reconciled", reconciled_at: nowIso, attempts: (letter.attempts ?? 0) + 1, last_attempt_at: nowIso })
          .eq("id", letter.id).eq("status", "pending")
        if (reconciledErr) console.error(`[ingress-continuity] replayed letter NOT marked reconciled (may replay again): ${reconciledErr.message}`)
        out.replayed++
      } else {
        await sentinelWrite(svc, svc.from("ingress_dead_letters")
          .update({ attempts: (letter.attempts ?? 0) + 1, last_attempt_at: nowIso })
          .eq("id", letter.id), { table: "ingress_dead_letters", flow: "ingress_dead_letters_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
        out.waiting++
      }
      await recordSelfHeal(svc, {
        brokerageId: attempt.brokerageId ?? null, domain: "data_flow", subject: letter.external_ref,
        action: attempt.action, outcome: ok ? "healed" : "failed",
        detail: { flow: attempt.flow, provider: letter.provider, attempts: (letter.attempts ?? 0) + 1 },
      })
    } else if (decision === "abandon") {
      await sentinelWrite(svc, svc.from("ingress_dead_letters")
        .update({ status: "abandoned", attempts: (letter.attempts ?? 0) + 1, last_attempt_at: nowIso })
        .eq("id", letter.id), { table: "ingress_dead_letters", flow: "ingress_dead_letters_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
      out.abandoned++
      abandonedRefs.push(`${letter.provider}:${letter.external_ref}`)
      await recordSelfHeal(svc, {
        brokerageId: attempt.brokerageId ?? null, domain: "data_flow", subject: letter.external_ref,
        action: "none", outcome: "escalated",
        detail: { flow: attempt.flow, provider: letter.provider, reason: `still unmatched after ${INGRESS_MAX_ATTEMPTS} reconciliation attempts — a human must trace where this event should have landed` },
      })
    } else {
      await sentinelWrite(svc, svc.from("ingress_dead_letters")
        .update({ attempts: (letter.attempts ?? 0) + 1, last_attempt_at: nowIso })
        .eq("id", letter.id), { table: "ingress_dead_letters", flow: "ingress_dead_letters_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
      out.waiting++
    }
  }

  // Exception path: abandoned letters reach platform staff with full context
  // (webhooks are platform-scoped — there is no brokerage until a match exists).
  if (abandonedRefs.length > 0) {
    try {
      const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
      await notifyPlatformStaff(svc as any, {
        type: "ingress_dead_letter_abandoned",
        title: `${abandonedRefs.length} inbound event${abandonedRefs.length === 1 ? "" : "s"} never found ${abandonedRefs.length === 1 ? "its" : "their"} destination`,
        body: `These provider events (signed envelopes, paid leads) never matched a destination after ${INGRESS_MAX_ATTEMPTS} daily reconciliation attempts: ${abandonedRefs.slice(0, 5).join(", ")}${abandonedRefs.length > 5 ? "…" : ""}. Trace where each should have landed.`,
        entityType: "ingress_dead_letters",
        priority: "high",
      })
    } catch { /* escalation is best-effort; the abandoned rows remain queryable */ }
  }
  return out
}
