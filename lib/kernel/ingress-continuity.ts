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
 * Call from every e-sign completion webhook AFTER the finalizers ran: if the
 * envelope matched nothing, park it as a dead letter instead of losing it.
 * Idempotent (unique on provider+ref+kind) and best-effort — continuity
 * bookkeeping never fails a webhook response.
 */
export async function ensureEsignIngressContinuity(svc: Svc, input: {
  provider: EsignIngressProvider
  envelopeId: string | null
}): Promise<{ parked: boolean }> {
  try {
    if (!input.envelopeId) return { parked: false }
    const matched = await envelopeHasAnyArtifact(svc, input.envelopeId)
    if (matched) return { parked: false }
    await svc.from("ingress_dead_letters").upsert({
      provider: input.provider,
      event_kind: "esign_envelope_completed",
      external_ref: input.envelopeId,
      payload: { envelopeId: input.envelopeId, provider: input.provider },
      status: "pending",
    }, { onConflict: "provider,event_kind,external_ref", ignoreDuplicates: true })
    return { parked: true }
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

/**
 * The reconciliation worker (rides the deal-health-scan cron beside
 * flow-integrity): replay letters whose artifact has appeared, age the rest,
 * abandon + escalate what will never match. Every replay and abandonment is
 * ledgered on self_heal_events — the OS's repairs stay a visible fact.
 */
export async function runIngressReconciliation(svc: Svc, now: Date = new Date()): Promise<IngressReconciliationResult> {
  const out: IngressReconciliationResult = { scanned: 0, replayed: 0, waiting: 0, abandoned: 0 }
  const { data: letters } = await svc.from("ingress_dead_letters")
    .select("id, provider, event_kind, external_ref, attempts")
    .eq("status", "pending").order("created_at", { ascending: true }).limit(200)
  const rows = ((letters ?? []) as Array<{ id: string; provider: string; event_kind: string; external_ref: string; attempts: number | null }>)
  out.scanned = rows.length
  if (rows.length === 0) return out

  const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
  const nowIso = now.toISOString()
  const abandonedRefs: string[] = []

  for (const letter of rows) {
    const matched = await envelopeHasAnyArtifact(svc, letter.external_ref).catch(() => false)
    const decision = decideIngressAction({ matched, attempts: letter.attempts ?? 0 })

    if (decision === "replay") {
      // The same idempotent finalizers the webhook runs — the stuck signal
      // finally lands where it belongs.
      let ok = true
      try {
        const { finalizeVoiceCockpitPacket, finalizeLegacyEsignArtifacts } = await import("@/lib/esign-webhooks/finalize-packet")
        await finalizeVoiceCockpitPacket(svc as any, letter.external_ref, letter.provider as any)
        await finalizeLegacyEsignArtifacts(svc as any, letter.external_ref)
      } catch {
        ok = false
      }
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
        brokerageId: null, domain: "data_flow", subject: letter.external_ref,
        action: "reconcile_esign_ingress", outcome: ok ? "healed" : "failed",
        detail: { flow: "esign_ingress_orphan", provider: letter.provider, attempts: (letter.attempts ?? 0) + 1 },
      })
    } else if (decision === "abandon") {
      await svc.from("ingress_dead_letters")
        .update({ status: "abandoned", attempts: (letter.attempts ?? 0) + 1, last_attempt_at: nowIso })
        .eq("id", letter.id)
      out.abandoned++
      abandonedRefs.push(`${letter.provider}:${letter.external_ref}`)
      await recordSelfHeal(svc, {
        brokerageId: null, domain: "data_flow", subject: letter.external_ref,
        action: "none", outcome: "escalated",
        detail: { flow: "esign_ingress_orphan", provider: letter.provider, reason: `no matching artifact after ${INGRESS_MAX_ATTEMPTS} reconciliation attempts — a human must trace this envelope` },
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
        title: `${abandonedRefs.length} signed envelope${abandonedRefs.length === 1 ? "" : "s"} never found ${abandonedRefs.length === 1 ? "its" : "their"} paperwork`,
        body: `A provider reported these envelopes completed, but no artifact of record ever appeared after ${INGRESS_MAX_ATTEMPTS} daily reconciliation attempts: ${abandonedRefs.slice(0, 5).join(", ")}${abandonedRefs.length > 5 ? "…" : ""}. Trace the dispatch that should have staged them.`,
        entityType: "ingress_dead_letters",
        priority: "high",
      })
    } catch { /* escalation is best-effort; the abandoned rows remain queryable */ }
  }
  return out
}
