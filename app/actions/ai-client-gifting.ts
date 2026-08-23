"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { generateObject } from "@/lib/ai/generate"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"
import { SPHERE_CONTACT_TYPES } from "@/lib/contact-types"

/**
 * AI Client Gifting System
 * Smart gift recommendations, budget management, and vendor integration
 */

// ============================================================================
// AI GIFT RECOMMENDATION
// ============================================================================

export async function aiRecommendGift(params: {
  agentId: string
  contactId: string
  occasion: "closing" | "anniversary" | "birthday" | "referral_thank_you" | "holiday" | "apology" | "congratulations"
  budget?: { min: number; max: number }
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Get contact details and history
    //
    // AMBIGUOUS EMBED — DO NOT "SIMPLIFY" THE `!constraint` HINT AWAY.
    // `transactions` carries THREE foreign keys to `contacts`
    // (transactions_contact_id_fkey, transactions_buyer_contact_id_fkey,
    // transactions_seller_contact_id_fkey), so a bare `transactions(...)` embed is
    // ambiguous and PostgREST refuses the WHOLE request with PGRST201 — the read
    // returns nothing and the gift recommendation is built on a $0 deal.
    //
    // `contact_id` is the right one here: the canonical writer documents it as
    // "OUR client — the party we represent" (lib/transactions/offer-bridge.ts:302),
    // and this surface is picking a gift for the agent's own client, whichever side
    // of the deal they sat on. The buyer/seller slots are role mirrors that are null
    // on the other side, so either would silently drop half the book.
    const { data: contact, error: contactErr } = await supabase
      .from("contacts")
      .select(`
        *,
        transactions!transactions_contact_id_fkey(purchase_price, close_date)
      `)
      .eq("id", params.contactId)
      .maybeSingle()

    if (contactErr) {
      return { success: false, error: contactErr.message }
    }
    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // Get past gifts to avoid duplicates
    const { data: pastGifts } = await supabase
      .from("client_gifts")
      .select("gift_type, gift_description, occasion")
      .eq("contact_id", params.contactId)
      .order("created_at", { ascending: false })
      .limit(10)

    const transactionValue = contact.transactions?.[0]?.purchase_price || 0
    const defaultBudget = {
      closing: { min: 50, max: Math.min(transactionValue * 0.001, 500) },
      anniversary: { min: 25, max: 75 },
      birthday: { min: 25, max: 50 },
      referral_thank_you: { min: 50, max: 150 },
      holiday: { min: 25, max: 75 },
      apology: { min: 50, max: 200 },
      congratulations: { min: 25, max: 100 },
    }

    const budget = params.budget || defaultBudget[params.occasion]

    const { object: recommendations } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        topRecommendation: z.object({
          name: z.string(),
          description: z.string(),
          estimatedCost: z.number(),
          vendor: z.string(),
          personalizedNote: z.string(),
          whyThisGift: z.string(),
        }),
        alternatives: z.array(z.object({
          name: z.string(),
          description: z.string(),
          estimatedCost: z.number(),
          vendor: z.string(),
        })),
        avoidList: z.array(z.string()),
        deliveryTiming: z.string(),
        presentationTips: z.array(z.string()),
        taxDeductible: z.boolean(),
      }),
      prompt: `Recommend a gift for this client:

Client: ${contact.first_name} ${contact.last_name}
Occasion: ${params.occasion}
Budget: $${budget.min} - $${budget.max}
Transaction value: $${transactionValue.toLocaleString()}
Notes about client: ${contact.notes || "None"}
Interests mentioned: ${contact.interests || "Unknown"}

Past gifts (avoid duplicates):
${pastGifts?.map(g => `- ${g.gift_description} (${g.occasion})`).join("\n") || "No past gifts"}

Consider:
- Their property type (luxury vs starter home)
- Family situation
- Local vendors for freshness/quality
- Personalization opportunities
- Something memorable, not generic

Recommend:
1. Top gift recommendation with personalized note
2. 2-3 alternatives at different price points
3. What to avoid
4. Best delivery timing
5. Presentation tips`,
    })

    return { success: true, data: recommendations }
  } catch (error) {
    return handleError(error, "aiRecommendGift")
  }
}

// ============================================================================
// AI BULK GIFT PLANNING
// ============================================================================

