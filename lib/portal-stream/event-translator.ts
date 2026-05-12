/**
 * Event Translator — lifecycle_event → customer-facing copy + agent disposition.
 *
 * The projector cron reads new lifecycle_events rows and calls translate()
 * to produce the human-readable strings that land in portal_event_stream.
 * Customer-facing copy is what the client sees in their Forever Portal feed;
 * agent_copy is what the agent sees in the CRM with the disposition controls.
 *
 * Adding a new event_type:
 *   1. Add an entry to TRANSLATIONS keyed by event_type
 *   2. Return customer_copy null if the event is internal-only
 *
 * Three-way disposition pattern: every entry CAN set agent_action_required +
 * agent_action_label. The UI surfaces "Done manually / Do now / AI do it"
 * automatically — the translator only declares whether an action is owed.
 */

import type { KernelEvent } from "@/lib/kernel/events"

export interface TranslatedEvent {
  customerCopy:           string | null   // null = internal-only event
  customerIcon:           string | null
  agentCopy:              string
  agentActionRequired:    boolean
  agentActionLabel:       string | null
  severity:               "normal" | "high" | "critical" | "celebration"
}

export interface TranslatorInput {
  eventType:   string                          // KernelEvent value or arbitrary
  metadata:    Record<string, unknown> | null  // lifecycle_events.metadata jsonb
  entityType:  string | null
  /** When the event refers to a transaction, the resolved property address. */
  propertyAddress?: string | null
  /** When the agent has a name to embed in copy. */
  agentFirstName?:  string | null
}

type Builder = (input: TranslatorInput) => Omit<TranslatedEvent, "customerCopy"> & { customerCopy: string | null }

// ─── Translations (extend freely; missing keys default to internal-only) ────

