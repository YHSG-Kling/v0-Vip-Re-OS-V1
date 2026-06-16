// lib/intelligence/dry-run-cockpit.ts
//
// DRY-RUN TOMORROW (the glass cockpit) — preview every touch the AI team PLANS to send next, with
// each compliance gate shown green or blocked BEFORE anything fires. Where decision-receipts is the
// honest record of the PAST ("why did my client get this?"), this is the same shape projected
// FORWARD ("what's about to go out, and would the gates let it?"). It reuses the EXISTING pure
// consent + channel-preference gates, so the preview matches reality exactly — no second source of
// truth. A broker can watch the whole next day before it happens.
//
// Pure (no I/O), unit-tested directly; a loader assembles the inputs.

import { canDispatchToContact, honorsChannelPreference, type ContactConsentState, type DispatchChannel } from "@/lib/compliance/contact-channel-gate"

export interface PlannedTouchInput {
  contactId: string | null
  contactName?: string | null
  channel: string
  scheduledAt: string
  sequenceName?: string | null
  /** the manager that will produce it (from channel attribution). */
  manager?: string | null
  /** the recipient's consent state + preferred channel (for the gate preview). */
  consent: ContactConsentState & { preferred_channel?: string | null }
}

export interface PlannedTouchPreview {
  contactId: string | null
  contactName: string | null
  channel: string
  scheduledAt: string
  sequenceName: string | null
  manager: string | null
  willSend: boolean
  /** why it would be blocked (consent / preference), or "ok". */
  gate: string
}

const DIRECT_CHANNELS = new Set(["email", "sms", "voice_drop"])

/** Preview one planned touch through the real gates. Pure. */
export function previewTouch(t: PlannedTouchInput): PlannedTouchPreview {
  let willSend = true
  let gate = "ok"
  // portal / non-direct channels aren't consent-gated the same way; only direct channels are.
  if (DIRECT_CHANNELS.has(t.channel)) {
    const consentGate = canDispatchToContact(t.consent, t.channel as DispatchChannel)
    if (!consentGate.allowed) { willSend = false; gate = consentGate.reason ?? "blocked by consent" }
    else {
      const prefGate = honorsChannelPreference(t.consent.preferred_channel ?? null, t.channel as DispatchChannel)
      if (!prefGate.allowed) { willSend = false; gate = prefGate.reason ?? "blocked by channel preference" }
    }
  }
  return {
    contactId: t.contactId,
    contactName: t.contactName ?? null,
    channel: t.channel,
    scheduledAt: t.scheduledAt,
    sequenceName: t.sequenceName ?? null,
    manager: t.manager ?? null,
    willSend,
    gate,
  }
}

export interface PlannedDaySummary {
  total: number
  willSend: number
  blocked: number
  touches: PlannedTouchPreview[]
}

/** Build the full preview of the planned day — time-ordered, with send/blocked counts. Pure. */
export function assemblePlannedDay(touches: PlannedTouchInput[]): PlannedDaySummary {
  const previews = (touches ?? []).map(previewTouch).sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || ""))
  const willSend = previews.filter((p) => p.willSend).length
  return { total: previews.length, willSend, blocked: previews.length - willSend, touches: previews }
}
