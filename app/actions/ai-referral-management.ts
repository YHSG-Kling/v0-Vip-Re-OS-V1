"use server"

import { createClient } from "@/lib/supabase/server"
import { bestEffort } from "@/lib/db/best-effort"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"
import { SPHERE_CONTACT_TYPES } from "@/lib/contact-types"

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

    // Get past clients and high-engagement contacts.
    //
    // `interactions(*)` embedded a table that DOES NOT EXIST in the live database
    // (information_schema has no public.interactions, and `interactions` is not an FK
    // column on contacts either) — PostgREST rejects the WHOLE query when a select
    // names an unknown relation, so this read failed on every call and, with `error`
    // undestructured, every caller got `contacts: null` and rendered "no candidates".
    // The real per-contact activity log is `activities` (activities.contact_id → contacts.id).
    //
    // `transactions` and `referrals` each have MORE THAN ONE foreign key to contacts
    // (transactions: contact_id/buyer_contact_id/seller_contact_id; referrals:
    // referrer_contact_id/referred_contact_id), so the bare embeds were ambiguous and
    // failed too. Both are now named by their constraint, which picks the side we mean:
    // the deals this contact is the client on, and the referrals this contact GAVE.
    //
    // Columns are named explicitly, never `*` inside an embed — a wildcard embed hides
    // drift from the schema guard (defect #214).
    const { data: contacts, error: contactsError } = await supabase
      .from("contacts")
      .select(`
        *,
        transactions!transactions_contact_id_fkey(id, close_date, purchase_price),
        activities(id, created_at),
        referrals!referrals_referrer_contact_id_fkey(id)
      `)
      .eq("agent_id", agentId)
      .in("contact_type", [...SPHERE_CONTACT_TYPES])
      .order("last_contacted_at", { ascending: false })
      .limit(100)

    if (contactsError) {
      console.error("[identifyReferralOpportunities] contacts read failed:", contactsError.message)
      return { success: false, error: contactsError.message }
    }

    if (!contacts || contacts.length === 0) {
      return { success: true, opportunities: [], message: "No eligible contacts found" }
    }

    // Embedded rows come back unordered; pick the most recent deal per contact here
    // rather than trusting `[0]`.
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
    const enriched = contacts.map((c: any) => {
      const deals = (c.transactions ?? []) as Array<{ close_date: string | null; purchase_price: number | null }>
      const lastDeal = deals
        .filter((t) => t.close_date)
        .sort((a, b) => new Date(b.close_date!).getTime() - new Date(a.close_date!).getTime())[0] ?? null
      const recentActivityCount = ((c.activities ?? []) as Array<{ created_at: string | null }>)
        .filter((a) => a.created_at && new Date(a.created_at).getTime() > thirtyDaysAgo).length
      return { contact: c, lastDeal, recentActivityCount }
    })

    const { object: analysis } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
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

${enriched.map(({ contact: c, lastDeal, recentActivityCount }) => `
Contact ID: ${c.id}
Contact: ${c.first_name} ${c.last_name}
Stage: ${c.lifecycle_state || 'Unknown'}
Last Transaction: ${lastDeal?.close_date || 'N/A'}
Transaction Value: $${lastDeal?.purchase_price?.toLocaleString() || 'N/A'}
Activities (30 days): ${recentActivityCount}
Past Referrals Given: ${c.referrals?.length || 0}
Referral Potential: ${c.referral_potential || 'Unknown'}
Engagement Score: ${c.engagement_score ?? 'Unknown'}
`).join('\n---\n')}

