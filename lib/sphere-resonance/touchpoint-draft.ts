/**
 * lib/sphere-resonance/touchpoint-draft.ts — THE lifetime-customer touchpoint
 * drafter, callable with no session (lane 86E, wave 86).
 *
 * THE DEFECT. lib/sphere-resonance/run-resonance-scan.ts (the autonomous
 * sphere-resonance cron) called app/actions/ai-sphere-management.ts::
 * aiGenerateTouchpoint — a "use server" action that built the COOKIE client
 * and read `contacts` through it. The cron has no cookie, so under RLS the
 * contact read came back empty, the action answered "Contact not found", the
 * scan's `try` swallowed it and the life-event follow-up went out with an EMPTY
 * body. The action also took `agentId` from its caller with no session gate
 * (§4 — every "use server" export is a public endpoint).
 * Found by scripts/sessionless-use-server-census.ts.
 *
 * THE SHAPE (LANE_RULES wave 86): body moved here UNCHANGED in what it writes;
 * the tenant arrives VERIFIED —
 *   · the session door passes the SESSION's brokerage (and refuses an agentId
 *     that is not the caller's own unless the caller is tenant staff);
 *   · the resonance scan passes the brokerage it is scanning (the contact row
 *     it read carries it).
 * The contact AND the agent must both sit in that brokerage. The model call
 * moved off the unrouted generateObject shim onto generateObjectRouted (feature
 * sphere_touchpoint_generation, pinned to the gpt-4o the call site used), so
 * ai_tool_usage books the spend (§5).
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed.
 */
import "server-only"
import { z } from "zod"
import { generateObjectRouted } from "@/lib/ai/models"

export type TouchpointType = "anniversary" | "birthday" | "check_in" | "market_update" | "holiday" | "referral_ask"

export interface TouchpointDraftInput {
  brokerageId: string
  /** agents.id — scheduled_touchpoints.agent_id and brand_voice_profile.agent_id. */
  agentId: string
  contactId: string
  touchpointType: TouchpointType
  /** ISO date or datetime. Defaults to today — an undated touchpoint is one the calendar can never show. */
  scheduledFor?: string
  additionalContext?: string
  relationshipType?: string
}

const TouchpointSchema = z.object({
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
})
export type TouchpointDraft = z.infer<typeof TouchpointSchema>

export type TouchpointDraftResult =
  | { success: true; data: TouchpointDraft; touchpointId: string; message: string }
  | { success: false; error: string; data?: TouchpointDraft }

export async function draftSphereTouchpoint(svc: any, input: TouchpointDraftInput): Promise<TouchpointDraftResult> {
  const { brokerageId, agentId, contactId, touchpointType } = input
  if (!brokerageId) return { success: false, error: "Touchpoint refused: no brokerageId (the tenant must come from a session or the scanned row)" }

  const { data: contact, error: contactError } = await svc
    .from("contacts")
    .select(`
      *,
      transactions!transactions_contact_id_fkey(property_address, close_date, purchase_price),
      activities(activity_type, notes, created_at)
    `)
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (contactError) return { success: false, error: `Touchpoint: contact read refused: ${contactError.message}` }
  if (!contact) return { success: false, error: "Contact not found" }

  const { data: agentRow, error: agentError } = await svc
    .from("agents").select("id").eq("id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
  if (agentError) return { success: false, error: `Touchpoint: agent read refused: ${agentError.message}` }
  if (!agentRow) return { success: false, error: "Agent record not found in this brokerage" }

  // The agent's brand voice (a refused read degrades to the default voice, as before).
  const { data: brandVoice } = await svc
    .from("brand_voice_profile")
    .select("*")
    .eq("agent_id", agentId)
    .maybeSingle()

  const lastTransaction = contact.transactions?.[0]

  const { object: touchpoint } = await generateObjectRouted({
    feature: "sphere_touchpoint_generation",
    brokerageId,
    schema: TouchpointSchema,
    prompt: `Generate a personalized ${touchpointType} touchpoint for this lifetime customer:

Contact: ${contact.first_name} ${contact.last_name}
Relationship: ${contact.contact_type}
Last property: ${lastTransaction?.property_address || "Unknown"}
Close date: ${lastTransaction?.close_date || "Unknown"}
Interests/Notes: ${contact.notes || "None recorded"}
Recent interactions: ${JSON.stringify(contact.activities?.slice(0, 3) || [])}

Relationship to agent: ${input.relationshipType || contact.contact_type || "Past client"}
What the agent says matters most right now: ${input.additionalContext?.trim() || "Not specified"}

Brand voice: ${brandVoice?.tone || "Professional yet warm"}
Agent specialty: ${brandVoice?.specialties || "Residential real estate"}

Generate:
1. Email subject and message
2. Optional call script (if personal call appropriate)
3. Text message version (keep under 160 chars)
4. Gift suggestion if appropriate for ${touchpointType}
5. 3-5 personalized details to reference`,
  })

  // scheduled_date AND the tenant anchor are both set (the calendar reads the
  // row by a scheduled_date range — an undated row is invisible forever), and
  // the insert is READ: supabase-js resolves a refusal.
  const { data: savedTouchpoint, error: saveError } = await svc
    .from("scheduled_touchpoints")
    .insert({
      agent_id:         agentId,
      brokerage_id:     brokerageId,
      contact_id:       contactId,
      touchpoint_type:  touchpointType,
      scheduled_date:   (input.scheduledFor ?? new Date().toISOString()).split("T")[0],
      message_template: JSON.stringify(touchpoint),
      status:           "scheduled",
      ai_generated:     true,
    })
    .select("id")
    .single()
  if (saveError || !savedTouchpoint?.id) {
    return { success: false, error: `Draft written but not scheduled: ${saveError?.message ?? "no row returned"}`, data: touchpoint }
  }

  return { success: true, data: touchpoint, touchpointId: savedTouchpoint.id as string, message: touchpoint.message }
}
