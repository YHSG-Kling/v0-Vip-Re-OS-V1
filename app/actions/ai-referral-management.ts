"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateText, generateObject } from "ai"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"

// ============================================
// AI REFERRAL MANAGEMENT
// Smart referral generation and tracking
// ============================================

/**
 * AI-powered referral opportunity identification
 * Analyzes contacts to find best referral candidates
 */
export async function identifyReferralOpportunities(agentId: string) {
  try {
    if (!isValidUUID(agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    // Get past clients and high-engagement contacts
    const { data: contacts } = await supabase
      .from("contacts")
      .select(`
        *,
        transactions(*),
        interactions(*),
        referrals(*)
      `)
      .eq("agent_id", agentId)
      .in("stage", ["closed", "past_client", "sphere"])
      .order("last_interaction_date", { ascending: false })
      .limit(100)

    if (!contacts || contacts.length === 0) {
      return { success: true, opportunities: [], message: "No eligible contacts found" }
    }

    const { object: analysis } = await generateObject({
      model: "anthropic/claude-sonnet-4-20250514",
      schema: z.object({
        topReferralCandidates: z.array(z.object({
          contactId: z.string(),
          contactName: z.string(),
          referralScore: z.number().min(0).max(100),
          reasoning: z.string(),
          bestApproach: z.string(),
          suggestedTiming: z.string(),
          likelyReferralType: z.enum(["buyer", "seller", "investor", "relocation"]),
          networkStrength: z.enum(["high", "medium", "low"]),
        })),
        segmentedOpportunities: z.object({
          recentClosings: z.array(z.string()),
          highEngagement: z.array(z.string()),
          sphereOfInfluence: z.array(z.string()),
          pastReferrers: z.array(z.string()),
        }),
        outreachPriority: z.array(z.object({
          contactId: z.string(),
          priority: z.number(),
          reason: z.string(),
        })),
        campaignSuggestions: z.array(z.object({
          name: z.string(),
          targetSegment: z.string(),
          approach: z.string(),
          expectedYield: z.number(),
        })),
      }),
      prompt: `Analyze these contacts to identify referral opportunities:

${contacts.map((c: any) => `
Contact: ${c.first_name} ${c.last_name}
Stage: ${c.stage}
Last Transaction: ${c.transactions?.[0]?.actual_close_date || 'N/A'}
Transaction Value: $${c.transactions?.[0]?.purchase_price?.toLocaleString() || 'N/A'}
Interactions (30 days): ${c.interactions?.filter((i: any) => new Date(i.interaction_date) > new Date(Date.now() - 30*24*60*60*1000)).length || 0}
Past Referrals Given: ${c.referrals?.length || 0}
NPS Score: ${c.nps_score || 'Unknown'}
`).join('\n---\n')}

Identify:
1. Top 10 referral candidates with scores
2. Segment opportunities by type
3. Outreach priority order
4. Campaign suggestions for different segments`,
    })

    // Update contacts with referral scores
    for (const candidate of analysis.topReferralCandidates) {
      await supabase
        .from("contacts")
        .update({
          referral_score: candidate.referralScore,
          referral_approach: candidate.bestApproach,
        })
        .eq("id", candidate.contactId)
    }

    return { success: true, analysis }
  } catch (error) {
    return handleError(error, "identifyReferralOpportunities")
  }
}

/**
 * AI-powered referral request generation
 */
export async function generateReferralRequest(params: {
  contactId: string
  agentId: string
  channel: "email" | "text" | "call_script"
  context?: string
}) {
  try {
    const supabase = await createClient()

    const { data: contact } = await supabase
      .from("contacts")
      .select(`
        *,
        transactions(*),
        referrals(*)
      `)
      .eq("id", params.contactId)
      .single()

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    const { data: agent } = await supabase
      .from("users")
      .select("first_name, last_name, phone, email")
      .eq("id", params.agentId)
      .single()

    const { text: referralRequest } = await generateText({
      model: "anthropic/claude-sonnet-4-20250514",
      prompt: `Generate a personalized referral request for:

Agent: ${agent?.first_name} ${agent?.last_name}
Client: ${contact.first_name} ${contact.last_name}
Relationship: ${contact.stage}
Transaction History: ${contact.transactions?.map((t: any) => t.property_address).join(', ') || 'None'}
Past Referrals: ${contact.referrals?.length || 0}
Last Interaction: ${contact.last_interaction_date}

Channel: ${params.channel}
${params.context ? `Context: ${params.context}` : ''}

Generate a ${params.channel === 'call_script' ? 'call script' : params.channel} that:
1. Feels personal and genuine, not salesy
2. References your shared history
3. Makes it easy to refer (specific ask)
4. Offers value in return (market update, etc.)
5. Is appropriate length for ${params.channel}

${params.channel === 'email' ? 'Include subject line.' : ''}
${params.channel === 'text' ? 'Keep under 300 characters.' : ''}
${params.channel === 'call_script' ? 'Include talking points and responses to common objections.' : ''}`,
    })

    // Log the referral request
    await supabase.from("referral_requests").insert({
      contact_id: params.contactId,
      agent_id: params.agentId,
      channel: params.channel,
      message_content: referralRequest,
      ai_generated: true,
      status: "draft",
    })

    return { success: true, referralRequest }
  } catch (error) {
    return handleError(error, "generateReferralRequest")
  }
}

/**
 * AI-powered referral tracking and nurturing
 */
export async function nurturePendingReferral(params: {
  referralId: string
  agentId: string
}) {
  try {
    const supabase = await createClient()

    const { data: referral } = await supabase
      .from("referrals")
      .select(`
        *,
        referring_contact:contacts!referring_contact_id(*)
      `)
      .eq("id", params.referralId)
      .single()

    if (!referral) {
      return { success: false, error: "Referral not found" }
    }

    const { object: nurtureStrategy } = await generateObject({
      model: "anthropic/claude-sonnet-4-20250514",
      schema: z.object({
        currentStage: z.string(),
        nextBestAction: z.object({
          action: z.string(),
          timing: z.string(),
          channel: z.string(),
          message: z.string(),
        }),
        conversionProbability: z.number(),
        recommendedFollowUps: z.array(z.object({
          day: z.number(),
          action: z.string(),
          channel: z.string(),
        })),
        referrerUpdateNeeded: z.boolean(),
        referrerUpdateMessage: z.string().optional(),
        qualificationQuestions: z.array(z.string()),
        objectionHandling: z.array(z.object({
          objection: z.string(),
          response: z.string(),
        })),
      }),
      prompt: `Create nurture strategy for this referral:

Referral: ${referral.referred_name}
Status: ${referral.status}
Referred By: ${referral.referring_contact?.first_name} ${referral.referring_contact?.last_name}
Potential Value: $${referral.potential_value?.toLocaleString() || 'Unknown'}
Source: ${referral.source}
Days Since Referral: ${Math.floor((Date.now() - new Date(referral.created_at).getTime()) / (1000 * 60 * 60 * 24))}
Notes: ${referral.notes || 'None'}

Generate:
1. Assessment of current stage
2. Next best action with specific message
3. Follow-up schedule
4. Qualification questions to ask
5. Common objection responses
6. Whether to update the referrer`,
    })

    // Update referral with AI insights
    await supabase
      .from("referrals")
      .update({
        ai_conversion_probability: nurtureStrategy.conversionProbability,
        ai_next_action: nurtureStrategy.nextBestAction.action,
        ai_nurture_strategy: nurtureStrategy,
      })
      .eq("id", params.referralId)

    return { success: true, nurtureStrategy }
  } catch (error) {
    return handleError(error, "nurturePendingReferral")
  }
}

/**
 * AI-powered referral reward recommendation
 */
export async function recommendReferralReward(params: {
  referralId: string
  agentId: string
}) {
  try {
    const supabase = await createClient()

    const { data: referral } = await supabase
      .from("referrals")
      .select(`
        *,
        referring_contact:contacts!referring_contact_id(*),
        transactions(*)
      `)
      .eq("id", params.referralId)
      .single()

    if (!referral) {
      return { success: false, error: "Referral not found" }
    }

    const { object: rewardRecommendation } = await generateObject({
      model: "anthropic/claude-sonnet-4-20250514",
      schema: z.object({
        recommendedReward: z.object({
          type: z.enum(["gift_card", "cash", "donation", "gift", "experience", "service"]),
          value: z.number(),
          specific: z.string(),
          reasoning: z.string(),
        }),
        alternatives: z.array(z.object({
          type: z.string(),
          value: z.number(),
          description: z.string(),
        })),
        timing: z.object({
          when: z.string(),
          occasion: z.string().optional(),
        }),
        personalizedNote: z.string(),
        taxImplications: z.string(),
        futureRelationshipTips: z.array(z.string()),
      }),
      prompt: `Recommend appropriate referral reward:

Referrer: ${referral.referring_contact?.first_name} ${referral.referring_contact?.last_name}
Referrer's Transaction Value: $${referral.referring_contact?.transactions?.[0]?.purchase_price?.toLocaleString() || 'Unknown'}
Referral Value: $${referral.potential_value?.toLocaleString() || 'Unknown'}
Referral Status: ${referral.status}
Previous Referrals From This Contact: ${referral.referring_contact?.referrals?.length || 0}

Consider:
1. Relationship depth
2. Transaction value
3. State regulations on referral fees
4. Personal preferences if known
5. Tax implications
6. Future relationship building`,
    })

    return { success: true, rewardRecommendation }
  } catch (error) {
    return handleError(error, "recommendReferralReward")
  }
}

/**
 * AI-powered referral program analytics
 */
export async function analyzeReferralProgram(agentId: string) {
  try {
    if (!isValidUUID(agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    const { data: referrals } = await supabase
      .from("referrals")
      .select(`
        *,
        referring_contact:contacts!referring_contact_id(*)
      `)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })

    const { data: transactions } = await supabase
      .from("transactions")
      .select("*")
      .eq("agent_id", agentId)
      .eq("source", "referral")

    const { object: analysis } = await generateObject({
      model: "anthropic/claude-sonnet-4-20250514",
      schema: z.object({
        overallHealth: z.object({
          score: z.number(),
          trend: z.enum(["improving", "stable", "declining"]),
          summary: z.string(),
        }),
        metrics: z.object({
          totalReferrals: z.number(),
          conversionRate: z.number(),
          averageValue: z.number(),
          topReferrers: z.array(z.object({
            name: z.string(),
            referrals: z.number(),
            closedValue: z.number(),
          })),
        }),
        insights: z.array(z.object({
          insight: z.string(),
          impact: z.enum(["high", "medium", "low"]),
          actionable: z.boolean(),
        })),
        recommendations: z.array(z.object({
          recommendation: z.string(),
          expectedImpact: z.string(),
          effort: z.enum(["low", "medium", "high"]),
          priority: z.number(),
        })),
        benchmarkComparison: z.object({
          industryAverage: z.number(),
          yourPerformance: z.number(),
          gap: z.string(),
        }),
      }),
      prompt: `Analyze referral program performance:

Referrals: ${referrals?.length || 0} total
${referrals?.map((r: any) => `- ${r.referred_name}: ${r.status}, Value: $${r.potential_value?.toLocaleString() || 'Unknown'}`).join('\n')}

Referral Transactions: ${transactions?.length || 0}
Total Value: $${transactions?.reduce((sum: number, t: any) => sum + (t.purchase_price || 0), 0).toLocaleString()}

Provide:
1. Overall program health
2. Key metrics
3. Actionable insights
4. Prioritized recommendations
5. Industry benchmark comparison`,
    })

    return { success: true, analysis }
  } catch (error) {
    return handleError(error, "analyzeReferralProgram")
  }
}