Identify:
1. Top 10 referral candidates with scores
2. Segment opportunities by type
3. Outreach priority order
4. Campaign suggestions for different segments`,
    })

    // Update contacts with referral scores
    for (const candidate of analysis.topReferralCandidates) {
      await bestEffort(
        supabase
          .from("contacts")
          .update({
            referral_score: candidate.referralScore,
            referral_approach: candidate.bestApproach,
          })
          .eq("id", candidate.contactId),
        `derived referral score for contact ${candidate.contactId}; the full analysis is returned to the caller regardless and the next run recomputes it — one contact's stamp must not fail the whole batch`,
      )
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

    // BOTH embeds here were ambiguous, so PostgREST refused the WHOLE request with
    // PGRST201 and this action reported "Contact not found" for contacts that exist.
    // Keep the `!constraint` hints — they are the only thing making this query legal.
    //
    //  · `transactions` has THREE FKs to `contacts` (contact_id / buyer_contact_id /
    //    seller_contact_id). `contact_id` is the party WE represent on the deal
    //    (documented on the canonical writer, lib/transactions/offer-bridge.ts:302),
    //    which is what "Transaction History" means for a client we are asking for a
    //    referral. The buyer/seller slots are side mirrors, null on the other side.
    //  · `referrals` has TWO FKs to `contacts` (referrer_contact_id /
    //    referred_contact_id). "Past Referrals" counts what this client HAS GIVEN
    //    us, so the contact is the REFERRER — same ruling as
    //    identifyReferralOpportunities above and getGiftAnalytics in
    //    app/actions/ai-client-gifting.ts. referred_contact_id would count the times
    //    somebody referred THEM, which is a different and mostly-empty number.
    //
    // Columns are named, never `*` inside an embed (defect #214).
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select(`
        first_name, last_name, contact_type, last_contacted_at, brokerage_id,
        transactions!transactions_contact_id_fkey(property_address),
        referrals!referrals_referrer_contact_id_fkey(id)
      `)
      .eq("id", params.contactId)
      .single()

    // Fail CLOSED — supabase-js resolves a refused read, so without this a hard
    // refusal is indistinguishable from a missing contact.
    if (contactError) {
      return { success: false, error: `Could not read that contact: ${contactError.message}` }
    }
    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    const { data: agent } = await supabase
      .from("users")
      .select("first_name, last_name, phone, email")
      .eq("id", params.agentId)
      .single()

    const { text: referralRequest } = await generateText({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      prompt: `Generate a personalized referral request for:

Agent: ${agent?.first_name} ${agent?.last_name}
Client: ${contact.first_name} ${contact.last_name}
Relationship: ${contact.contact_type}
Transaction History: ${contact.transactions?.map((t: any) => t.property_address).join(', ') || 'None'}
Past Referrals: ${contact.referrals?.length || 0}
Last Interaction: ${contact.last_contacted_at}

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

    // Log the referral request. pass 14: referral_requests was a PHANTOM table —
    // the draft rides the canonical activities ledger (brokerage from the contact).
    const { error: referralActivityError } = await supabase.from("activities").insert({
      brokerage_id: contact.brokerage_id,
      contact_id: params.contactId,
      activity_type: "referral_request_draft",
      channel: params.channel,
      title: `Referral ask drafted (${params.channel})`,
      description: referralRequest.slice(0, 2000),
      status: "pending",
      metadata: { ai_generated: true, requested_by: params.agentId },
    })
    // The activities row IS the draft's storage (referral_requests was a phantom
    // table, per the note above). If it was rejected the draft returned below
    // exists only in this response and is gone on the next page load — say so.
    if (referralActivityError) {
      console.error("[generateReferralRequest] referral_request_draft activity REJECTED — the draft was NOT persisted:", referralActivityError.message)
    }

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

    // `referrals` has TWO FKs to `contacts` (referrals_referrer_contact_id_fkey and
    // referrals_referred_contact_id_fkey), so the embed MUST be disambiguated.
    //
    // The old hint was `contacts!referring_contact_id`, and there is no
    // `referring_contact_id` COLUMN on referrals at all — the column is
    // `referrer_contact_id` (verified against information_schema). PostgREST cannot
    // resolve a hint naming a column that does not exist, so it refused the whole
    // request and this action answered "Referral not found" for every referral in
    // the database. Naming the CONSTRAINT rather than a column removes the chance of
    // that typo recurring.
    //
    // referrer_contact_id is the right side: "Referred By" is the person who GAVE us
    // the referral. referred_contact_id is the new introduction — the subject of the
    // nurture, not its source.
    const { data: referral, error: referralError } = await supabase
      .from("referrals")
      .select(`
        *,
        referring_contact:contacts!referrals_referrer_contact_id_fkey(first_name, last_name)
      `)
      .eq("id", params.referralId)
      .single()

    if (referralError) {
      return { success: false, error: `Could not read that referral: ${referralError.message}` }
    }
    if (!referral) {
      return { success: false, error: "Referral not found" }
    }

    // SHAPE: referrals.referrer_contact_id -> contacts is MANY-TO-ONE, so this
    // embed is an OBJECT at runtime. supabase-js widens a hinted embed to an
    // array whichever way the relationship points, so this normalizes rather
    // than asserting — an assertion would be a lie in whichever direction it
    // turned out to be wrong.
    const referrerEmbed = referral.referring_contact as unknown
    const referrer = (Array.isArray(referrerEmbed) ? referrerEmbed[0] : referrerEmbed) as
      { first_name?: string | null; last_name?: string | null } | null | undefined

    const { object: nurtureStrategy } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
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

Referral: ${referral.referral_name || 'Unnamed referral'}
Status: ${referral.status}
Referred By: ${referrer?.first_name} ${referrer?.last_name}
Potential Value: $${referral.value_estimate?.toLocaleString() || 'Unknown'}
Source: ${referral.referral_source || 'Unknown'}
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

    // referrals has no ai_conversion_probability/ai_next_action/ai_nurture_strategy
    // columns (and no jsonb to fold into) — the strategy is returned to the caller
    // intact below, so nothing is persisted to a phantom column.
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

    // THREE separate defects lived in the select this replaces, any ONE of which
    // killed the entire read (PostgREST refuses the whole request, and with `error`
    // undestructured every caller saw "Referral not found"):
    //
    //  1. `contacts!referring_contact_id` named a COLUMN that does not exist.
    //     referrals has `referrer_contact_id`, not `referring_contact_id`. Named by
    //     CONSTRAINT now. referrals→contacts carries TWO FKs
    //     (referrer_contact_id / referred_contact_id) so the hint is mandatory, and
    //     the referrer is the party being rewarded — that is the whole point of this
    //     function — so referrer_contact_id is the one we mean.
    //  2. `transactions(*)` was embedded on `referrals`, and there is NO foreign key
    //     between those two tables in either direction (checked against
    //     pg_constraint). PostgREST cannot build that join at all. Removed.
    //  3. The prompt read `referral.referring_contact.transactions` and
    //     `referral.referring_contact.referrals` — NESTED under the contact — but the
    //     select asked for `transactions` as a SIBLING of the contact. Even had (1)
    //     and (2) not refused the query, both values would have been undefined. They
    //     are now nested where the prompt actually looks for them.
    //
    // The nested embeds need their own hints for the same reason: transactions→contacts
    // is 3 FKs and referrals→contacts is 2. `contact_id` is the deal the referrer was
    // OUR client on (that is the relationship being thanked), and `referrer_contact_id`
    // counts referrals this person has GIVEN.
    const { data: referral, error: referralError } = await supabase
      .from("referrals")
      .select(`
        status, value_estimate,
        referring_contact:contacts!referrals_referrer_contact_id_fkey(
          first_name, last_name,
          transactions!transactions_contact_id_fkey(purchase_price, close_date),
          referrals!referrals_referrer_contact_id_fkey(id)
        )
      `)
      .eq("id", params.referralId)
      .single()

    if (referralError) {
      return { success: false, error: `Could not read that referral: ${referralError.message}` }
    }
    if (!referral) {
      return { success: false, error: "Referral not found" }
    }

    // SHAPE: the top-level embed is MANY-TO-ONE (referrals.referrer_contact_id ->
    // contacts), so it is an OBJECT at runtime even though supabase-js widens a
    // hinted embed to an array. The two embeds NESTED inside it point the other
    // way — contacts is the parent of both — so those genuinely ARE arrays, which
    // is why the [0] and .length reads below are right.
    const referrerEmbed = referral.referring_contact as unknown
    const referrer = (Array.isArray(referrerEmbed) ? referrerEmbed[0] : referrerEmbed) as
      | {
          first_name?: string | null
          last_name?: string | null
          transactions?: Array<{ purchase_price?: number | null; close_date?: string | null }>
          referrals?: Array<{ id: string }>
        }
      | null
      | undefined

    const { object: rewardRecommendation } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
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

Referrer: ${referrer?.first_name} ${referrer?.last_name}
Referrer's Transaction Value: $${referrer?.transactions?.[0]?.purchase_price?.toLocaleString() || 'Unknown'}
Referral Value: $${referral.value_estimate?.toLocaleString() || 'Unknown'}
Referral Status: ${referral.status}
Previous Referrals From This Contact: ${referrer?.referrals?.length || 0}

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
/**
 * @param requestedAgentId IGNORED for scoping — kept only so existing call
 *        shapes still compile. The agent is resolved from the SESSION.
 *
 * WHY. This is a "use server" export, so it is a public HTTP endpoint, and it
 * authenticated nothing: it took agentId from the caller, read that agent's
 * referrals joined to FULL contact rows (`referring_contact:contacts!...(*)` —
 * every PII column) plus their transactions, and then billed a claude-sonnet-4
 * call. Anyone could enumerate agent ids to pull another brokerage's referral
 * book and charge the platform's AI budget to do it.
 *
 * A caller-supplied actor id on a server action is the defect this whole file's
 * neighbours were remediated for; the param is not honoured rather than removed,
 * so nothing breaks and nothing can pass an identity in either.
 */
export async function analyzeReferralProgram(requestedAgentId?: string) {
  try {
    const { getAgentContext } = await import("@/lib/identity/get-agent-context")
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.agentId) {
      return { success: false, error: "Unauthorized" }
    }
    // Refuse rather than silently analysing someone else's book: a caller that
    // asked for a DIFFERENT agent wanted something it is not entitled to, and
    // quietly returning its own data would hide that.
    if (requestedAgentId && requestedAgentId !== ctx.agentId) {
      return { success: false, error: "Forbidden" }
    }
    const agentId = ctx.agentId
    if (!isValidUUID(agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    // Same two defects as the sites above, in one select. referrals→contacts carries
    // TWO foreign keys (referrals_referrer_contact_id_fkey /
    // referrals_referred_contact_id_fkey) so the embed must be disambiguated, and the
    // old `contacts!referring_contact_id` hint pointed at a column that does not exist
    // on referrals (the real one is `referrer_contact_id`). Either fault alone makes
    // PostgREST refuse the whole request, so this analytic has never seen a referral.
    //
    // The referrer is the right party: a referral PROGRAM is measured by who is
    // sending business in. Named by constraint so the column typo cannot come back,
    // and narrowed off `*` — the docblock above notes this endpoint was pulling every
    // PII column on the contact, which it never needed.
    const { data: referrals, error: referralsError } = await supabase
      .from("referrals")
      .select(`
        status, referral_name, value_estimate,
        referring_contact:contacts!referrals_referrer_contact_id_fkey(first_name, last_name)
      `)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })

    if (referralsError) {
      return { success: false, error: `Could not read the referral book: ${referralsError.message}` }
    }

    const { data: transactions, error: referralTxError } = await supabase
      .from("transactions")
      .select("purchase_price")
      .eq("agent_id", agentId)
      .eq("source", "referral")

    if (referralTxError) {
      return { success: false, error: `Could not read referral transactions: ${referralTxError.message}` }
    }

    const { object: analysis } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
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
${referrals?.map((r: any) => `- ${r.referral_name || 'Unnamed referral'}: ${r.status}, Value: $${r.value_estimate?.toLocaleString() || 'Unknown'}`).join('\n')}

Referral Transactions: ${transactions?.length || 0}
Total Value: $${(transactions ?? []).reduce((sum: number, t: any) => sum + (t.purchase_price || 0), 0).toLocaleString()}

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
