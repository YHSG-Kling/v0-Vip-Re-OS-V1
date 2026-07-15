// lib/kernel/ingress-continuity.ts
//
// INGRESS CONTINUITY (cron_manager) — the owner's Continuity Engine vision,
// ingress half: "data gets stuck between one webhook and where it belongs."
// A provider webhook that arrives and matches NOTHING is today's silent loss:
// the route returns 200 (so the provider never retries) and the signal —
// e.g. "this envelope is fully signed" — evaporates. The classic cause is a
// RACE (the provider fires before our dispatch stamps the envelope id) or a
// transient DB failure during the match.
//
// The fix is a DEAD-LETTER + RECONCILIATION loop, not a bigger webhook:
//   1. Every e-sign completion webhook, after running the finalizers, PROBES
//      whether the envelope matched ANY artifact of record. Zero matches →
//      the event is parked as an ingress dead letter (never dropped).
//   2. The daily reconciler re-probes each pending letter. The moment the
//      artifact exists (dispatch caught up), it REPLAYS the same idempotent
//      finalizers the webhook would have run — the stuck data flows to where
//      it belongs, and the heal lands on the unified self_heal_events ledger.
//   3. A letter that never matches within INGRESS_MAX_ATTEMPTS is marked
//      abandoned and escalated to platform staff with full context — the
//      exception path, never a silent grave.
//
// Pure decision core (testable); replay reuses lib/esign-webhooks/finalize-packet
// verbatim (proven idempotent — the same functions the live webhook calls).

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

/** Daily reconciler ticks a letter gets before it's abandoned + escalated (~1 month of patience). */
export const INGRESS_MAX_ATTEMPTS = 30

export type EsignIngressProvider = "dotloop" | "docusign" | "skyslope" | "authentisign"

export type IngressDecision = "replay" | "wait" | "abandon"

/** PURE: what to do with one pending dead letter this tick. */
export function decideIngressAction(input: { matched: boolean; attempts: number }): IngressDecision {
  if (input.matched) return "replay"
  if (input.attempts + 1 >= INGRESS_MAX_ATTEMPTS) return "abandon"
  return "wait"
}

/**
 * Does this envelope ref match ANY artifact of record? Probes every table the
 * dispatch chain stamps: signature packets (both), offers, listing agreements,
 * voice-cockpit documents, and BBAs. One true = the webhook had somewhere to land.
 */
export async function envelopeHasAnyArtifact(svc: Svc, envelopeId: string): Promise<boolean> {
  if (!envelopeId) return false
  const probes = await Promise.all([
    svc.from("signature_requests").select("id", { count: "exact", head: true }).eq("provider_envelope_id", envelopeId),
    svc.from("contract_signatures").select("id", { count: "exact", head: true }).eq("provider_envelope_id", envelopeId),
    svc.from("offers").select("id", { count: "exact", head: true }).eq("provider_envelope_id", envelopeId),
    svc.from("listing_agreements").select("id", { count: "exact", head: true }).eq("provider_ref", envelopeId),
    svc.from("documents").select("id", { count: "exact", head: true }).filter("metadata->>signature_request_id", "eq", envelopeId),
    svc.from("buyer_broker_agreements").select("id", { count: "exact", head: true }).eq("signature_request_id", envelopeId),
  ])
  return probes.some((p) => (p.count ?? 0) > 0)
}

/**
 * Park ANY unmatched ingress event as a dead letter. Idempotent (unique on
 * provider+kind+ref) and best-effort — continuity bookkeeping never fails a
 * webhook response. Each event_kind has a replay runner in the reconciler.
 */
export async function parkIngressEvent(svc: Svc, input: {
  provider: string
  eventKind: string
  externalRef: string
  payload: Record<string, unknown>
}): Promise<{ parked: boolean }> {
  try {
    if (!input.externalRef) return { parked: false }
    await svc.from("ingress_dead_letters").upsert({
      provider: input.provider,
      event_kind: input.eventKind,
      external_ref: input.externalRef,
      payload: input.payload,
      status: "pending",
    }, { onConflict: "provider,event_kind,external_ref", ignoreDuplicates: true })
    return { parked: true }
  } catch {
    return { parked: false }
  }
}

