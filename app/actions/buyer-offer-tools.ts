"use server"

// app/actions/buyer-offer-tools.ts
// ─────────────────────────────────────────────────────────────────────────────
// BUYER SELF-SERVE → SIGNAL THE AGENT. When a buyer uses a portal tool on a property they like —
// runs the affordability numbers, or asks for help making an offer — the Shopping Agent's human
// is looped in immediately, and "help me make an offer" fires the gated Offer Accelerator (the
// comps-grounded plan + the offer-confidence reel). The buyer self-qualifies; the team convenes.
// Mirrors the requestShowing buyer-as-actor pattern (client_portal_activity + agent notification).

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireContactAccess } from "@/lib/portal/require-contact-access"
import { buildOfferHelpAcknowledgement, type OfferHelpOutcome } from "@/lib/agents/offer-strategy-producer"

/** A non-exported const is fine in a "use server" file — only EXPORTS must be async functions. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type ContactRow = { id: string; first_name: string | null; last_name: string | null; brokerage_id: string | null; agent_id: string | null }
type ResolvedContact =
  | { ok: true; contact: ContactRow; agentUserId: string | null }
  | { ok: false; reason: "unreadable" | "not_found" }

/** Resolve the contact's tenancy + assigned agent (agents.id → users.id) from the contact row,
 *  NOT the auth user (the buyer's portal user is not the agent). Mirrors requestShowing.
 *  supabase-js RESOLVES a refused read, so a denied row used to arrive as "Contact not found" —
 *  a clean negative for what is actually a failure. The two are now distinct. */
async function resolveContactAgent(supabase: any, contactId: string): Promise<ResolvedContact> {
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, brokerage_id, agent_id")
    .eq("id", contactId)
    .maybeSingle()
  if (contactError) {
    console.error("[buyer-offer-tools] contact read refused:", contactError.message)
    return { ok: false, reason: "unreadable" }
  }
  if (!contact) return { ok: false, reason: "not_found" }
  let agentUserId: string | null = null
  if (contact.agent_id) {
    const { data: agentRow, error: agentError } = await supabase.from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
    if (agentError) console.error("[buyer-offer-tools] agent read refused:", agentError.message)
    agentUserId = (agentRow as { user_id: string | null } | null)?.user_id ?? null
  }
  return { ok: true, contact: contact as ContactRow, agentUserId }
}

/** The buyer's click, on the record. `brokerage_id` and `agent_id` are populated because the
 *  RLS lanes that let an agent (or their brokerage) READ this row key off exactly those two
 *  columns — a row written without them is a signal nobody can see. A bare try/catch used to
 *  wrap this: supabase-js RESOLVES a refused write, so the catch never fired and the error was
 *  dropped regardless. It is destructured and reported now. */
async function recordPortalActivity(
  supabase: any,
  args: { contactId: string; brokerageId: string | null; agentId: string | null; activityType: string; propertyId?: string | null; metadata: Record<string, unknown> },
): Promise<boolean> {
  const { error } = await supabase.from("client_portal_activity").insert({
    brokerage_id: args.brokerageId,
    contact_id: args.contactId,
    agent_id: args.agentId,
    // loose uuid ref — a non-uuid handle would fail the whole insert, so it rides metadata only
    property_id: args.propertyId && UUID_RE.test(args.propertyId) ? args.propertyId : null,
    activity_type: args.activityType,
    metadata: args.metadata,
  })
  if (error) {
    console.error(`[buyer-offer-tools] portal activity '${args.activityType}' NOT recorded:`, error.message)
    return false
  }
  return true
}

type NotifyResult = { ok: boolean; reason?: "no_agent" | "write_failed" }

async function notifyAgent(
  supabase: any,
  args: { agentUserId: string | null; brokerageId: string | null; type: string; title: string; body: string; entityId: string },
): Promise<NotifyResult> {
  if (!args.agentUserId || !args.brokerageId) return { ok: false, reason: "no_agent" }
  const { error } = await supabase.from("notifications").insert({
    user_id: args.agentUserId, brokerage_id: args.brokerageId,
    type: args.type, title: args.title, body: args.body,
    entity_type: "contact", entity_id: args.entityId, priority: "high", channel: "in_app",
  })
  if (error) {
    console.error(`[buyer-offer-tools] agent notification '${args.type}' NOT delivered:`, error.message)
    return { ok: false, reason: "write_failed" }
  }
  return { ok: true }
}

/**
 * THE BUYER'S DURABLE MESSAGE. A toast does not survive a refresh: a buyer who navigated away
 * had no record they had asked and no thread to watch. This writes to the SAME portal thread the
 * buyer already reads (the portal Messages rail — the one the buyer home page previews and the
 * agent replies on), on the agent's side of the conversation, and lights the buyer's portal bell
 * the way an agent-sent message does. It never carries a recommended price: the plan goes to the
 * agent for approval first, and they deliver the number.
 */
