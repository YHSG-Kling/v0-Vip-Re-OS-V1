"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"

// ============================================================================
// AI LEAD NURTURING SYSTEM
// Smart drip campaigns, engagement scoring, and automated follow-ups
// ============================================================================

// Auth gate — all AI functions in this file run paid AI inference and write
// to contacts/leads/campaigns. Without an explicit auth check, callers could
// burn money + write to rows whose access is only governed by RLS.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

/**
 * ─── TOMBSTONE ─────────────────────────────────────────────────────────────
 * `aiCalculateLeadScore` LIVED HERE AND IS GONE. Its survivor is
 * app/actions/ai-lead-scoring.ts:121 — `scoreLeadWithAI`.
 *
 * It was a SECOND Layer-2 AI scorer with no caller anywhere in the tree, and
 * `lib/lead-scoring/LAYERING.md` rule 4 names exactly one ("Do not create a
 * fifth top-level scorer"). Two waves recorded the verdict — merge onto
 * scoreLeadWithAI, then delete — and both stopped short because that file sat
 * outside their lane. NOTHING WAS LOST: every item this copy had and the
 * survivor did not was moved there FIRST, and the survivor's header lists them
 * against this name:
 *
 *   · requireCaller() + the `brokerage_id` predicate on the contact read and on
 *     the write. The survivor had no gate at all, so this merge closed a hole
 *     rather than merely relocating a feature.
 *   · generateObject + a zod schema in place of a regex over free text.
 *   · the `activities` and `email_tracking` behavioural reads.
 *   · timelineScore, financialReadinessScore, buyerPersona, predictedTimeline,
 *     riskOfLoss and the positive/negative/neutral factor split, persisted to
 *     `contacts.ai_insights` and into `lead_score_history.factors`.
 *
 * ONE READ WAS DELIBERATELY NOT CARRIED, and that is a fix, not a loss. This
 * copy also read `lead_property_searches` with `.eq("lead_id", contactId)` — a
 * CONTACT id in a LEAD column. Wave 18 ruled on exactly that shape: the table is
 * keyed on the pre-conversion lead id, has no contacts column, and its writer was
 * removed for filing a contacts id there (app/actions/ai-predictions.ts:355
 * records the same finding). The query could only ever return nothing, so
 * carrying it forward would have moved a permanently-empty read onto the survivor
 * and let the prompt report "0 property searches" as if it were an observation
 * about the person. Property-search interest is not collected on contacts today;
 * when it is, the survivor is where it goes.
 * ───────────────────────────────────────────────────────────────────────────
 */

/**
 * Draft a multi-touch nurture SEQUENCE, modelled on one contact.
 *
 * REPOINTED (orphan burn-down, Lane A). This used to write its touchpoints into
 * `drip_campaigns.metadata` at status "paused", and that output was
 * UNDELIVERABLE BY CONSTRUCTION — not "not wired yet", but impossible:
 *
 *   · The only consumer of drip_campaigns is the queue-drain cron
 *     (app/api/cron/queue-drain/route.ts:drainDripCampaigns). It selects
 *     `.eq("status", "active")`, so a "paused" row is never read at all — its own
 *     comment calls these rows "drafts, untouched here".
 *   · Even for an active row it refuses to send drip metadata: "A drip row
 *     carries no message content of its own, so the ONLY honest service is
 *     handing the contact to the canonical nurture engine … Message content is
 *     never invented here." It enrols the contact into a compliance-gated
 *     `campaign_sequences` row whose STEPS carry the real copy.
 *
 * So the model wrote a full campaign, the platform paid for it, and no cron,
 * screen or send path could ever reach a word of it.
 *
 * It now drafts into the canonical nurture engine instead: a `campaign_sequences`
 * row plus its `campaign_sequence_steps`, created through the existing owners of
 * those tables (`createCampaignSequence` / `saveSequenceSteps`) rather than a
 * second set of inserts. That means the steps are executed by the
 * campaign-sequence-steps cron, the compliance gate applies, and the Sequence
 * Builder can edit what the model produced.
 *
 * IT IS CREATED INACTIVE. `createCampaignSequence` sets `is_active: false`, and
 * that is left alone: nothing model-authored should start messaging real people
 * before a human has read it. Launching stays with `launchCampaignSequence`.
 *
 * THE CONTACT IS AN ARCHETYPE, NOT A RECIPIENT. A sequence is a template many
 * people are enrolled into, so the contact here shapes the draft and is not
 * enrolled by this action. Enrolment stays with `enrollContactInSequence`.
 */