/** PURE: stable content hash (djb2) — dedupes exact webhook redeliveries of an unreadable payload. */
export function payloadHash(raw: unknown): string {
  const s = JSON.stringify(raw) ?? ""
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * Park a payload the schema-adaptation layer could not read (missing required
 * facts) + ledger the escalation. One call from any drifted-connector route.
 */
export async function quarantineDriftedPayload(svc: Svc, input: {
  connector: string
  source: string
  raw: unknown
  missing: string[]
  eventType?: string | null
}): Promise<{ parked: boolean; ref: string }> {
  const ref = `sdq:${input.connector}:${payloadHash(input.raw)}`
  const r = await parkIngressEvent(svc, {
    provider: input.connector,
    eventKind: "schema_drift_quarantine",
    externalRef: ref,
    payload: { source: input.source, event_type: input.eventType ?? null, raw: input.raw, missing: input.missing },
  })
  try {
    const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
    await recordSelfHeal(svc, {
      brokerageId: null, domain: "data_flow", subject: ref, action: "none", outcome: "escalated",
      detail: { flow: "schema_drift", connector: input.connector, missing: input.missing, reason: "provider payload is missing required facts — quarantined for review, never guessed" },
    })
  } catch { /* the parked letter is the record of truth */ }
  return { parked: r.parked, ref }
}

/**
 * Call from every e-sign completion webhook AFTER the finalizers ran: if the
 * envelope matched nothing, park it as a dead letter instead of losing it.
 */
export async function ensureEsignIngressContinuity(svc: Svc, input: {
  provider: EsignIngressProvider
  envelopeId: string | null
}): Promise<{ parked: boolean }> {
  try {
    if (!input.envelopeId) return { parked: false }
    const matched = await envelopeHasAnyArtifact(svc, input.envelopeId)
    if (matched) return { parked: false }
    return await parkIngressEvent(svc, {
      provider: input.provider,
      eventKind: "esign_envelope_completed",
      externalRef: input.envelopeId,
      payload: { envelopeId: input.envelopeId, provider: input.provider },
    })
  } catch {
    return { parked: false }
  }
}

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
        await svc.from("ingress_dead_letters")
          .update({ status: "reconciled", reconciled_at: nowIso, attempts: (letter.attempts ?? 0) + 1, last_attempt_at: nowIso })
          .eq("id", letter.id).eq("status", "pending")
        out.replayed++
      } else {
        await svc.from("ingress_dead_letters")
          .update({ attempts: (letter.attempts ?? 0) + 1, last_attempt_at: nowIso })
          .eq("id", letter.id)
        out.waiting++
      }
      await recordSelfHeal(svc, {
        brokerageId: attempt.brokerageId ?? null, domain: "data_flow", subject: letter.external_ref,
        action: attempt.action, outcome: ok ? "healed" : "failed",
        detail: { flow: attempt.flow, provider: letter.provider, attempts: (letter.attempts ?? 0) + 1 },
      })
    } else if (decision === "abandon") {
      await svc.from("ingress_dead_letters")
        .update({ status: "abandoned", attempts: (letter.attempts ?? 0) + 1, last_attempt_at: nowIso })
        .eq("id", letter.id)
      out.abandoned++
      abandonedRefs.push(`${letter.provider}:${letter.external_ref}`)
      await recordSelfHeal(svc, {
        brokerageId: attempt.brokerageId ?? null, domain: "data_flow", subject: letter.external_ref,
        action: "none", outcome: "escalated",
        detail: { flow: attempt.flow, provider: letter.provider, reason: `still unmatched after ${INGRESS_MAX_ATTEMPTS} reconciliation attempts — a human must trace where this event should have landed` },
      })
    } else {
      await svc.from("ingress_dead_letters")
        .update({ attempts: (letter.attempts ?? 0) + 1, last_attempt_at: nowIso })
        .eq("id", letter.id)
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
