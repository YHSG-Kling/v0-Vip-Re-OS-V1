// lib/kernel/consent-recovery.ts
//
// CONSENT-REVOKED RECOVERY CHAIN — what every competitor does when a client opts out
// is suppress-and-forget: the relationship silently dies. What a great human team does
// is RESPECT the revocation and keep the relationship — and that's a CHAIN, not a flag:
//
//   1. FALLBACK — does the client still allow another channel? Then the Sphere proposes
//      (into the gate) a short, control-affirming note on the channel they still allow:
//      "texts are off, you're in control, the portal is always yours."
//   2. ENRICH — no channel left? The Data Steward queues an enrichment re-run
//      (contact_enrichment_queue) to check for UPDATED contact info before giving up —
//      people change numbers; a revoked line is often just a stale line.
//   3. WITHDRAW — only after enrichment comes back empty does the Data Steward signal
//      the Sphere to mark the relationship withdrawn (nurture_status, never a delete —
//      the history stays; nothing further is proposed).
//
// Consent provenance is NEVER fabricated: the chain only reads the per-channel opt-out
// flags that suppression-sync keeps canonical, and every client-facing step goes through
// the gate. NOT server-only (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export type RecoveryStep = "fallback_channel" | "enrich" | "wait_enrichment" | "withdraw" | "none"

export interface ConsentRecoveryFacts {
  /** Channels the client revoked (for the copy — we name what we turned off). */
  revokedChannels: string[]
  /** Email on file, not opted out, not unsubscribed. */
  emailAvailable: boolean
  /** Phone on file with TCPA consent, no sms opt-out, no DNC. */
  smsAvailable: boolean
  /** Phone on file, no phone/call opt-out, no DNC. */
  voiceAvailable: boolean
  /** A consent-recovery enrichment re-run has been queued / has finished. */
  enrichmentQueued: boolean
  enrichmentCompleted: boolean
  /** The relationship was already marked withdrawn — chain is done. */
  alreadyWithdrawn: boolean
}

/** Pure: the next step of the chain. Withdraw is the LAST resort — only after the
 *  fallback check fails AND an enrichment re-run came back without a new channel. */
export function planConsentRecovery(f: ConsentRecoveryFacts): { step: RecoveryStep; reason: string } {
  if (f.alreadyWithdrawn) return { step: "none", reason: "relationship already withdrawn" }
  if (f.revokedChannels.length === 0) return { step: "none", reason: "nothing revoked" }
  if (f.emailAvailable || f.smsAvailable || f.voiceAvailable) {
    const via = f.emailAvailable ? "email" : f.smsAvailable ? "sms" : "voice"
    return { step: "fallback_channel", reason: `client still allows ${via} — acknowledge the opt-out there, keep the relationship` }
  }
  if (!f.enrichmentQueued) return { step: "enrich", reason: "no channel left — re-run enrichment for updated contact info before any withdraw" }
  if (!f.enrichmentCompleted) return { step: "wait_enrichment", reason: "enrichment re-run still in flight" }
  return { step: "withdraw", reason: "every channel revoked and enrichment found nothing new — release respectfully" }
}

/** Pure: the control-affirming note for the channel the client still allows.
 *  Never salesy, never guilt — the point is they stay in charge. */
export function composeFallbackNote(input: {
  contactName: string | null
  revokedChannels: string[]
}): { subject: string; body: string } {
  const revoked = input.revokedChannels.join(" and ")
  return {
    subject: "Your preferences are updated — you're in control",
    body: [
      `Hi${input.contactName ? ` ${input.contactName}` : ""} — confirming we've turned off ${revoked || "that channel"} for you, effective immediately.`,
      `No action needed. If you ever want anything — a question, a market check, a hand with the next move — your portal stays yours, and this channel is open whenever you choose.`,
    ].join(" "),
  }
}

export interface ConsentRecoveryRunResult {
  contactsReviewed: number
  fallbacksProposed: number
  enrichmentsQueued: number
  withdrawsSignaled: number
}

/**
 * Run the recovery chain for recently revoked contacts (opted_out_at /
 * email_unsubscribed_at within 14 days, plus any contact stuck mid-chain).
 * Every step idempotent: one fallback proposal per contact, one consent-recovery
 * enrichment row per contact, one withdraw signal per contact; withdrawn contacts
 * leave the chain entirely.
 */