/** campaign_sequences.sequence_type CHECK: drip|nurture|re_engagement|transaction|post_close. */
const SEQUENCE_TYPE_FOR_CAMPAIGN: Record<string, string> = {
  buyer_nurture: "nurture",
  seller_nurture: "nurture",
  investor: "nurture",
  relocation: "nurture",
  sphere: "drip",
  lifetime_customer: "post_close",
}

/** campaign_sequence_steps.channel CHECK ∩ VALID_STEP_TYPES. The model is asked
 *  for the five channels an agent thinks in; these are their storable names. */
const STEP_CHANNEL_FOR_TOUCHPOINT: Record<string, string> = {
  email: "email",
  sms: "sms",
  call: "ai_call",
  direct_mail: "direct_mail",
  social: "social_post",
}

export async function aiGenerateDripCampaign(params: {
  contactId: string
  agentId: string
  campaignType: "buyer_nurture" | "seller_nurture" | "lifetime_customer" | "sphere" | "investor" | "relocation"
  duration: "30_days" | "60_days" | "90_days" | "6_months" | "12_months"
}): Promise<{ success: boolean; campaign?: any; sequenceId?: string; stepCount?: number; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.contactId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs provided" }
  }

  const supabase = await createClient()

  try {
    // Scope contact + agent to caller's brokerage
    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.contactId)
      .eq("brokerage_id", auth.brokerageId)
      .single()

    const { data: agent } = await supabase
      .from("agents")
      .select("*")
      .eq("id", params.agentId)
      .eq("brokerage_id", auth.brokerageId)
      .single()

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    const durationDays = {
      "30_days": 30,
      "60_days": 60,
      "90_days": 90,
      "6_months": 180,
      "12_months": 365,
    }[params.duration]

    // AI generates campaign
    const { object: campaign } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        campaignName: z.string(),
        description: z.string(),
        touchpoints: z.array(z.object({
          dayOffset: z.number(),
          channel: z.enum(["email", "sms", "call", "direct_mail", "social"]),
          subject: z.string().optional(),
          content: z.string(),
          purpose: z.string(),
          callToAction: z.string().optional(),
        })),
        totalTouchpoints: z.number(),
        estimatedEngagementRate: z.number(),
        personalizationNotes: z.string(),
      }),
      prompt: `Create a personalized ${params.campaignType} drip campaign for this contact over ${durationDays} days:

CONTACT:
- Name: ${contact.first_name} ${contact.last_name}
- Type: ${contact.contact_type}
- Persona: ${contact.contact_persona}
- Timeline: ${contact.timeline}
- Interests: ${contact.property_preferences ? JSON.stringify(contact.property_preferences) : "Not specified"}
- Notes: ${contact.notes}

AGENT:
- Name: ${agent?.first_name} ${agent?.last_name}
- Specialties: ${agent?.specialties?.join(", ") || "General"}

CAMPAIGN TYPE: ${params.campaignType}
DURATION: ${durationDays} days

Create a mix of email, SMS, and call touchpoints. Space them appropriately (not too frequent).
Each touchpoint should be personalized, provide value, and move the relationship forward.
Include market updates, educational content, and soft check-ins.
Make content warm and personal, not salesy.`,
    })

    // ── Land it where the executor can reach it ─────────────────────────────
    // Steps whose channel is not storable are DROPPED rather than coerced: a
    // "social" touchpoint silently saved as an email is a message going out on
    // the wrong channel to a real person.
    const steps = campaign.touchpoints
      .map((t) => ({ t, channel: STEP_CHANNEL_FOR_TOUCHPOINT[t.channel] }))
      .filter((x): x is { t: (typeof campaign.touchpoints)[number]; channel: string } => !!x.channel)
      .sort((a, b) => (a.t.dayOffset ?? 0) - (b.t.dayOffset ?? 0))

    if (steps.length === 0) {
      return {
        success: false,
        error: "The generated campaign had no touchpoint on a channel this platform can send.",
      }
    }

    const { createCampaignSequence, saveSequenceSteps } = await import("@/app/actions/campaign-sequences")

    const created = await createCampaignSequence({
      brokerageId: auth.brokerageId,
      name: campaign.campaignName,
      description: `${campaign.description}\n\nDrafted by AI over ${durationDays} days, modelled on ${contact.first_name ?? "a"} ${contact.last_name ?? "contact"}. ${campaign.personalizationNotes ?? ""}`.trim(),
      sequence_type: SEQUENCE_TYPE_FOR_CAMPAIGN[params.campaignType] ?? "nurture",
      // 'manual' is in the trigger_event CHECK and is the honest value: a human
      // decides who enters a draft sequence.
      trigger_event: "manual",
    })

    if (!created.sequence) {
      return { success: false, error: created.error ?? "Could not create the sequence." }
    }

    const sequenceId = (created.sequence as { id: string }).id

    // delay_days is a DELAY BETWEEN STEPS, not the absolute day offset the model
    // returns. Writing the offset straight through would compound: touchpoints on
    // days 1, 7 and 14 would fire on days 1, 8 and 22.
    let previousOffset = 0
    const builderSteps = steps.map((x, i) => {
      const offset = Math.max(0, Math.round(x.t.dayOffset ?? 0))
      const delay = Math.max(0, offset - previousOffset)
      previousOffset = offset
      return {
        step_number: i + 1,
        step_name: x.t.purpose?.slice(0, 120) || `${x.channel} touch ${i + 1}`,
        step_type: x.channel as never,
        delay_days: delay,
        delay_hours: 0,
        subject: x.channel === "email" ? (x.t.subject ?? null) : null,
        body: [x.t.content, x.t.callToAction].filter(Boolean).join("\n\n"),
        is_active: true,
      }
    })

    const savedSteps = await saveSequenceSteps(sequenceId, builderSteps)
    if (!savedSteps.success) {
      // The sequence row exists and is INACTIVE, so a partial save cannot message
      // anyone. Say what happened rather than reporting a campaign that has no
      // steps behind it.
      return {
        success: false,
        sequenceId,
        error: `The sequence "${campaign.campaignName}" was created but its steps were not saved: ${savedSteps.error}`,
      }
    }

    const droppedCount = campaign.touchpoints.length - steps.length

    revalidatePath("/dashboard/campaigns")
    revalidatePath("/dashboard/campaigns/sequences")
    return {
      success: true,
      sequenceId,
      stepCount: builderSteps.length,
      campaign: {
        id: sequenceId,
        name: campaign.campaignName,
        description: campaign.description,
        durationDays,
        stepCount: builderSteps.length,
        droppedTouchpoints: droppedCount,
        isActive: false,
      },
    }
  } catch (error) {
    console.error("[v0] AI drip campaign error:", error)
    return handleError(error, "aiGenerateDripCampaign")
  }
}

