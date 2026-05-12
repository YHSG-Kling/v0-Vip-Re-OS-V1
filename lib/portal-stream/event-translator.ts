/**
 * Event Translator — lifecycle_event → customer-facing copy + agent disposition.
 *
 * Copy is PERSONA-AWARE. The contact's `contact_persona` (set by
 * inferBuyerPersona or hand-classified by the agent) flows in and lets
 * each event return wording that matches how the customer thinks. This
 * mirrors how `lib/kernel/portal.ts:determinePortalView` already routes
 * the portal view + education by persona — the live event stream is
 * just the dynamic-copy companion to that static-content routing.
 *
 * Adding a new event_type:
 *   1. Add an entry to TRANSLATIONS keyed by event_type
 *   2. If wording materially differs by persona, branch on input.persona
 *      via the byPersona() helper and return persona-tuned copy.
 *      Otherwise return a neutral string and the translator uses it for
 *      everyone.
 *
 * Three-way disposition pattern: every entry CAN set agent_action_required +
 * agent_action_label. The UI surfaces "Done manually / Do now / AI do it"
 * automatically — the translator only declares whether an action is owed.
 */

/** Mirrors lib/buyer-search/persona-inference.BuyerPersona plus the seller
 *  persona values used in lib/kernel/brand-voice.ts. We widen to plain
 *  string because contact_persona is `text` in the live schema and can
 *  hold either family of values (or a custom one). */
export type ContactPersona =
  // Buyer personas
  | "first_time_buyer"
  | "move_up_buyer"
  | "investor"
  | "relocation"
  | "downsizer"
  | "luxury_buyer"
  | "bargain_hunter"
  // Seller personas
  | "expired"
  | "fsbo"
  | "divorce"
  | "probate"
  | "foreclosure"
  | "military"
  // Catch-all
  | "undetermined"
  | string

export interface TranslatedEvent {
  customerCopy:           string | null
  customerIcon:           string | null
  agentCopy:              string
  agentActionRequired:    boolean
  agentActionLabel:       string | null
  severity:               "normal" | "high" | "critical" | "celebration"
}

export interface TranslatorInput {
  eventType:        string
  metadata:         Record<string, unknown> | null
  entityType:       string | null
  propertyAddress?: string | null
  agentFirstName?:  string | null
  /** Canonical persona for copy tuning — pulled from
   *  contacts.contact_persona by the projector cron. Null/undefined
   *  falls back to neutral wording. */
  persona?:         ContactPersona | null
}

type Builder = (input: TranslatorInput) => Omit<TranslatedEvent, "customerCopy"> & { customerCopy: string | null }

// ─── Persona-aware copy helper ────────────────────────────────────────────

/** Returns the persona-keyed string when present, falling back to neutral. */
function byPersona(
  persona: ContactPersona | null | undefined,
  table:   Partial<Record<ContactPersona, string>>,
  fallback: string,
): string {
  if (!persona) return fallback
  return table[persona] ?? fallback
}

// ─── Translations ──────────────────────────────────────────────────────────