async function writeBuyerThreadMessage(
  supabase: any,
  args: { contactId: string; brokerageId: string; agentId: string; body: string; propertyId: string; propertyAddress: string },
): Promise<boolean> {
  const { error } = await supabase.from("client_portal_messages").insert({
    brokerage_id: args.brokerageId,
    contact_id: args.contactId,
    agent_id: args.agentId,
    body: args.body,
    direction: "agent_to_client",
    channel: "portal",
    read: false,
    metadata: { source: "buyer_portal", kind: "offer_help_acknowledgement", property_id: args.propertyId, property_address: args.propertyAddress },
  })
  if (error) {
    console.error("[buyer-offer-tools] buyer thread message NOT written:", error.message)
    return false
  }
  const { error: bellError } = await supabase.from("notifications").insert({
    brokerage_id: args.brokerageId, contact_id: args.contactId, user_id: null,
    type: "portal_message", channel: "in_app", priority: "medium",
    title: "Your agent is on your offer request", body: args.body.slice(0, 140),
    entity_type: "contact", entity_id: args.contactId, is_read: false,
  })
  // The message IS on the thread — say the bell failed rather than claiming the message did.
  if (bellError) console.error("[buyer-offer-tools] thread message stored but portal bell NOT lit:", bellError.message)
  return true
}

/**
 * signalAffordabilityChecked — the buyer ran the affordability numbers on a property. Record the
 * activity + notify the agent that the buyer is actively evaluating a specific home (high intent).
 */