/**
 * AI-powered follow-up suggestion based on recent activity
 */
export async function aiSuggestFollowUp(params: {
  contactId: string
  agentId: string
}): Promise<{ success: boolean; suggestions?: any[]; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.contactId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs provided" }
  }

  const supabase = await createClient()

  try {
    // Scope contact lookup to caller's brokerage
    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.contactId)
      .eq("brokerage_id", auth.brokerageId)
      .single()

    const { data: recentInteractions } = await supabase
      .from("activities")
      .select("id, activity_type, title, description, notes, outcome, channel, status, created_at")
      .eq("contact_id", params.contactId)
      .order("created_at", { ascending: false })
      .limit(10)

    const { data: scheduledTasks } = await supabase
      .from("tasks")
      .select("*")
      .eq("contact_id", params.contactId)
      .eq("status", "pending")

    // AI generates suggestions
    const { object: suggestions } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        suggestions: z.array(z.object({
          priority: z.enum(["urgent", "high", "medium", "low"]),
          channel: z.enum(["email", "sms", "call", "in_person"]),
          timing: z.string(),
          reason: z.string(),
          suggestedContent: z.string(),
          expectedOutcome: z.string(),
        })),
        overallUrgency: z.enum(["immediate", "this_week", "next_week", "no_rush"]),
        relationshipHealth: z.enum(["excellent", "good", "needs_attention", "at_risk"]),
        insights: z.array(z.string()),
      }),
      prompt: `Analyze this contact and suggest follow-up actions:

CONTACT:
- Name: ${contact?.first_name} ${contact?.last_name}
- Type: ${contact?.contact_type}
- Status: ${contact?.status}
- Last Contact: ${contact?.last_contact_date}
- Timeline: ${contact?.timeline}

RECENT INTERACTIONS:
${JSON.stringify(recentInteractions, null, 2)}

SCHEDULED TASKS:
${JSON.stringify(scheduledTasks, null, 2)}

Provide 2-4 follow-up suggestions with specific timing and content recommendations.
Consider the relationship stage and avoid being too pushy.`,
    })

    return {
      success: true,
      suggestions: suggestions.suggestions,
    }
  } catch (error) {
    console.error("[v0] AI follow-up suggestion error:", error)
    return handleError(error, "aiSuggestFollowUp")
  }
}

