"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"
import { LIFETIME_CUSTOMER_TYPE } from "@/lib/contact-types"

/**
 * AI Sphere of Influence Management System
 * Handles lifetime customer relationships, engagement scoring, and automated touchpoints
 */

// ============================================================================
// AI ENGAGEMENT SCORING
// ============================================================================

export async function aiScoreSphereEngagement(params: { agentId: string }) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get all contacts in sphere
    const { data: contacts } = await supabase
      .from("contacts")
      .select(`
        *,
        interactions(id, interaction_type, interaction_date, outcome),
        transactions(id, status, close_date)
      `)
      .eq("agent_id", params.agentId)
      .in("contact_type", [LIFETIME_CUSTOMER_TYPE, "sphere", "referral_partner"])

    if (!contacts || contacts.length === 0) {
      return { success: true, data: [] }
    }

    const scoredContacts = await Promise.all(
      contacts.map(async (contact) => {
        const lastInteraction = contact.interactions?.[0]?.interaction_date
        const daysSinceContact = lastInteraction
          ? Math.floor((Date.now() - new Date(lastInteraction).getTime()) / (1000 * 60 * 60 * 24))
          : 999

        const totalTransactions = contact.transactions?.length || 0
        const totalInteractions = contact.interactions?.length || 0

        // AI-enhanced scoring
        const { object: scoring } = await generateObject({
          model: "openai/gpt-4o-mini",
          schema: z.object({
            engagementScore: z.number().min(0).max(100),
            referralPotential: z.enum(["high", "medium", "low"]),
            riskLevel: z.enum(["at_risk", "cooling", "engaged", "champion"]),
            recommendedAction: z.string(),
            nextTouchpointType: z.enum(["call", "email", "text", "gift", "event_invite", "market_update"]),
            urgency: z.enum(["immediate", "this_week", "this_month", "quarterly"]),
          }),
          prompt: `Analyze this contact's engagement and provide scoring:
            
Contact: ${contact.first_name} ${contact.last_name}
Type: ${contact.contact_type}
Days since last contact: ${daysSinceContact}
Total transactions with us: ${totalTransactions}
Total interactions logged: ${totalInteractions}
Home purchase/sale anniversary: ${contact.home_anniversary || "Unknown"}
Birthday: ${contact.birthday || "Unknown"}
Last interaction type: ${contact.interactions?.[0]?.interaction_type || "None"}

Provide engagement score (0-100), referral potential, risk level, and recommended next action.`,
        })

        return {
          contactId: contact.id,
          name: `${contact.first_name} ${contact.last_name}`,
          email: contact.email,
          phone: contact.phone,
          contactType: contact.contact_type,
          daysSinceContact,
          ...scoring,
        }
      })
    )

    // Sort by urgency and risk
    const prioritized = scoredContacts.sort((a, b) => {
      const urgencyOrder = { immediate: 0, this_week: 1, this_month: 2, quarterly: 3 }
      return urgencyOrder[a.urgency] - urgencyOrder[b.urgency]
    })

    return { success: true, data: prioritized }
  } catch (error) {
    return handleError(error, "aiScoreSphereEngagement")
  }
}

// ============================================================================
// AI TOUCHPOINT GENERATION
// ============================================================================

export async function aiGenerateTouchpoint(params: {
  agentId: string
  contactId: string
  touchpointType: "anniversary" | "birthday" | "check_in" | "market_update" | "holiday" | "referral_ask"
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Get contact details
    const { data: contact } = await supabase
      .from("contacts")
      .select(`
        *,
        transactions(property_address, close_date, purchase_price),
        interactions(interaction_type, notes, interaction_date)
      `)
      .eq("id", params.contactId)
      .single()

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // Get agent's brand voice
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", params.agentId)
      .maybeSingle()

    const lastTransaction = contact.transactions?.[0]

    const { object: touchpoint } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        subject: z.string(),
        message: z.string(),
        callScript: z.string().optional(),
        textMessage: z.string().optional(),
        giftSuggestion: z.object({
          item: z.string(),
          estimatedCost: z.number(),
          reason: z.string(),
        }).optional(),
        personalizedDetails: z.array(z.string()),
      }),
      prompt: `Generate a personalized ${params.touchpointType} touchpoint for this lifetime customer:

Contact: ${contact.first_name} ${contact.last_name}
Relationship: ${contact.contact_type}
Last property: ${lastTransaction?.property_address || "Unknown"}
Close date: ${lastTransaction?.close_date || "Unknown"}
Interests/Notes: ${contact.notes || "None recorded"}
Recent interactions: ${JSON.stringify(contact.interactions?.slice(0, 3) || [])}

Brand voice: ${brandVoice?.tone || "Professional yet warm"}
Agent specialty: ${brandVoice?.specialties || "Residential real estate"}

Generate:
1. Email subject and message
2. Optional call script (if personal call appropriate)
3. Text message version (keep under 160 chars)
4. Gift suggestion if appropriate for ${params.touchpointType}
5. 3-5 personalized details to reference`,
    })

    // Save the touchpoint — use schema-correct columns only.
    // scheduled_touchpoints uses message_template (text) not content (jsonb).
    const { data: savedTouchpoint } = await supabase
      .from("scheduled_touchpoints")
      .insert({
        agent_id:         params.agentId,
        contact_id:       params.contactId,
        touchpoint_type:  params.touchpointType,
        message_template: JSON.stringify(touchpoint),
        status:           "scheduled",
        ai_generated:     true,
      })
      .select()
      .single()

    revalidatePath("/sphere")
    return { success: true, data: touchpoint, touchpointId: savedTouchpoint?.id }
  } catch (error) {
    return handleError(error, "aiGenerateTouchpoint")
  }
}