/**
 * Plan a bulk gifting round across the agent's sphere.
 *
 * `agentId` is no longer taken from the caller. This is a "use server" export —
 * a public HTTP endpoint — and it did two expensive things on a caller-supplied
 * agents.id with no auth gate: it read that agent's whole sphere joined to
 * `transactions(purchase_price, close_date)` (client names + what they paid),
 * and it then spent real tokens on gpt-4o planning gifts against a
 * caller-chosen `totalBudget`. Derived from the session now; `ctx.agentId` is
 * `agents.id`, which is the space `contacts.agent_id` and `client_gifts.agent_id`
 * both reference (confirmed against the live FKs).
 */
export async function aiPlanBulkGifting(params: {
  /** Ignored — derived from the session. */
  agentId?: string
  occasion: "holiday" | "client_appreciation" | "anniversary_batch"
  totalBudget: number
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.agentId) {
    return { success: false, error: "Not authenticated" }
  }

  const supabase = await createClient()

  try {
    // Get all eligible contacts
    //
    // AMBIGUOUS EMBED — the `!constraint` hint is load-bearing. `transactions` has
    // THREE FKs to `contacts` (contact_id / buyer_contact_id / seller_contact_id);
    // without naming one, PostgREST rejects the request with PGRST201 and the whole
    // sphere reads as empty. `contact_id` is the party this agent represents on the
    // deal, which is exactly who a gifting round is aimed at.
    const { data: contacts, error: contactsError } = await supabase
      .from("contacts")
      .select(`
        id, first_name, last_name, contact_type,
        transactions!transactions_contact_id_fkey(purchase_price, close_date)
      `)
      .eq("agent_id", ctx.agentId)
      .in("contact_type", [...SPHERE_CONTACT_TYPES])

    // Fail CLOSED. supabase-js RESOLVES a refused query, so without this a rejected
    // read is indistinguishable from "this agent has nobody to gift" — and the
    // action would cheerfully return an empty plan instead of an error.
    if (contactsError) {
      return { success: false, error: `Could not read the gifting sphere: ${contactsError.message}` }
    }

    if (!contacts || contacts.length === 0) {
      return { success: true, data: { tiers: [], totalRecipients: 0 } }
    }

    const { object: plan } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        tiers: z.array(z.object({
          tierName: z.string(),
          budgetPerPerson: z.number(),
          recipientCount: z.number(),
          giftRecommendation: z.string(),
          criteria: z.string(),
          contactIds: z.array(z.string()),
        })),
        totalRecipients: z.number(),
        totalSpend: z.number(),
        savingsFromBulk: z.number(),
        timeline: z.array(z.object({
          week: z.string(),
          action: z.string(),
        })),
        vendorRecommendations: z.array(z.object({
          vendor: z.string(),
          forTier: z.string(),
          bulkDiscount: z.string(),
        })),
      }),
      prompt: `Plan bulk gifting for ${params.occasion}:

Total budget: $${params.totalBudget}
Number of contacts: ${contacts.length}

Contacts by value:
${contacts.map(c => {
  const txValue = c.transactions?.[0]?.purchase_price || 0
  return `- ${c.first_name} ${c.last_name}: ${c.contact_type}, $${txValue.toLocaleString()}`
}).join("\n")}

Create a tiered gifting strategy:
1. Segment contacts into 3-4 tiers based on value/relationship
2. Allocate budget appropriately
3. Recommend specific gifts for each tier
4. Identify bulk ordering opportunities
5. Create timeline for execution`,
    })

    return { success: true, data: plan }
  } catch (error) {
    return handleError(error, "aiPlanBulkGifting")
  }
}

// ============================================================================
// GIFT ORDER MANAGEMENT
// ============================================================================

/**
 * Record a gift order.
 *
 * WAVE 6 — **this never wrote a row.** `client_gifts.brokerage_id` is NOT NULL
 * with no default (verified live), and the insert omitted it entirely, so every
 * order died on a NOT NULL violation. Because the result was destructured as
 * `const { data: gift }` with no `error`, supabase-js resolved the rejection and
 * the action returned `{ success: true, data: null }` — the gifting panel showed
 * a confirmed order and nothing existed. That is why `getGiftAnalytics` had no
 * data to be right or wrong about, and it is the same `activities.brokerage_id`
 * class from Lesson 8, in the money lane.
 *
 * The tenant and the agent now come from the SESSION, not from the caller — this
 * is a `"use server"` export, so `agentId` was a caller-asserted identity on an
 * insert. `agentId` is retained and ignored per the house pattern so existing
 * call sites keep type-checking.
 */
