// lib/outcomes/reconciliation.ts
// ─────────────────────────────────────────────────────────────────────────────
// OUTCOME RECONCILIATION — THE OS PROVES WHAT IT DID, OR SAYS IT CANNOT.
//
// Every manager in this OS records outcomes: sent, published, mailed, delivered.
// Those records drive the seller report, the campaign ROI board, the ISA's touch
// caps, the de-conflict allowance and the broker's trust in autonomy. And for two
// of the channels that cost real money per touch and reach a real client, the
// record was never checked against the provider:
//
//   email        RECONCILED. The SendGrid Event Webhook updates messages.status
//                with exact sg_message_id correlation (compliance_officer owns it).
//   video render RECONCILED. The poll-did-avatars cron reads provider_status.
//   SMS          NOT RECONCILED. dispatchSms returns success on Twilio's "queued",
//                and Twilio's returned status was DISCARDED. No StatusCallback was
//                registered and no webhook existed, so a carrier rejection — bad
//                number, landline, blocked, spam-filtered — was never learned. Every
//                SMS read as sent, forever.
//   direct mail  NOT RECONCILED. lob_order_id IS stored on the campaign, but nothing
//                ever read Lob's tracking, so a piece that was re-routed or returned
//                to sender read as sent, forever.
//
// The failure this closes is not a missing feature; it is a TRUTHFULNESS failure.
// An autonomous team whose proxy ("I wrote sent") drifts from its true objective
// ("the client received it") is the textbook reward-misalignment failure mode — and
// the broker cannot tell, because both look identical in the database.
//
// THE THREE HONEST STATES, and the third is the one that matters:
//
//   confirmed     the provider says it landed. The claim is proven.
//   contradicted  the provider says it did NOT land. The claim was false, and
//                 somebody has to act — the manager that made it hears about it.
//   pending       we handed it over and the provider has not reported yet. NOT
//                 confirmed. This is the state the old code called "sent".
//   unverifiable  this lane has NO truth source. Said out loud, per lane, rather
//                 than allowing a lane with no proof to look like a proven one.
//
// PURE — no I/O — so every provider status mapping and every verdict is unit-tested
// without a database or a vendor.

/** The lanes an outcome can travel. Matches the dispatchers, not the UI copy. */
export type OutcomeChannel = "email" | "sms" | "direct_mail" | "social" | "video"

export type ReconciliationVerdict = "confirmed" | "contradicted" | "pending" | "unverifiable"

/**
 * WHERE THE TRUTH COMES FROM, per lane — declared, so a lane can never quietly
 * have no proof. `source: null` means exactly that and resolves to `unverifiable`.
 */
export interface TruthSource {
  /** The provider signal that is authoritative. null = no truth source exists. */
  source: string | null
  /** Provider statuses that mean IT LANDED. */
  confirms: readonly string[]
  /** Provider statuses that mean IT DID NOT. */
  contradicts: readonly string[]
  /** Provider statuses that are still in flight — explicitly NOT confirmation. */
  inFlight: readonly string[]
  /** Why this is the truth, for the next reader. */
  why: string
}

export const TRUTH_SOURCES: Record<OutcomeChannel, TruthSource> = {
  email: {
    source: "sendgrid.event_webhook",
    confirms: ["delivered", "open", "click"],
    contradicts: ["bounce", "dropped", "spamreport", "blocked"],
    inFlight: ["processed", "deferred", "queued"],
    why:
      "SendGrid's Event Webhook is the only party that knows whether the mail server " +
      "accepted the message. Correlated exactly by sg_message_id when the send stored it.",
  },
  sms: {
    source: "twilio.status_callback",
    // Twilio's own vocabulary. 'delivered' is the ONLY confirmation.
    confirms: ["delivered"],
    contradicts: ["undelivered", "failed", "canceled"],
    // 'sent' means HANDED TO THE CARRIER — not delivered. Treating it as
    // confirmation is precisely the mistake this module exists to end: the OS
    // recorded "sent" from Twilio's accept response and never asked again.
    inFlight: ["accepted", "queued", "scheduled", "sending", "sent"],
    why:
      "Twilio accepts a message and returns 'queued' immediately; carrier rejection " +
      "(bad number, landline, blocked, spam-filtered) arrives ONLY on the status " +
      "callback, minutes later. Without it every SMS reads as sent forever.",
  },
  direct_mail: {
    source: "lob.event_webhook",
    // Lob's tracking events. processed_for_delivery is the last stop before the box.
    confirms: ["postcard.processed_for_delivery", "letter.processed_for_delivery", "self_mailer.processed_for_delivery"],
    contradicts: [
      "postcard.returned_to_sender", "letter.returned_to_sender", "self_mailer.returned_to_sender",
      "postcard.deleted", "letter.deleted", "self_mailer.deleted",
    ],
    inFlight: [
      "postcard.created", "letter.created", "self_mailer.created",
      "postcard.rendered_pdf", "letter.rendered_pdf", "self_mailer.rendered_pdf",
      "postcard.in_transit", "letter.in_transit", "self_mailer.in_transit",
      "postcard.in_local_area", "letter.in_local_area", "self_mailer.in_local_area",
      "postcard.re_routed", "letter.re_routed", "self_mailer.re_routed",
    ],
    why:
      "A Lob piece takes days and can be re-routed or returned to sender. The API " +
      "call only proves Lob ACCEPTED the order; lob_order_id was stored and its " +
      "tracking never read, so a returned piece stayed 'sent'.",
  },
  social: {
    source: "social_posts.external_post_id",
    // The platform returning a post id IS the publish confirmation.
    confirms: ["published"],
    contradicts: ["failed", "rejected"],
    inFlight: ["scheduled", "draft", "publishing"],
    why:
      "A platform that returns an external_post_id has published. The id is the " +
      "receipt, and analytics-sync later reads engagement against it.",
  },
  video: {
    source: "did.provider_status",
    confirms: ["done", "completed", "ready"],
    contradicts: ["error", "rejected", "failed"],
    inFlight: ["created", "started", "processing"],
    why:
      "D-ID renders asynchronously; the poll-did-avatars cron reads provider_status " +
      "until it is terminal. Already reconciled — declared here so the set is complete.",
  },
}