const TRANSLATIONS: Record<string, Builder> = {
  // ───── Offer flow ───────────────────────────────────────────────────────
  "offer.submitted": ({ propertyAddress, metadata, persona }) => {
    const price = metadata?.offer_price as number | undefined
    const priceStr = price ? ` of $${Math.round(price).toLocaleString()}` : ""
    const addrStr  = propertyAddress ? ` on ${propertyAddress}` : ""
    return {
      customerCopy: byPersona(persona, {
        first_time_buyer: `📤 Your first-home offer${priceStr} was submitted${addrStr}. Take a breath — we'll hear back soon and walk you through every step.`,
        investor:         `📤 Offer${priceStr} submitted${addrStr}. Listing agent acknowledgment pending; due-diligence window queued.`,
        downsizer:        `📤 Your offer${priceStr} on ${propertyAddress ?? "the property"} is in. We'll keep you posted as the response comes back.`,
        luxury_buyer:     `📤 Offer${priceStr} delivered${addrStr}. Listing agent will respond shortly.`,
      }, `📤 Your offer${priceStr} was submitted${addrStr}. Listing agent will respond.`),
      customerIcon:        "📤",
      agentCopy:           `Offer submitted${priceStr} — listing agent will respond`,
      agentActionRequired: false,
      agentActionLabel:    null,
      severity:            "normal",
    }
  },

  "offer.countered": ({ propertyAddress, metadata, persona }) => {
    const counter = metadata?.counter_price ? ` at $${Math.round(metadata.counter_price as number).toLocaleString()}` : ""
    const addrStr = propertyAddress ? ` on ${propertyAddress}` : ""
    return {
      customerCopy: byPersona(persona, {
        first_time_buyer: `📩 The seller sent back a counter${counter}${addrStr}. Don't worry — this is normal. Your agent is preparing your response and will explain the options before you decide.`,
        investor:         `📩 Counter received${counter}${addrStr}. Negotiation Co-Pilot will model the trade-off before reply.`,
        bargain_hunter:   `📩 Seller countered${counter}${addrStr}. Your agent will look for room to push back.`,
      }, `📩 Seller countered your offer${addrStr}${counter}. Your agent is preparing a response.`),
      customerIcon:        "📩",
      agentCopy:           `Counter received — Negotiation Co-Pilot will draft a response`,
      agentActionRequired: true,
      agentActionLabel:    "Draft counter response",
      severity:            "high",
    }
  },

  "offer.accepted": ({ propertyAddress, persona }) => {
    const addrStr = propertyAddress ? ` on ${propertyAddress}` : ""
    return {
      customerCopy: byPersona(persona, {
        first_time_buyer: `🎉 They said yes! Your offer was accepted${addrStr}. Welcome to the under-contract phase — we'll guide you through inspection, appraisal, and closing day, step by step.`,
        investor:         `🎉 Acquisition secured${addrStr}. Under contract — due-diligence period now active.`,
        downsizer:        `🎉 Offer accepted${addrStr}! Time to plan the transition from your current home.`,
        luxury_buyer:     `🎉 Offer accepted${addrStr}. Moving to contract.`,
        relocation:       `🎉 Offer accepted${addrStr} — perfect timing for your move. Closing schedule will lock in soon.`,
        military:         `🎉 Offer accepted${addrStr}. We'll align the closing timeline with your orders.`,
      }, `🎉 Your offer was accepted${addrStr}! Going under contract.`),
      customerIcon:        "🎉",
      agentCopy:           `Offer accepted — open transaction kicked off`,
      agentActionRequired: false,
      agentActionLabel:    null,
      severity:            "celebration",
    }
  },

  "offer.rejected": ({ propertyAddress, persona }) => {
    const addrStr = propertyAddress ? ` on ${propertyAddress}` : ""
    return {
      customerCopy: byPersona(persona, {
        first_time_buyer: `Heads up — this offer didn't land${addrStr}. That happens, and it's not a setback. Your agent is already lining up the next options that fit you better.`,
        investor:         `Offer didn't clear${addrStr}. Pipeline review queued — your agent will surface the next deal.`,
        bargain_hunter:   `Offer rejected${addrStr}. Your agent is hunting the next undervalued opportunity.`,
      }, `Heads up — your offer wasn't accepted${addrStr}. Your agent is looking at next steps.`),
      customerIcon:        "💬",
      agentCopy:           `Offer rejected — review alternative properties with the buyer`,
      agentActionRequired: true,
      agentActionLabel:    "Review next-property options",
      severity:            "high",
    }
  },

  // ───── Transaction milestones ──────────────────────────────────────────
  "transaction.under_contract": ({ propertyAddress, persona }) => {
    const addrStr = propertyAddress ? ` on ${propertyAddress}` : ""
    return {
      customerCopy: byPersona(persona, {
        first_time_buyer: `📋 You're officially under contract${addrStr}! Big step. Inspection and appraisal are next — your agent will set up everything and explain what each one means.`,
        investor:         `📋 Under contract${addrStr}. Inspection + appraisal windows opened.`,
        downsizer:        `📋 Under contract${addrStr}! Now we coordinate your current-home timing with this purchase.`,
      }, `📋 You're under contract${addrStr}! Inspection + appraisal coming up.`),
      customerIcon:        "📋",
      agentCopy:           `Under contract — start closing prep workflow`,
      agentActionRequired: true,
      agentActionLabel:    "Open closing workflow",
      severity:            "celebration",
    }
  },

  "inspection.scheduled": ({ metadata, persona }) => {
    const date = metadata?.scheduled_date ? ` for ${new Date(String(metadata.scheduled_date)).toLocaleDateString()}` : ""
    return {
      customerCopy: byPersona(persona, {
        first_time_buyer: `🔍 Inspection scheduled${date}. The inspector will check everything top-to-bottom; your agent will translate the report into what actually matters.`,
        investor:         `🔍 Inspection scheduled${date}. Findings review ~2 business days post-inspection.`,
      }, `🔍 Inspection scheduled${date}. Typical findings review takes 2–3 days.`),
      customerIcon:        "🔍",
      agentCopy:           `Inspection scheduled — prep findings review`,
      agentActionRequired: false,
      agentActionLabel:    null,
      severity:            "normal",
    }
  },

  "inspection.completed": ({ persona }) => ({
    customerCopy: byPersona(persona, {
      first_time_buyer: `✅ Inspection done — your agent has the report and will walk you through everything that came back. Anything that needs a conversation, we'll have it together.`,
      investor:         `✅ Inspection complete. Repair Co-Pilot ready for line-item negotiation.`,
    }, `✅ Inspection complete — your agent is reviewing the report and will discuss findings.`),
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

  "appraisal.completed": ({ metadata, persona }) => {
    const val = metadata?.appraisal_value as number | undefined
    const valStr = val ? `$${Math.round(val).toLocaleString()}` : ""
    return {
      customerCopy: byPersona(persona, {
        first_time_buyer: val
          ? `✅ Appraisal came back at ${valStr}. Your agent will explain what this means — most of the time it's good news.`
          : `✅ Appraisal came back. Your agent will explain what this means.`,
        investor: val
          ? `✅ Appraisal returned ${valStr}. ARV impact + lender position review queued.`
          : `✅ Appraisal returned. Lender position review queued.`,
      }, val
        ? `✅ Appraisal completed at ${valStr}. Your agent will explain what this means for your deal.`
        : `✅ Appraisal completed. Your agent will explain what this means for your deal.`),
      customerIcon:        "✅",
      agentCopy:           `Appraisal${val ? ` at ${valStr}` : ""} — review with buyer`,
      agentActionRequired: true,
      agentActionLabel:    "Send buyer a value-meaning explainer",
      severity:            "high",
    }
  },

  "financing.cleared": ({ persona }) => ({
    customerCopy: byPersona(persona, {
      first_time_buyer: `✅ Your loan is officially cleared to close. The biggest hurdle is now behind you — you're moving toward signing day!`,
      investor:         `✅ Clear to close. Final walkthrough + settlement next.`,
    }, `✅ Financing cleared! One major hurdle behind you.`),
    customerIcon:        "✅",
    agentCopy:           `Loan clear-to-close — final walkthrough next`,
    agentActionRequired: false,
    agentActionLabel:    null,
    severity:            "celebration",
  }),

  "transaction.closing_scheduled": ({ metadata, persona }) => {
    const date = metadata?.closing_date ? ` for ${new Date(String(metadata.closing_date)).toLocaleDateString()}` : ""
    return {
      customerCopy: byPersona(persona, {
        first_time_buyer: `🗓 Closing scheduled${date}! Your agent will set up the final walkthrough and let you know exactly what to bring on signing day.`,
        investor:         `🗓 Settlement scheduled${date}. Final walkthrough + wire instructions inbound.`,
        downsizer:        `🗓 Closing scheduled${date}. Let's also lock the move-out timing for your current home.`,
      }, `🗓 Closing scheduled${date}. Final walkthrough + paperwork prep coming.`),
      customerIcon:        "🗓",
      agentCopy:           `Closing scheduled — confirm with title + walkthrough`,
      agentActionRequired: true,
      agentActionLabel:    "Confirm closing-day plan with all parties",
      severity:            "high",
    }
  },

  "transaction.closed": ({ propertyAddress, persona }) => {
    const addrStr = propertyAddress ? ` on ${propertyAddress}` : ""
    return {
      customerCopy: byPersona(persona, {
        first_time_buyer: `🎉 You're a homeowner! Congratulations${addrStr}. This portal stays open for you — it'll track your equity, alert you to refinance moments, and keep you connected to your agent for the long haul.`,
        investor:         `🎉 Acquisition closed${addrStr}. Asset live in your portal — equity + cash-flow tracking on.`,
        downsizer:        `🎉 Closed${addrStr}. New chapter begins. Your portal will help with the transition and stay with you long-term.`,
        luxury_buyer:     `🎉 Closing complete${addrStr}. Welcome to your new property — your concierge portal is now active.`,
        relocation:       `🎉 Closed${addrStr} — welcome to your new city. The portal will keep you connected to your agent here.`,
        military:         `🎉 Closed${addrStr}. Stationed in your new home — your portal moves with you wherever orders take you next.`,
      }, `🎉 Congratulations — you're closed${addrStr}! Welcome to your new home. Your portal stays open forever.`),
      customerIcon:        "🎉",
      agentCopy:           `Closed — contact promoted to lifetime customer`,
      agentActionRequired: true,
      agentActionLabel:    "Send celebration gift + thank-you",
      severity:            "celebration",
    }
  },

  // ───── Listing-side milestones (visible to seller) ─────────────────────
  "listing.went_live": ({ propertyAddress, persona }) => {
    const addrStr = propertyAddress ? ` at ${propertyAddress}` : ""
    return {
      customerCopy: byPersona(persona, {
        expired:   `🏠 Your home${addrStr} is live again — this time with the marketing plan we built together.`,
        fsbo:      `🏠 Your home${addrStr} is live on MLS with full agent representation. Showings start now.`,
        divorce:   `🏠 Your listing${addrStr} is live. Discreet showings only — your privacy preferences are locked in.`,
        downsizer: `🏠 Your listing${addrStr} is live! Showings begin now — we'll keep the schedule manageable.`,
      }, `🏠 Your listing${addrStr} is live on MLS! Showings start now.`),
      customerIcon:        "🏠",
      agentCopy:           `Listing went live — open house + marketing campaigns trigger`,
      agentActionRequired: false,
      agentActionLabel:    null,
      severity:            "celebration",
    }
  },

  "listing.showing_completed": ({ metadata, persona }) => ({
    customerCopy: byPersona(persona, {
      divorce: `👥 A buyer toured your home today — your agent will summarize feedback discreetly.`,
    }, `👥 A buyer toured your home${metadata?.feedback ? ` — feedback shared by your agent` : ""}.`),
    customerIcon:        "👥",
    agentCopy:           `Showing complete — feedback pending or logged`,
    agentActionRequired: !metadata?.feedback,
    agentActionLabel:    metadata?.feedback ? null : "Log showing feedback for seller",
    severity:            "normal",
  }),

  "listing.price_reduced": ({ metadata, persona }) => {
    const price = metadata?.new_price ? ` to $${Math.round(metadata.new_price as number).toLocaleString()}` : ""
    return {
      customerCopy: byPersona(persona, {
        expired: `💲 Price adjusted${price} based on our new strategy. The previous listing's price wasn't matching what the market told us — this is the fix.`,
      }, `💲 Listing price adjusted${price}.`),
      customerIcon:        "💲",
      agentCopy:           `Price reduced — notify hot buyer pool`,
      agentActionRequired: true,
      agentActionLabel:    "Notify interested buyers about price drop",
      severity:            "high",
    }
  },

  // ───── Forever-mode signals (post-close) ───────────────────────────────
  "wealth.refinance_opportunity": ({ metadata, persona }) => {
    const savings = metadata?.monthly_savings_estimate as number | undefined
    const savingsStr = savings ? `~$${Math.round(savings).toLocaleString()}/mo` : ""
    return {
      customerCopy: byPersona(persona, {
        first_time_buyer: savings
          ? `💡 Mortgage rates moved — you might save ${savingsStr} every month by refinancing. No pressure; want me to walk you through it?`
          : `💡 Mortgage rates moved — there may be a refinance worth talking about. No pressure.`,
        investor:         savings
          ? `💡 Refinance opportunity: ${savingsStr} on this asset. Cash-out scenarios available.`
          : `💡 Refinance opportunity on this asset. Cash-out scenarios available.`,
        downsizer:        savings
          ? `💡 Rates dropped — there may be a refinance worth exploring (~${savingsStr}). Happy to model it if helpful.`
          : `💡 Rates dropped — refinance worth a look. Happy to model it.`,
      }, savings
        ? `💡 Rates dropped — you could save ${savingsStr} by refinancing. Want to chat?`
        : `💡 A refinance opportunity opened up on your home. Want to chat?`),
      customerIcon:        "💡",
      agentCopy:           `Refinance opp on contact's home — push to portal + reach out`,
      agentActionRequired: true,
      agentActionLabel:    "Send a personalized refi note",
      severity:            "high",
    }
  },

  "wealth.equity_milestone": ({ metadata, persona }) => {
    const equity = metadata?.estimated_equity as number | undefined
    const equityStr = equity ? `past $${Math.round(equity).toLocaleString()}` : "to a new milestone"
    return {
      customerCopy: byPersona(persona, {
        first_time_buyer: `📈 Big moment — your home equity grew ${equityStr}. That's real wealth you've built. Want to talk through what's possible?`,
        investor:         `📈 Equity milestone ${equityStr}. Cash-out + 1031 + portfolio-balance scenarios available.`,
        downsizer:        `📈 Your equity ${equityStr}. Good moment to chat options — sell, downsize, or hold.`,
      }, `📈 Your home equity grew ${equityStr}!`),
      customerIcon:        "📈",
      agentCopy:           `Equity milestone for contact — perfect referral-ask moment`,
      agentActionRequired: true,
      agentActionLabel:    "Send equity-milestone note + referral ask",
      severity:            "normal",
    }
  },

  "lifetime.anniversary": ({ metadata, persona }) => {
    const years = metadata?.years_owned as number | undefined
    const yearStr = years ? `${years}-year` : ""
    return {
      customerCopy: byPersona(persona, {
        first_time_buyer: years
          ? `🎉 Happy ${yearStr} anniversary in your first home! Thinking of you — your agent reached out personally.`
          : `🎉 Happy anniversary in your first home! Thinking of you.`,
        investor:         years
          ? `🎉 ${yearStr} anniversary on this property. Performance snapshot enclosed.`
          : `🎉 Anniversary on this property. Performance snapshot enclosed.`,
        downsizer:        years
          ? `🎉 Happy ${yearStr} in your new place! Hope it's still feeling like home.`
          : `🎉 Happy anniversary in your new place!`,
        luxury_buyer:     years
          ? `🎉 ${yearStr} anniversary at your residence. A personal note from your agent.`
          : `🎉 Anniversary at your residence. A personal note from your agent.`,
      }, years
        ? `🎉 Happy ${yearStr} homeowner anniversary! Your agent is thinking of you.`
        : `🎉 Happy anniversary in your home!`),
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
  if (!builder) return null
  return builder(input)
}

export const PROJECTABLE_EVENT_TYPES: string[] = Object.keys(TRANSLATIONS)