export async function createGiftOrder(params: {
  /** Ignored — derived from the session. */
  agentId?: string
  contactId: string
  giftDetails: {
    name: string
    description: string
    cost: number
    vendor: string
    occasion: string
    personalNote?: string
  }
  deliveryAddress?: string
  deliveryDate?: string
}) {
  if (!isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.agentId || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  const supabase = await createClient()

  try {
    const { data: gift, error } = await supabase
      .from("client_gifts")
      .insert({
        // NOT NULL, no default — omitting this is what killed every write.
        brokerage_id:         ctx.brokerageId,
        // agents.id (contacts.agent_id and client_gifts.agent_id both FK agents(id)).
        agent_id:             ctx.agentId,
        contact_id:           params.contactId,
        gift_type:            params.giftDetails.name,
        gift_name:            params.giftDetails.name,
        gift_description:     params.giftDetails.description,
        estimated_cost:       params.giftDetails.cost,
        vendor_name:          params.giftDetails.vendor,
        occasion:             params.giftDetails.occasion,
        personalization_note: params.giftDetails.personalNote ?? null,
        delivery_address:     params.deliveryAddress ?? null,
        scheduled_delivery:   params.deliveryDate ?? null,
        status:               "pending",
      })
      .select()
      .maybeSingle()

    // PROVEN, not assumed. A rejected insert resolves — it does not throw — so
    // without this the caller is told the gift was ordered when it was not.
    if (error) return { success: false, error: error.message }
    if (!gift)  return { success: false, error: "The gift order was not recorded" }

    revalidatePath("/gifts")
    return { success: true, data: gift }
  } catch (error) {
    return handleError(error, "createGiftOrder")
  }
}

// ============================================================================
// AI THANK YOU NOTE GENERATOR
// ============================================================================

export async function aiGenerateThankYouNote(params: {
  agentId: string
  contactId: string
  occasion: string
  giftDescription?: string
  handwritten?: boolean
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // AMBIGUOUS EMBED — keep the `!constraint` hint. THREE FKs join `transactions`
    // to `contacts`; a bare embed is PGRST201 and the note would render "Property:
    // N/A" for every client. `contact_id` is our client on the deal — the person the
    // thank-you note is addressed to — so it is the slot that always holds them,
    // unlike buyer_contact_id / seller_contact_id which are side-specific.
    const { data: contact, error: contactErr } = await supabase
      .from("contacts")
      .select(`*, transactions!transactions_contact_id_fkey(property_address, close_date)`)
      .eq("id", params.contactId)
      .maybeSingle()

    const { data: agent } = await supabase
      .from("agents")
      .select("users(first_name, last_name)")
      .eq("id", params.agentId)
      .maybeSingle()

    if (contactErr) {
      return { success: false, error: contactErr.message }
    }
    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    const { object: note } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        note: z.string(),
        shortVersion: z.string(),
        cardFront: z.string().optional(),
        signOff: z.string(),
      }),
      prompt: `Write a ${params.handwritten ? "handwritten-style" : "typed"} thank you note:

From: ${(agent?.users as any)?.first_name} ${(agent?.users as any)?.last_name}
To: ${contact.first_name} ${contact.last_name}
Occasion: ${params.occasion}
${params.giftDescription ? `Gift being sent: ${params.giftDescription}` : ""}
Property: ${contact.transactions?.[0]?.property_address || "N/A"}

Guidelines:
${params.handwritten ? `
- Keep it personal and warm
- 3-5 sentences max (fits on a card)
- Reference something specific about them
- Avoid generic phrases
` : `
- Can be slightly longer
- Still personal and genuine
- Professional yet warm
`}

Generate the note and a shorter version for cards.`,
    })

    return { success: true, data: note }
  } catch (error) {
    return handleError(error, "aiGenerateThankYouNote")
  }
}