export async function signalAffordabilityChecked(input: {
  contactId: string
  propertyId: string
  propertyAddress: string
  price: number
  monthlyEstimate: number
  verdict: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const resolved = await resolveContactAgent(supabase, input.contactId)
    if (!resolved.ok) {
      return resolved.reason === "unreadable"
        ? { success: false, error: "We couldn't reach your account just now — please try again." }
        : { success: false, error: "Contact not found" }
    }
    const { contact, agentUserId } = resolved

    await recordPortalActivity(supabase, {
      contactId: input.contactId, brokerageId: contact.brokerage_id, agentId: contact.agent_id,
      activityType: "affordability_checked", propertyId: input.propertyId,
      metadata: {
        property_id: input.propertyId, property_address: input.propertyAddress,
        price: input.price, monthly_estimate: input.monthlyEstimate, verdict: input.verdict,
        source: "buyer_portal",
      },
    })

    const money = (n: number) => `$${Math.round(n).toLocaleString()}`
    await notifyAgent(supabase, {
      agentUserId, brokerageId: contact.brokerage_id,
      type: "buyer.affordability_checked",
      title: "Buyer is running the numbers",
      body: `${contact.first_name ?? "Your buyer"} checked affordability on ${input.propertyAddress} — ~${money(input.monthlyEstimate)}/mo (${input.verdict.replace(/_/g, " ")}). They're evaluating this home.`,
      entityId: input.contactId,
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "failed" }
  }
}

/**
 * requestOfferHelp — the buyer asked for help writing an offer ON A SPECIFIC PROPERTY. Fire the
 * gated Offer Accelerator FOR THAT PROPERTY, notify the agent, and leave the buyer a durable
 * message on their own portal thread. The buyer-initiated team play.
 *
 * The click is a DECISION SIGNAL, not a legal act (the portal-offer-decision rail's shape):
 * ledger + the agent's queue + an honest message back. Three things are load-bearing here:
 *   · the plan the agent receives is about the home that was clicked (it is keyed by it);
 *   · asking twice about the SAME home is a no-op — no second alert, no second thread post;
 *   · nothing tells the buyer a plan is being prepared unless one actually was, and no
 *     recommended price reaches them — the agent approves the brief and delivers the number.
 */
export async function requestOfferHelp(input: {
  contactId: string
  propertyId: string
  propertyAddress: string
}): Promise<{ success: boolean; accelerated?: boolean; duplicate?: boolean; message?: string; error?: string }> {
  try {
    // This writes to the buyer's own message thread with the service client, so the caller must
    // be proven to belong to this contact (or be staff on it) before anything is written.
    const access = await requireContactAccess(input.contactId)
    if (!access.ok) {
      return { success: false, error: access.error === "Unauthorized" ? "Please sign in to your portal and try again." : access.error }
    }

    // Authorized above; the service client is used deliberately from here (a portal client's
    // own contacts/notifications rows are not reliably readable/writable under their RLS).
    const svc = createServiceClient()
    const resolved = await resolveContactAgent(svc, input.contactId)
    if (!resolved.ok) {
      return resolved.reason === "unreadable"
        ? { success: false, error: "We couldn't reach your account just now — please try again." }
        : { success: false, error: "Contact not found" }
    }
    const { contact, agentUserId } = resolved

    // 1) THE PLAN FIRST — what the agent and the buyer are told depends on what was produced.
    let outcome: OfferHelpOutcome = "no_tenant"
    let briefAddress: string | null = input.propertyAddress?.trim() || null
    if (contact.brokerage_id) {
      try {
        const { produceOfferStrategyBrief } = await import("@/lib/agents/offer-strategy-producer")
        const r = await produceOfferStrategyBrief(contact.brokerage_id, input.contactId, svc, {
          savedPropertyId: input.propertyId,
          propertyAddress: input.propertyAddress,
        })
        outcome = r.outcome
        briefAddress = r.propertyAddress ?? briefAddress
      } catch (e) {
        console.error("[requestOfferHelp] accelerator failed:", e)
        outcome = "accelerator_error"
      }
    }
    const ack = buildOfferHelpAcknowledgement({
      buyerFirstName: contact.first_name, propertyAddress: briefAddress, outcome,
    })

    // 2) The click is recorded either way — it is the high-intent signal the agent's pipeline reads.
    await recordPortalActivity(svc, {
      contactId: input.contactId, brokerageId: contact.brokerage_id, agentId: contact.agent_id,
      activityType: "offer_help_requested", propertyId: input.propertyId,
      metadata: { property_id: input.propertyId, property_address: input.propertyAddress, source: "buyer_portal", outcome, repeat: ack.duplicate },
    })

    // 3) Asking again about the SAME home does not re-alert the agent or re-post to the thread.
    if (ack.duplicate) {
      return { success: true, accelerated: false, duplicate: true, message: ack.clientMessage }
    }

    const notified = await notifyAgent(svc, {
      agentUserId, brokerageId: contact.brokerage_id,
      type: "buyer.offer_help_requested",
      title: ack.agentTitle, body: ack.agentBody,
      entityId: input.contactId,
    })
    if (!notified.ok) {
      // Never tell a buyer their agent has been notified when nobody was.
      return notified.reason === "no_agent"
        ? { success: false, error: "No agent is assigned to your account yet — we've recorded your request and the office will follow up." }
        : { success: false, error: "Your request was recorded but we couldn't alert your agent — message them from your portal to be sure." }
    }

    // 4) The durable message — a toast does not survive a refresh.
    let delivered = false
    if (contact.brokerage_id && contact.agent_id) {
      delivered = await writeBuyerThreadMessage(svc, {
        contactId: input.contactId, brokerageId: contact.brokerage_id, agentId: contact.agent_id,
        body: ack.buyerMessage, propertyId: input.propertyId, propertyAddress: input.propertyAddress,
      })
    }
    if (!delivered) console.error("[requestOfferHelp] agent alerted but no durable buyer message was written")

    return { success: true, accelerated: ack.planPrepared, duplicate: false, message: ack.clientMessage }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "failed" }
  }
}

/**
 * analyzeAddressForBuyer — the buyer pastes ANY address and our tools run on it: free OSINT spec
 * lookup + the (cache/Perplexity-first, non-paid) AVM → estimated value + specs, so the
 * affordability tool works on the whole market, not just saved homes. Researching a specific
 * address is a HIGH-intent signal — recorded quietly for the agent (no notification spam).
 */