export async function runConsentRecovery(
  brokerageId: string,
  opts: { now?: Date } = {},
  client?: Svc,
): Promise<ConsentRecoveryRunResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - 14 * 86_400_000).toISOString()

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, contact_type, nurture_status, email, phone, email_opt_out, email_unsubscribed, sms_opt_out, phone_opt_out, tcpa_consent, dnc_status, opt_out_channels, opted_out_at, email_unsubscribed_at")
    .eq("brokerage_id", brokerageId)
    .or(`opted_out_at.gte.${cutoff},email_unsubscribed_at.gte.${cutoff}`)
    .limit(100)

  let contactsReviewed = 0, fallbacksProposed = 0, enrichmentsQueued = 0, withdrawsSignaled = 0

  for (const c of (contacts ?? []) as any[]) {
    contactsReviewed += 1

    const revokedChannels: string[] = []
    if (c.sms_opt_out) revokedChannels.push("texts")
    if (c.email_opt_out || c.email_unsubscribed) revokedChannels.push("emails")
    if (c.phone_opt_out) revokedChannels.push("calls")
    for (const ch of (c.opt_out_channels ?? []) as string[]) {
      const label = ch === "sms" ? "texts" : ch === "email" ? "emails" : ch === "phone" || ch === "voice" ? "calls" : ch
      if (!revokedChannels.includes(label)) revokedChannels.push(label)
    }

    const { data: enrichRows } = await supabase
      .from("contact_enrichment_queue").select("id, status")
      .eq("contact_id", c.id).eq("source", "consent_recovery").limit(5)
    const enrichment = (enrichRows ?? []) as Array<{ id: string; status: string }>

    const plan = planConsentRecovery({
      revokedChannels,
      emailAvailable: !!c.email && !c.email_opt_out && !c.email_unsubscribed,
      smsAvailable: !!c.phone && !!c.tcpa_consent && !c.sms_opt_out && !c.dnc_status,
      voiceAvailable: !!c.phone && !c.phone_opt_out && !c.dnc_status,
      enrichmentQueued: enrichment.length > 0,
      enrichmentCompleted: enrichment.some((e) => e.status === "completed" || e.status === "failed" || e.status === "skipped"),
      alreadyWithdrawn: c.nurture_status === "withdrawn",
    })

    if (plan.step === "fallback_channel") {
      // One fallback note per contact, ever (any status — a rejected one was a human call).
      const { data: existing } = await supabase.from("agent_client_messages").select("id")
        .eq("recipient_contact_id", c.id).ilike("rationale", "CONSENT RECOVERY%").limit(1).maybeSingle()
      if (existing) continue
      const contactName = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null
      const note = composeFallbackNote({ contactName, revokedChannels })
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId, agentKind: "sphere_of_influence", entityType: "contact",
        entityId: c.id, recipientContactId: c.id,
        audience: c.contact_type === "seller" ? "seller" : "buyer",
        subject: note.subject, body: note.body,
        rationale: `CONSENT RECOVERY — client revoked ${revokedChannels.join("+") || "a channel"}; acknowledging on the channel they still allow (${plan.reason}).`,
        channel: c.email && !c.email_opt_out && !c.email_unsubscribed ? "email" : "portal",
      }, supabase)
      if (res.ok) fallbacksProposed += 1
    } else if (plan.step === "enrich") {
      const { error } = await supabase.from("contact_enrichment_queue").insert({
        brokerage_id: brokerageId, contact_id: c.id, source: "consent_recovery",
        status: "pending", metadata: { reason: plan.reason, revoked_channels: revokedChannels },
      })
      if (!error) enrichmentsQueued += 1
    } else if (plan.step === "withdraw") {
      // contact_id stays NULL on purpose: a withdraw must NEVER be folded into a
      // Team Play client message — entity_id carries the contact for the handler.
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      const pub = await publishManagerSignal({
        brokerageId, fromManager: "data_steward", toManager: "sphere_of_influence",
        signalType: "contact_withdrawn",
        message: `Every channel revoked for ${[c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "a contact"} and the enrichment re-run found no new contact info — release the relationship respectfully (history kept, nothing further proposed).`,
        entityType: "contact", entityId: c.id,
      }, supabase)
      if (pub.ok && !pub.reason) withdrawsSignaled += 1
    }
  }

  return { contactsReviewed, fallbacksProposed, enrichmentsQueued, withdrawsSignaled }
}