// ============================================================================
// GIFT TRACKING & ANALYTICS
// ============================================================================

/**
 * Gift spend + ROI for the year.
 *
 * Scope comes from the session, not the caller: this returns what an agent spent
 * on whom — gift costs joined to `contacts(first_name, last_name)` — and it ran
 * with no auth gate on a caller-supplied agents.id, so one uuid read another
 * agent's client list and their gifting budget.
 *
 * WAVE 6 — this function had never once returned a real number. Four defects,
 * all confirmed against the live schema (`information_schema.columns` on
 * `client_gifts` / `referrals`, project hrvaqgvukzxfskkcrwbt):
 *
 *  1. **It read columns that do not exist.** `client_gifts` has NO `cost` column
 *     and NO `vendor` column — the money is in `actual_cost` / `estimated_cost`
 *     and the supplier is `vendor_name`. `g.cost` was `undefined` on every row,
 *     so `totalSpent` was **always 0**, `byOccasion` was all zeros, and
 *     `topVendors` labelled every gift `"Unknown"`. The one writer in this file
 *     (`createGiftOrder`) has always written `estimated_cost` / `vendor_name`,
 *     so reader and writer never agreed.
 *  2. **Divide-by-zero shipped as a headline metric.** With `totalSpent` pinned
 *     at 0, `(referralCount * 8000) / 0 * 100` is `Infinity` (or `NaN` at zero
 *     referrals), and `.toFixed(0)` renders that verbatim — the endpoint returned
 *     `estimatedROI: "Infinity%"`.
 *  3. **The ROI was built on a hardcoded $8,000 "average commission".** That is
 *     fabricated money. `referrals.commission_amount` is a real column; the
 *     attributed commission is now summed from actual rows, and when no closed
 *     referral carries an amount the metric is reported as unavailable rather
 *     than invented.
 *  4. **The referral join was backwards.** "Referrals from gifted clients" means
 *     the gifted client is the REFERRER, which is `referrals.referrer_contact_id`
 *     (the FK `lib/kernel/referral-appreciation.ts` and
 *     `app/actions/referrals/referral-appreciation.ts` populate, and the one
 *     `ai-sphere-management.ts` embeds). It filtered on `referred_contact_id`,
 *     i.e. referrals whose *newly introduced* contact happened to have been
 *     gifted — a different, mostly-empty set.
 *
 * Also: `const { data }` with no `error` destructure meant a REFUSED read
 * returned `{ success: true, totalSpent: 0 }` — "your gifting spend is $0" is
 * indistinguishable from "the query failed" (Lesson 5). Both reads now fail closed.
 */