/*
 * CONSOLIDATED (Data Steward audit): aiDistributeLead was removed — zero callers, wrote
 * phantom columns (leads.ai_assigned / ai_assignment_reason don't exist → the whole update
 * PGRST204-failed), and it let an LLM assign an agent directly on the lead, bypassing the
 * canonical business process: AI-ISA qualifies first, then the assignment engine
 * (lib/lead-assignment/assignment-engine evaluateAndAssignLead) assigns per tier rules
 * (solo → the solo agent) and converts the lead to a contact via handleLeadAssigned.
 */

/**
 * Batch re-engagement for cold leads
 */
export async function aiBatchReengagement(params: {
  agentId: string
  daysInactive: number
  maxLeads?: number
}): Promise<{ success: boolean; reengagementPlan?: any; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()
  const maxLeads = params.maxLeads || 50

  try {
    const inactiveDate = new Date(Date.now() - params.daysInactive * 24 * 60 * 60 * 1000).toISOString()

    // Get cold leads — scoped to caller's brokerage
    const { data: coldLeads } = await supabase
      .from("contacts")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("brokerage_id", auth.brokerageId)
      .lt("last_contacted_at", inactiveDate)
      .in("status", ["contacted", "qualified", "nurturing"])
      .limit(maxLeads)

    if (!coldLeads?.length) {
      return { success: true, reengagementPlan: { message: "No cold leads found", leads: [] } }
    }

    // AI creates re-engagement plan
    const { object: plan } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        totalLeads: z.number(),
        segments: z.array(z.object({
          segmentName: z.string(),
          leadIds: z.array(z.string()),
          reengagementStrategy: z.string(),
          emailTemplate: z.object({
            subject: z.string(),
            body: z.string(),
          }),
          smsTemplate: z.string().optional(),
          priorityOrder: z.number(),
        })),
        expectedRecoveryRate: z.number(),
        recommendations: z.array(z.string()),
      }),
      prompt: `Create a re-engagement plan for these ${coldLeads.length} inactive leads:

COLD LEADS:
${coldLeads.map((l) => `- ${l.id}: ${l.first_name} ${l.last_name}, Type: ${l.contact_type}, Last Contact: ${l.last_contact_date}, Notes: ${l.notes?.substring(0, 100) || "None"}`).join("\n")}

Segment them by similarity and create personalized re-engagement messages.
Focus on providing value, not being pushy.
Include a mix of email and SMS templates.`,
    })

    return { success: true, reengagementPlan: plan }
  } catch (error) {
    console.error("[v0] AI batch re-engagement error:", error)
    return handleError(error, "aiBatchReengagement")
  }
}

