"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"
import { LIFETIME_CUSTOMER_TYPE } from "@/lib/contact-types"

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
    const { data: contact, error: contactErr } = await supabase
      .from("contacts")
      .select(`
        *,
        transactions(purchase_price, close_date)
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

export async function aiPlanBulkGifting(params: {
  agentId: string
  occasion: "holiday" | "client_appreciation" | "anniversary_batch"
  totalBudget: number
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get all eligible contacts
    const { data: contacts } = await supabase
      .from("contacts")
      .select(`
        id, first_name, last_name, contact_type,
        transactions(purchase_price, close_date)
      `)
      .eq("agent_id", params.agentId)
      .in("contact_type", [LIFETIME_CUSTOMER_TYPE, "sphere", "referral_partner"])

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

export async function createGiftOrder(params: {
  agentId: string
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
  if (!isValidUUID(params.agentId) || !isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: gift } = await supabase
      .from("client_gifts")
      .insert({
        agent_id:             params.agentId,
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
      .single()

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
    const { data: contact, error: contactErr } = await supabase
      .from("contacts")
      .select(`*, transactions(property_address, close_date)`)
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

export async function getGiftAnalytics(params: { agentId: string; year?: number }) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()
  const year = params.year || new Date().getFullYear()

  try {
    const { data: gifts } = await supabase
      .from("client_gifts")
      .select(`
        *,
        contacts(first_name, last_name),
        referrals:contacts(referrals!referred_contact_id(id))
      `)
      .eq("agent_id", params.agentId)
      .gte("created_at", `${year}-01-01`)
      .lte("created_at", `${year}-12-31`)

    if (!gifts) {
      return { success: true, data: { totalSpent: 0, giftCount: 0 } }
    }

    const totalSpent = gifts.reduce((sum, g) => sum + (g.cost || 0), 0)
    const byOccasion = gifts.reduce((acc, g) => {
      acc[g.occasion] = (acc[g.occasion] || 0) + (g.cost || 0)
      return acc
    }, {} as Record<string, number>)

    // Calculate ROI (referrals received from gifted clients)
    const giftedContactIds = [...new Set(gifts.map(g => g.contact_id))]
    const { data: referralsFromGifted } = await supabase
      .from("referrals")
      .select("id")
      .in("referred_contact_id", giftedContactIds)
      .gte("created_at", `${year}-01-01`)

    const referralCount = referralsFromGifted?.length || 0
    const avgCommission = 8000 // Estimated average commission
    const estimatedROI = ((referralCount * avgCommission) / totalSpent * 100).toFixed(0)

    return {
      success: true,
      data: {
        totalSpent,
        giftCount: gifts.length,
        byOccasion,
        uniqueRecipients: giftedContactIds.length,
        referralsFromGiftedClients: referralCount,
        estimatedROI: `${estimatedROI}%`,
        averageGiftValue: totalSpent / gifts.length || 0,
        topVendors: (Object.entries(
          gifts.reduce((acc, g) => {
            acc[g.vendor || "Unknown"] = (acc[g.vendor || "Unknown"] || 0) + 1
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