export async function getGiftAnalytics(params?: { agentId?: string; year?: number }) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.agentId) {
    return { success: false, error: "Not authenticated" }
  }

  const supabase = await createClient()
  const year = params?.year || new Date().getFullYear()

  try {
    // Half-open interval. `.lte(created_at, "<year>-12-31")` compared a timestamptz
    // against midnight, so every gift recorded during 31 December fell outside the
    // year it belongs to.
    const yearStart = `${year}-01-01T00:00:00.000Z`
    const nextYearStart = `${year + 1}-01-01T00:00:00.000Z`

    const { data: gifts, error: giftsError } = await supabase
      .from("client_gifts")
      .select(`
        id, contact_id, occasion, actual_cost, estimated_cost, vendor_name, status,
        contacts(first_name, last_name)
      `)
      .eq("agent_id", ctx.agentId)
      .gte("created_at", yearStart)
      .lt("created_at", nextYearStart)

    // Fail CLOSED. A refused read must never be rendered as "you spent nothing".
    if (giftsError) {
      return { success: false, error: `Could not read gift history: ${giftsError.message}` }
    }

    const giftRows = (gifts ?? []) as Array<{
      id: string
      contact_id: string | null
      occasion: string | null
      actual_cost: number | null
      estimated_cost: number | null
      vendor_name: string | null
    }>

    if (giftRows.length === 0) {
      return {
        success: true,
        data: {
          totalSpent: 0,
          giftCount: 0,
          byOccasion: {} as Record<string, number>,
          uniqueRecipients: 0,
          referralsFromGiftedClients: 0,
          attributedCommission: 0,
          estimatedROI: null as string | null,
          averageGiftValue: 0,
          topVendors: [] as Array<[string, number]>,
        },
      }
    }

    // `actual_cost` is what was really paid; `estimated_cost` is the quote the
    // recommendation produced. Prefer the former and fall back to the latter, so
    // a gift ordered but not yet invoiced still counts toward the budget.
    const costOf = (g: { actual_cost: number | null; estimated_cost: number | null }) =>
      Number(g.actual_cost ?? g.estimated_cost ?? 0) || 0

    const totalSpent = giftRows.reduce((sum, g) => sum + costOf(g), 0)
    const byOccasion = giftRows.reduce((acc, g) => {
      const key = g.occasion ?? "unspecified"
      acc[key] = (acc[key] || 0) + costOf(g)
      return acc
    }, {} as Record<string, number>)

    const giftedContactIds = [...new Set(giftRows.map((g) => g.contact_id).filter((id): id is string => !!id))]

    // `.in()` with an empty array is a query for nothing — skip it rather than
    // sending a degenerate filter.
    let referralCount = 0
    let attributedCommission = 0
    if (giftedContactIds.length > 0) {
      const { data: referralsFromGifted, error: referralsError } = await supabase
        .from("referrals")
        .select("id, commission_amount")
        // The GIFTED client is the referrer. See defect (4) above.
        .in("referrer_contact_id", giftedContactIds)
        .gte("created_at", yearStart)
        .lt("created_at", nextYearStart)

      if (referralsError) {
        return { success: false, error: `Could not read referral attribution: ${referralsError.message}` }
      }

      const referralRows = (referralsFromGifted ?? []) as Array<{ commission_amount: number | null }>
      referralCount = referralRows.length
      attributedCommission = referralRows.reduce((sum, r) => sum + (Number(r.commission_amount ?? 0) || 0), 0)
    }

    // ROI only exists when both sides are real money. No spend, or no recorded
    // commission on the attributed referrals, means the number is UNKNOWN — which
    // is reported as null, not as a fabricated or infinite percentage.
    const estimatedROI =
      totalSpent > 0 && attributedCommission > 0
        ? `${Math.round((attributedCommission / totalSpent) * 100)}%`
        : null

    return {
      success: true,
      data: {
        totalSpent,
        giftCount: giftRows.length,
        byOccasion,
        uniqueRecipients: giftedContactIds.length,
        referralsFromGiftedClients: referralCount,
        /** Sum of `referrals.commission_amount` on referrals from gifted clients. Real rows only. */
        attributedCommission,
        /** null when spend or attributed commission is zero — never "Infinity%". */
        estimatedROI,
        averageGiftValue: totalSpent / giftRows.length,
        topVendors: (Object.entries(
          giftRows.reduce((acc, g) => {
            const vendor = g.vendor_name?.trim() || "Unknown"
            acc[vendor] = (acc[vendor] || 0) + 1
            return acc
          }, {} as Record<string, number>)
        ) as Array<[string, number]>).sort((a, b) => b[1] - a[1]).slice(0, 5),
      },
    }
  } catch (error) {
    return handleError(error, "getGiftAnalytics")
  }
}

// ============================================================================
// VENDOR MANAGEMENT
// ============================================================================

export async function getVendors(params?: { agentId?: string; category?: string }) {
  try {
    const supabase = await createClient()
    
    let query = supabase
      .from("gift_vendors")
      .select("*")
      .order("name", { ascending: true })

    if (params?.agentId) query = query.eq("agent_id", params.agentId)
    if (params?.category) query = query.eq("category", params.category)

    const { data, error } = await query

    if (error) throw error
    return { success: true, vendors: data || [] }
  } catch (error) {
    return handleError(error, "getVendors")
  }
}

export async function createVendor(params: {
  agentId: string
  name: string
  category: string
  contactName?: string
  email?: string
  phone?: string
  website?: string
  notes?: string
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("gift_vendors")
      .insert({
        agent_id: params.agentId,
        name: params.name,
        category: params.category,
        contact_name: params.contactName,
        email: params.email,
        phone: params.phone,
        website: params.website,
        notes: params.notes,
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath("/settings")
    return { success: true, vendor: data }
  } catch (error) {
    return handleError(error, "createVendor")
  }
}