const TRANSLATIONS: Record<string, Builder> = {
  // ───── Offer flow ───────────────────────────────────────────────────────
  "offer.submitted": ({ propertyAddress, metadata }) => {
    const price = (metadata?.offer_price as number | undefined)
    return {
      customerCopy:        `📤 Your offer${price ? ` of $${Math.round(price).toLocaleString()}` : ""} was submitted${propertyAddress ? ` on ${propertyAddress}` : ""}. Listing agent will respond.`,
      customerIcon:        "📤",
      agentCopy:           `Offer submitted${price ? ` ($${Math.round(price).toLocaleString()})` : ""} — listing agent will respond`,
      agentActionRequired: false,
      agentActionLabel:    null,
      severity:            "normal",
    }
  },
  "offer.countered": ({ propertyAddress, metadata }) => ({
    customerCopy:        `📩 Seller countered your offer${propertyAddress ? ` on ${propertyAddress}` : ""}${metadata?.counter_price ? ` at $${Math.round(metadata.counter_price as number).toLocaleString()}` : ""}. Your agent is preparing a response.`,
    customerIcon:        "📩",
    agentCopy:           `Counter received — Negotiation Co-Pilot will draft a response`,
    agentActionRequired: true,
    agentActionLabel:    "Draft counter response",
    severity:            "high",
  }),
  "offer.accepted": ({ propertyAddress }) => ({
    customerCopy:        `🎉 Your offer was accepted${propertyAddress ? ` on ${propertyAddress}` : ""}! Going under contract.`,
    customerIcon:        "🎉",
    agentCopy:           `Offer accepted — open transaction kicked off`,
    agentActionRequired: false,
    agentActionLabel:    null,
    severity:            "celebration",
  }),
  "offer.rejected": ({ propertyAddress }) => ({
    customerCopy:        `Heads up — your offer wasn't accepted${propertyAddress ? ` on ${propertyAddress}` : ""}. Your agent is looking at next steps.`,
    customerIcon:        "💬",
    agentCopy:           `Offer rejected — review alternative properties with the buyer`,
    agentActionRequired: true,
    agentActionLabel:    "Review next-property options",
    severity:            "high",
  }),

  // ───── Transaction milestones ──────────────────────────────────────────
  "transaction.under_contract": ({ propertyAddress }) => ({
    customerCopy:        `📋 You're under contract${propertyAddress ? ` on ${propertyAddress}` : ""}! Inspection + appraisal coming up.`,
    customerIcon:        "📋",
    agentCopy:           `Under contract — start closing prep workflow`,
    agentActionRequired: true,
    agentActionLabel:    "Open closing workflow",
    severity:            "celebration",
  }),
  "inspection.scheduled": ({ metadata }) => ({
    customerCopy:        `🔍 Inspection scheduled${metadata?.scheduled_date ? ` for ${new Date(String(metadata.scheduled_date)).toLocaleDateString()}` : ""}. Typical findings review takes 2–3 days.`,
    customerIcon:        "🔍",
    agentCopy:           `Inspection scheduled — prep findings review`,
    agentActionRequired: false,
    agentActionLabel:    null,
    severity:            "normal",
  }),
  "inspection.completed": () => ({
    customerCopy:        `✅ Inspection complete — your agent is reviewing the report and will discuss findings.`,
    customerIcon:        "✅",
    agentCopy:           `Inspection complete — Repair Co-Pilot ready when you are`,
    agentActionRequired: true,
    agentActionLabel:    "Run Repair Co-Pilot",
    severity:            "high",
  }),
  "appraisal.ordered": () => ({
    customerCopy:        `📋 The appraisal has been ordered. Typical return: 5–7 business days.`,
    customerIcon:        "📋",
    agentCopy:           `Appraisal ordered`,
    agentActionRequired: false,
    agentActionLabel:    null,
    severity:            "normal",
  }),
  "appraisal.completed": ({ metadata }) => {
    const val = metadata?.appraisal_value as number | undefined
    return {
      customerCopy:        val
        ? `✅ Appraisal completed at $${Math.round(val).toLocaleString()}. Your agent will explain what this means for your deal.`
        : `✅ Appraisal completed. Your agent will explain what this means for your deal.`,
      customerIcon:        "✅",
      agentCopy:           `Appraisal ${val ? `at $${Math.round(val).toLocaleString()}` : "complete"} — review with buyer`,
      agentActionRequired: true,
      agentActionLabel:    "Send buyer a value-meaning explainer",
      severity:            "high",
    }
  },
  "financing.cleared": () => ({
    customerCopy:        `✅ Financing cleared! One major hurdle behind you.`,
    customerIcon:        "✅",
    agentCopy:           `Loan clear-to-close — final walkthrough next`,
    agentActionRequired: false,
    agentActionLabel:    null,
    severity:            "celebration",
  }),
  "transaction.closing_scheduled": ({ metadata }) => ({
    customerCopy:        `🗓 Closing scheduled${metadata?.closing_date ? ` for ${new Date(String(metadata.closing_date)).toLocaleDateString()}` : ""}. Final walkthrough + paperwork prep coming.`,
    customerIcon:        "🗓",
    agentCopy:           `Closing scheduled — confirm with title + walkthrough`,
    agentActionRequired: true,
    agentActionLabel:    "Confirm closing-day plan with all parties",
    severity:            "high",
  }),
  "transaction.closed": ({ propertyAddress }) => ({
    customerCopy:        `🎉 Congratulations — you're closed${propertyAddress ? ` on ${propertyAddress}` : ""}! Welcome to your new home. Your portal stays open forever.`,
    customerIcon:        "🎉",
    agentCopy:           `Closed — contact promoted to lifetime customer`,
    agentActionRequired: true,
    agentActionLabel:    "Send celebration gift + thank-you",
    severity:            "celebration",
  }),

  // ───── Listing-side milestones (visible to seller) ─────────────────────
  "listing.went_live": ({ propertyAddress }) => ({
    customerCopy:        `🏠 Your listing${propertyAddress ? ` at ${propertyAddress}` : ""} is live on MLS! Showings start now.`,
    customerIcon:        "🏠",
    agentCopy:           `Listing went live — open house + marketing campaigns trigger`,
    agentActionRequired: false,
    agentActionLabel:    null,
    severity:            "celebration",
  }),
  "listing.showing_completed": ({ metadata }) => ({
    customerCopy:        `👥 A buyer toured your home${metadata?.feedback ? ` — feedback shared by your agent` : ""}.`,
    customerIcon:        "👥",
    agentCopy:           `Showing complete — feedback pending or logged`,
    agentActionRequired: !metadata?.feedback,
    agentActionLabel:    metadata?.feedback ? null : "Log showing feedback for seller",
    severity:            "normal",
  }),
  "listing.price_reduced": ({ metadata }) => ({
    customerCopy:        `💲 Listing price adjusted${metadata?.new_price ? ` to $${Math.round(metadata.new_price as number).toLocaleString()}` : ""}.`,
    customerIcon:        "💲",
    agentCopy:           `Price reduced — notify hot buyer pool`,
    agentActionRequired: true,
    agentActionLabel:    "Notify interested buyers about price drop",
    severity:            "high",
  }),

  // ───── Forever-mode signals (post-close) ───────────────────────────────
  "wealth.refinance_opportunity": ({ metadata }) => {
    const savings = metadata?.monthly_savings_estimate as number | undefined
    return {
      customerCopy:        savings
        ? `💡 Rates dropped — you could save ~$${Math.round(savings).toLocaleString()}/mo by refinancing. Want to chat?`
        : `💡 A refinance opportunity opened up on your home. Want to chat?`,
      customerIcon:        "💡",
      agentCopy:           `Refinance opp on contact's home — push to portal + reach out`,
      agentActionRequired: true,
      agentActionLabel:    "Send a personalized refi note",
      severity:            "high",
    }
  },
  "wealth.equity_milestone": ({ metadata }) => {
    const equity = metadata?.estimated_equity as number | undefined
    return {
      customerCopy:        equity
        ? `📈 Your home equity passed $${Math.round(equity).toLocaleString()}!`
        : `📈 Your home equity hit a new milestone.`,
      customerIcon:        "📈",
      agentCopy:           `Equity milestone for contact — perfect referral-ask moment`,
      agentActionRequired: true,
      agentActionLabel:    "Send equity-milestone note + referral ask",
      severity:            "normal",
    }
  },
  "lifetime.anniversary": ({ metadata }) => {
    const years = metadata?.years_owned as number | undefined
    return {
      customerCopy:        years
        ? `🎉 Happy ${years}-year homeowner anniversary! Your agent is thinking of you.`
        : `🎉 Happy anniversary in your home!`,
      customerIcon:        "🎉",
      agentCopy:           `Anniversary — send card / voice note / gift`,
      agentActionRequired: true,
      agentActionLabel:    "Send anniversary touch",
      severity:            "celebration",
    }
  },

  // ───── Customer-portal-side actions ────────────────────────────────────
  "portal.message_sent_by_agent": ({ agentFirstName }) => ({
    customerCopy:        `💬 ${agentFirstName ?? "Your agent"} sent you a message — open your inbox.`,
    customerIcon:        "💬",
    agentCopy:           `Message delivered`,
    agentActionRequired: false,
    agentActionLabel:    null,
    severity:            "normal",
  }),
  "portal.document_signed": ({ metadata }) => ({
    customerCopy:        `✅ ${metadata?.document_name ? String(metadata.document_name) : "Document"} signed and saved to your portal.`,
    customerIcon:        "✅",
    agentCopy:           `Document signed by client`,
    agentActionRequired: false,
    agentActionLabel:    null,
    severity:            "normal",
  }),
}

// ─── Public API ────────────────────────────────────────────────────────────

export function translateEvent(input: TranslatorInput): TranslatedEvent | null {
  const builder = TRANSLATIONS[input.eventType]
  if (!builder) return null   // unknown / internal event — don't project
  return builder(input)
}

/**
 * Subset of event_type values that the projector should scan for in
 * lifecycle_events. Anything not in this set is skipped, which keeps the
 * projector cheap on a brokerage that fires thousands of internal events.
 */
export const PROJECTABLE_EVENT_TYPES: string[] = Object.keys(TRANSLATIONS)