// ============================================================================
// AI REFERRAL ASK OPTIMIZATION
// ============================================================================

export async function aiOptimizeReferralAsk(params: {
  agentId: string
  contactId: string
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Load contact — load referrals separately to avoid FK name guessing
    const { data: contact } = await supabase
      .from("contacts")
      .select("*, transactions(close_date, purchase_price)")
      .eq("id", params.contactId)
      .single()

    const { data: referrals } = await supabase
      .from("referrals")
      .select("id, status")
      .eq("referred_contact_id", params.contactId)

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    const pastReferrals = referrals?.length || 0
    const transactionValue = contact.transactions?.[0]?.purchase_price || 0

    const { object: referralStrategy } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        readinessScore: z.number().min(0).max(100),
        bestChannel: z.enum(["in_person", "phone", "email", "text"]),
        bestTiming: z.string(),
        askScript: z.string(),
        incentiveRecommendation: z.object({
          type: z.string(),
          value: z.string(),
          reason: z.string(),
        }),
        followUpPlan: z.array(z.object({
          day: z.number(),
          action: z.string(),
          message: z.string(),
        })),
        objectionHandling: z.array(z.object({
          objection: z.string(),
          response: z.string(),
        })),
      }),
      prompt: `Analyze this client's readiness for a referral ask and create an optimized strategy:

Client: ${contact.first_name} ${contact.last_name}
Transaction value: $${transactionValue.toLocaleString()}
Time since close: ${contact.transactions?.[0]?.close_date ? Math.floor((Date.now() - new Date(contact.transactions[0].close_date).getTime()) / (1000 * 60 * 60 * 24)) : "Unknown"} days
Past referrals given: ${pastReferrals}
Satisfaction indicators: ${contact.notes || "Not recorded"}

Generate:
1. Referral readiness score (0-100)
2. Best channel and timing for the ask
3. Natural, non-pushy referral ask script
4. Incentive recommendation (gift card, donation, etc.)
5. Follow-up plan if they say "let me think about it"
6. Common objection handling responses`,
    })

    return { success: true, data: referralStrategy }
  } catch (error) {
    return handleError(error, "aiOptimizeReferralAsk")
  }
}

// ============================================================================
// AI ANNIVERSARY/MILESTONE TRACKING
// ============================================================================