/** Does this lane have any way to be proven at all? */
export function isVerifiable(channel: OutcomeChannel): boolean {
  return TRUTH_SOURCES[channel].source !== null
}

export interface OutcomeClaim {
  channel: OutcomeChannel
  /** The provider's own id for the thing we sent — the correlation key. */
  providerRef: string | null
  /** What the OS recorded. */
  claimedStatus: string
  claimedAt: string
}

export interface ProviderTruth {
  /** The provider's status string, verbatim — never normalised before mapping. */
  status: string
  at: string
  detail?: Record<string, unknown> | null
}

export interface Reconciliation {
  channel: OutcomeChannel
  verdict: ReconciliationVerdict
  /** True when a manager must be told: we asserted something that did not happen. */
  needsManager: boolean
  /** One line a human can act on. */
  explanation: string
  providerStatus: string | null
  /** The declared truth source, or null when the lane cannot be proven. */
  truthSource: string | null
}

/**
 * PURE: reconcile what we CLAIMED against what the provider SAYS.
 *
 * No truth yet is `pending`, never `confirmed` — the whole point. An unrecognised
 * provider status is also `pending` rather than guessed either way: inventing a
 * verdict from a status we do not model would put a fabricated proof in the ledger,
 * which is worse than an honest "not yet".
 */
export function reconcile(
  claim: OutcomeClaim,
  truth: ProviderTruth | null,
): Reconciliation {
  const spec = TRUTH_SOURCES[claim.channel]
  const base = { channel: claim.channel, truthSource: spec.source }

  if (spec.source === null) {
    return {
      ...base,
      verdict: "unverifiable",
      needsManager: false,
      explanation: `The ${claim.channel} lane has no provider signal that could prove this — recorded as unverifiable rather than assumed.`,
      providerStatus: null,
    }
  }
  if (!truth) {
    return {
      ...base,
      verdict: "pending",
      needsManager: false,
      explanation: `Handed to the provider; ${spec.source} has not reported yet. Not confirmed.`,
      providerStatus: null,
    }
  }

  const status = truth.status.trim().toLowerCase()
  if (spec.confirms.some((s) => s.toLowerCase() === status)) {
    return {
      ...base,
      verdict: "confirmed",
      needsManager: false,
      explanation: `Proven by ${spec.source}: ${truth.status}.`,
      providerStatus: truth.status,
    }
  }
  if (spec.contradicts.some((s) => s.toLowerCase() === status)) {
    return {
      ...base,
      verdict: "contradicted",
      // THE loop trigger. We told the brokerage this happened; it did not.
      needsManager: true,
      explanation: `We recorded "${claim.claimedStatus}" but ${spec.source} reports ${truth.status} — the touch did not land.`,
      providerStatus: truth.status,
    }
  }
  if (spec.inFlight.some((s) => s.toLowerCase() === status)) {
    return {
      ...base,
      verdict: "pending",
      needsManager: false,
      explanation: `${spec.source} reports ${truth.status} — still in flight, not delivery.`,
      providerStatus: truth.status,
    }
  }
  // Unmodelled status: honestly pending. Never guessed.
  return {
    ...base,
    verdict: "pending",
    needsManager: false,
    explanation: `${spec.source} reported "${truth.status}", which this OS does not model yet — held as pending rather than guessed.`,
    providerStatus: truth.status,
  }
}

/**
 * PURE: is a claim OVERDUE — handed over long enough ago that silence is itself a
 * finding? A provider that never reports is indistinguishable from a lost message
 * unless somebody counts the clock.
 *
 * Windows are per-lane and reflect how the provider actually behaves: Twilio
 * callbacks land in minutes, SendGrid in minutes, a Lob piece takes days.
 */
export const OVERDUE_HOURS: Record<OutcomeChannel, number> = {
  email: 24,
  sms: 6,
  direct_mail: 24 * 14,
  social: 6,
  video: 24,
}

export function isOverdue(
  channel: OutcomeChannel,
  claimedAt: string,
  now: Date = new Date(),
): boolean {
  const t = Date.parse(claimedAt)
  if (Number.isNaN(t)) return false // never call an unparseable timestamp overdue
  return now.getTime() - t > OVERDUE_HOURS[channel] * 3_600_000
}

/** PURE: the headline a broker reads. Counts, not adjectives. */
export interface ReconciliationSummary {
  total: number
  confirmed: number
  contradicted: number
  pending: number
  unverifiable: number
  /** confirmed / (confirmed + contradicted) — the PROVEN rate over what we know. */
  provenRatePct: number | null
}

export function summarizeReconciliations(
  items: ReadonlyArray<{ verdict: ReconciliationVerdict }>,
): ReconciliationSummary {
  const s: ReconciliationSummary = {
    total: items.length, confirmed: 0, contradicted: 0, pending: 0, unverifiable: 0,
    provenRatePct: null,
  }
  for (const i of items) s[i.verdict]++
  const decided = s.confirmed + s.contradicted
  // Deliberately excludes pending: a rate that counts unreported sends as
  // successes is the same optimism this module removes.
  s.provenRatePct = decided > 0 ? Math.round((s.confirmed / decided) * 1000) / 10 : null
  return s
}