/**
 * Predict lead conversion probability.
 *
 * NOT A DUPLICATE OF `app/actions/ai-predictions.ts:predictLeadConversion`,
 * which is deliberately unwired and stays that way — checked before this was
 * given a surface. That one writes `predictive_lead_scores`, a table whose
 * RLS (`is_lead_visible_role()`) admits broker/admin only, so an AGENT-facing
 * card fed from it is empty by construction; its own docblock says so. This one
 * writes two columns on `contacts` — `ai_conversion_probability` (numeric) and
 * `ai_predicted_close_date` (date), both verified live — which the contact's own
 * agent can read. They are the ONLY conversion-probability values anything
 * agent-facing can reach, and nothing else in the tree writes them.
 */
export async function aiPredictConversion(params: {
  contactId: string
}): Promise<{
  success: boolean
  prediction?: any
  persisted?: boolean
  predictedCloseDate?: string | null
  error?: string
}> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  const supabase = await createClient()

  try {
    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.contactId)
      .eq("brokerage_id", auth.brokerageId)
      .single()

    const { data: interactions } = await supabase
      .from("activities")
      .select("id, activity_type, title, description, notes, outcome, channel, status, created_at")
      .eq("contact_id", params.contactId)

    const { data: propertyViews } = await supabase
      .from("property_views")
      .select("*")
      .eq("contact_id", params.contactId)

    const { object: prediction } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        conversionProbability: z.number().min(0).max(100),
        predictedCloseDate: z.string().optional(),
        confidenceLevel: z.enum(["low", "medium", "high"]),
        keyFactors: z.array(z.object({
          factor: z.string(),
          impact: z.enum(["positive", "negative", "neutral"]),
          weight: z.number(),
        })),
        riskFactors: z.array(z.string()),
        accelerators: z.array(z.string()),
        recommendation: z.string(),
      }),
      prompt: `Predict conversion probability for this lead:

CONTACT:
${JSON.stringify(contact, null, 2)}

INTERACTIONS (${interactions?.length || 0}):
${JSON.stringify(interactions?.slice(0, 20), null, 2)}

PROPERTY VIEWS (${propertyViews?.length || 0}):
${JSON.stringify(propertyViews?.slice(0, 20), null, 2)}

Analyze engagement patterns, timeline, and behavior to predict conversion likelihood.`,
    })

    // Update contact with prediction — scoped to caller's brokerage.
    //
    // `ai_predicted_close_date` is a DATE column. The model returns a free string
    // and an unparseable one is a 22007 that rejects the WHOLE update, taking the
    // probability down with it — so the date is only sent when it is actually a
    // date, and the probability lands either way.
    //
    // The refusal is read. supabase-js resolves a rejected update, so this
    // `await` used to report a stored prediction whether or not one was stored,
    // and the caller had no way to tell. `persisted` carries the truth.
    const predictedCloseDate =
      typeof prediction.predictedCloseDate === "string" &&
      /^\d{4}-\d{2}-\d{2}/.test(prediction.predictedCloseDate.trim())
        ? prediction.predictedCloseDate.trim().slice(0, 10)
        : null

    const { data: updated, error: updateError } = await supabase
      .from("contacts")
      .update({
        ai_conversion_probability: prediction.conversionProbability,
        ...(predictedCloseDate ? { ai_predicted_close_date: predictedCloseDate } : {}),
      })
      .eq("id", params.contactId)
      .eq("brokerage_id", auth.brokerageId)
      .select("id")

    if (updateError) {
      console.error("[aiPredictConversion] contact update refused:", updateError.message)
    }
    // A zero-row update is a refusal wearing the shape of success.
    const persisted = !updateError && !!updated && updated.length > 0

    return { success: true, prediction, persisted, predictedCloseDate }
  } catch (error) {
    console.error("[v0] AI conversion prediction error:", error)
    return handleError(error, "aiPredictConversion")
  }
}