export async function aiGetUpcomingMilestones(params: {
  agentId: string
  daysAhead?: number
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()
  const daysAhead = params.daysAhead || 30

  try {
    // Get contacts with birthdays and anniversaries
    const { data: contacts } = await supabase
      .from("contacts")
      .select(`
        id, first_name, last_name, email, phone,
        birthday, home_anniversary,
        transactions(close_date, property_address)
      `)
      .eq("agent_id", params.agentId)

    if (!contacts) {
      return { success: true, data: [] }
    }

    const today = new Date()
    const milestones: Array<{
      contactId: string
      name: string
      type: "birthday" | "home_anniversary" | "transaction_anniversary"
      date: string
      daysUntil: number
      yearsCount?: number
      property?: string
    }> = []

    for (const contact of contacts) {
      // Check birthday
      if (contact.birthday) {
        const birthday = new Date(contact.birthday)
        const thisYearBirthday = new Date(today.getFullYear(), birthday.getMonth(), birthday.getDate())
        if (thisYearBirthday < today) {
          thisYearBirthday.setFullYear(today.getFullYear() + 1)
        }
        const daysUntil = Math.floor((thisYearBirthday.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        
        if (daysUntil <= daysAhead) {
          milestones.push({
            contactId: contact.id,
            name: `${contact.first_name} ${contact.last_name}`,
            type: "birthday",
            date: thisYearBirthday.toISOString(),
            daysUntil,
          })
        }
      }

      // Check home anniversary (from transactions)
      for (const tx of contact.transactions || []) {
        if (tx.close_date) {
          const closeDate = new Date(tx.close_date)
          const thisYearAnniversary = new Date(today.getFullYear(), closeDate.getMonth(), closeDate.getDate())
          if (thisYearAnniversary < today) {
            thisYearAnniversary.setFullYear(today.getFullYear() + 1)
          }
          const daysUntil = Math.floor((thisYearAnniversary.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
          const yearsCount = today.getFullYear() - closeDate.getFullYear()

          if (daysUntil <= daysAhead) {
            milestones.push({
              contactId: contact.id,
              name: `${contact.first_name} ${contact.last_name}`,
              type: "transaction_anniversary",
              date: thisYearAnniversary.toISOString(),
              daysUntil,
              yearsCount,
              property: tx.property_address,
            })
          }
        }
      }
    }

    // Sort by days until
    milestones.sort((a, b) => a.daysUntil - b.daysUntil)

    return { success: true, data: milestones }
  } catch (error) {
    return handleError(error, "aiGetUpcomingMilestones")
  }
}

// ============================================================================
// AI CLIENT SEGMENTATION
// ============================================================================

export async function aiSegmentSphere(params: { agentId: string }) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { data: contacts } = await supabase
      .from("contacts")
      .select(`
        *,
        transactions(purchase_price, close_date),
        referrals:referrals!referrer_contact_id(id)
      `)
      .eq("agent_id", params.agentId)
      .in("contact_type", [LIFETIME_CUSTOMER_TYPE, "sphere", "referral_partner"])

    if (!contacts || contacts.length === 0) {
      return { success: true, data: { segments: [] } }
    }

    const { object: segmentation } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        segments: z.array(z.object({
          name: z.string(),
          description: z.string(),
          contactIds: z.array(z.string()),
          recommendedCadence: z.string(),
          recommendedContent: z.array(z.string()),
          priority: z.enum(["high", "medium", "low"]),
        })),
        insights: z.array(z.string()),
        recommendations: z.array(z.string()),
      }),
      prompt: `Segment this sphere of influence for targeted marketing:

Contacts:
${contacts.map(c => `- ${c.first_name} ${c.last_name}: ${c.contact_type}, ${c.transactions?.length || 0} transactions, ${c.referrals?.length || 0} referrals, avg price: $${(c.transactions?.[0]?.purchase_price || 0).toLocaleString()}`).join("\n")}

Create strategic segments based on:
1. Transaction history and value
2. Referral activity
3. Engagement level
4. Property type preferences
5. Geographic location

For each segment provide:
- Descriptive name
- Recommended contact cadence
- Content types that would resonate
- Priority level`,
    })

    return { success: true, data: segmentation }
  } catch (error) {
    return handleError(error, "aiSegmentSphere")
  }
}

// ============================================================================
// AI EVENT INVITATION GENERATOR
// ============================================================================

export async function aiGenerateEventInvitation(params: {
  agentId: string
  eventType: "client_appreciation" | "market_update" | "holiday_party" | "educational_seminar" | "open_house_vip"
  eventDetails: {
    title: string
    date: string
    location: string
    description?: string
  }
  targetSegment?: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { data: agent } = await supabase
      .from("agents")
      .select("id, users(first_name, last_name)")
      .eq("id", params.agentId)
      .single()
    // Agent identity lives on the joined users row (agents.user_id → users), NOT on agents — selecting
    // first_name/last_name off agents directly errors the query (silent null), so the host was blank.
    const u = (agent?.users ?? null) as { first_name?: string; last_name?: string } | null
    const hostName = `${u?.first_name ?? ""} ${u?.last_name ?? ""}`.trim() || "your agent"

    const { object: invitation } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        emailSubject: z.string(),
        emailBody: z.string(),
        textInvite: z.string(),
        socialPost: z.string(),
        rsvpFollowUp: z.object({
          yesResponse: z.string(),
          noResponse: z.string(),
          noReplyFollowUp: z.string(),
        }),
        eventHashtag: z.string(),
      }),
      prompt: `Create invitation content for this client event:

Event: ${params.eventDetails.title}
Type: ${params.eventType}
Date: ${params.eventDetails.date}
Location: ${params.eventDetails.location}
Description: ${params.eventDetails.description || ""}
Host: ${hostName}
Target audience: ${params.targetSegment || "All lifetime customers and sphere"}

Generate:
1. Email invitation with compelling subject line
2. Short text message invite (under 160 chars)
3. Social media announcement post
4. RSVP follow-up messages for yes/no/no-reply
5. Event hashtag`,
    })

    return { success: true, data: invitation }
  } catch (error) {
    return handleError(error, "aiGenerateEventInvitation")
  }
}