export async function analyzeAddressForBuyer(input: {
  contactId: string
  address: string
}): Promise<{ success: boolean; analysis?: import("@/lib/buyer-offers/address-analysis").AddressAnalysis; error?: string }> {
  try {
    const address = (input.address ?? "").trim()
    if (address.length < 5) return { success: false, error: "Enter a full address" }
    const supabase = await createClient()
    const { data: contact, error: contactError } = await supabase.from("contacts").select("id, brokerage_id, agent_id").eq("id", input.contactId).maybeSingle()
    if (contactError) console.error("[buyer-offer-tools] contact read refused:", contactError.message)
    const brokerageId = (contact as { brokerage_id: string | null } | null)?.brokerage_id ?? null
    const contactAgentId = (contact as { agent_id: string | null } | null)?.agent_id ?? null

    const [{ lookupPropertyByAddress }, { getRentcastAVM }, { getCurrentAvm }, { buildAddressAnalysis }] = await Promise.all([
      import("@/lib/property/address-lookup"),
      import("@/lib/property/rentcast"),
      import("@/lib/avm/provider-chain"),
      import("@/lib/buyer-offers/address-analysis"),
    ])
    // RentCast is the brokerage's chosen property-data provider — try its AVM first (with a value
    // RANGE, which is more honest than a single number). Fall back to the free cache/Perplexity
    // tier only when RentCast has no key or no hit. Specs come from the free OSINT lookup.
    const [lookup, rc] = await Promise.all([
      lookupPropertyByAddress({ address, city: "", state: "" }).catch(() => null),
      brokerageId ? getRentcastAVM({ brokerageId, address }).catch(() => null) : Promise.resolve(null),
    ])
    let avm: { value: number; confidence: number; source: string } | null = null
    let range: { low: number | null; high: number | null } | null = null
    if (rc && typeof rc.value === "number" && rc.value > 0) {
      avm = { value: rc.value, confidence: 0.85, source: "rentcast" }
      range = { low: rc.rangeLow ?? null, high: rc.rangeHigh ?? null }
    } else {
      const fallback = await getCurrentAvm({ address, brokerageId }).catch(() => null)
      if (fallback) avm = { value: fallback.value, confidence: fallback.confidence, source: fallback.source }
    }
    const analysis = buildAddressAnalysis(lookup as any, avm, range)

    // Quiet high-intent signal — the buyer is researching a specific home.
    await recordPortalActivity(supabase, {
      contactId: input.contactId, brokerageId, agentId: contactAgentId,
      activityType: "address_analyzed",
      metadata: { address, estimated_value: analysis.estimatedValue, source: "buyer_portal" },
    })

    return { success: true, analysis }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "failed" }
  }
}

/**
 * requestComparisonReview — the buyer has lined up their finalists side-by-side and wants the
 * agent's take. A HIGH-intent moment (they're close to choosing) — notify the agent WHICH homes
 * they're weighing so the agent can guide the decision. Fires only on the explicit ask (never on
 * mere browsing) — signal, not noise.
 */
export async function requestComparisonReview(input: {
  contactId: string
  addresses: string[]
}): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const resolved = await resolveContactAgent(supabase, input.contactId)
    if (!resolved.ok) {
      return resolved.reason === "unreadable"
        ? { success: false, error: "We couldn't reach your account just now — please try again." }
        : { success: false, error: "Contact not found" }
    }
    const { contact, agentUserId } = resolved
    const homes = (input.addresses ?? []).filter(Boolean).slice(0, 4)
    if (homes.length < 2) return { success: false, error: "Pick at least two homes to compare" }

    await recordPortalActivity(supabase, {
      contactId: input.contactId, brokerageId: contact.brokerage_id, agentId: contact.agent_id,
      activityType: "comparison_review_requested",
      metadata: { addresses: homes, source: "buyer_portal" },
    })

    await notifyAgent(supabase, {
      agentUserId, brokerageId: contact.brokerage_id,
      type: "buyer.comparison_review_requested",
      title: "Buyer is weighing their finalists",
      body: `${contact.first_name ?? "Your buyer"} is comparing ${homes.join(" vs ")} and wants your take — they're close to choosing.`,
      entityId: input.contactId,
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "failed" }
  }
}

/**
 * requestPreApprovalRefresh — the buyer's pre-approval is expired/expiring (or missing) and they
 * want to get (back) to offer-ready. Notify the agent to connect them with a lender. The agent is
 * the right owner pre-offer (the Finance Manager owns the in-deal lender side); this keeps the
 * buyer's self-serve tool honest — an expired approval shouldn't masquerade as a real ceiling.
 */
export async function requestPreApprovalRefresh(input: {
  contactId: string
  propertyId: string
  propertyAddress: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const resolved = await resolveContactAgent(supabase, input.contactId)
    if (!resolved.ok) {
      return resolved.reason === "unreadable"
        ? { success: false, error: "We couldn't reach your account just now — please try again." }
        : { success: false, error: "Contact not found" }
    }
    const { contact, agentUserId } = resolved

    await recordPortalActivity(supabase, {
      contactId: input.contactId, brokerageId: contact.brokerage_id, agentId: contact.agent_id,
      activityType: "preapproval_refresh_requested", propertyId: input.propertyId,
      metadata: { property_id: input.propertyId, property_address: input.propertyAddress, source: "buyer_portal" },
    })

    await notifyAgent(supabase, {
      agentUserId, brokerageId: contact.brokerage_id,
      type: "buyer.preapproval_refresh_requested",
      title: "Buyer wants to refresh their pre-approval",
      body: `${contact.first_name ?? "Your buyer"} is evaluating ${input.propertyAddress} and asked to refresh their pre-approval — connect them with a lender to get back to offer-ready.`,
      entityId: input.contactId,
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "failed" }
  }
}
