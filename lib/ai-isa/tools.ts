/**
 * lib/ai-isa/tools.ts
 *
 * Tools the AI ISA can invoke during an inbound email or voice conversation.
 * These are kernel-validated CRM operations — every write goes through the
 * same compliance + DNC + audit paths the rest of the platform uses.
 *
 * Built around the Vercel AI SDK's `tool()` helper. The handler factory
 * returns a tool map bound to the current (lead, brokerage, agent) context
 * so each tool's `execute` already knows who it's acting on.
 *
 * v1 surface (write tools):
 *   - escalate_to_agent       : page the human agent, set urgency
 *   - mark_qualification      : score the lead hot/warm/cold + reason
 *   - request_appointment     : capture the lead's intent to meet, log activity
 *   - mark_do_not_contact     : TCPA opt-out + halt all sequences
 *
 * Read tools intentionally omitted in v1 — the calling action already
 * pre-loads lead + history into the prompt. Add reads here when richer
 * intel is needed during the call (cross-brokerage lookups, etc.).
 */

import { tool } from "ai"
import { z } from "zod"
import { createServiceClient } from "@/lib/supabase/service"
import { haltEngagementForNegativeReply } from "./conversation-handler"
import { signalScore, signalTemperature } from "./qualification-core"

export interface ISAToolContext {
  /** leads.id — for writes that target the lead row */
  leadId: string
  /** brokerages.id — for tenant scoping on every write */
  brokerageId: string
  /** agents.id who owns this lead — escalations land in their queue */
  agentId: string | null
  /** Free-text snippet of the inbound message — used to log DNC reason */
  inboundExcerpt?: string
}

/**
 * Returns the tool map the AI ISA can use during a generation. Bind once
 * at the top of the inbound email handler and pass the result to
 * generateTextRouted({ tools }).
 */
export function buildISATools(ctx: ISAToolContext) {
  return {
    escalate_to_agent: tool({
      description:
        "Flag this lead for immediate agent attention. Use when the lead asks to speak to a human, has a high-urgency need, or your reply alone won't be enough. Creates a notification for the assigned agent.",
      inputSchema: z.object({
        reason: z.string().describe("One-sentence reason for escalation, agent-readable"),
        urgency: z.enum(["normal", "high", "critical"]).describe("How fast the agent should respond"),
      }),
      execute: async ({ reason, urgency }) => {
        const supabase = createServiceClient()
        if (ctx.agentId) {
          // Insert a notification on the assigned agent's user account.
          const { data: agent } = await supabase
            .from("agents").select("user_id").eq("id", ctx.agentId).maybeSingle()
          if (agent?.user_id) {
            // notifications' real shape is type/title/body/entity_* (the previous
            // notification_type/message/metadata insert was phantom — every ISA
            // escalation page FAILED silently and no agent was ever notified).
            // priority check allows low|medium|high|critical → 'normal' maps to medium.
            await supabase.from("notifications").insert({
              user_id: agent.user_id,
              brokerage_id: ctx.brokerageId,
              type: "isa_escalation",
              title: urgency === "critical" ? "URGENT: Lead needs your attention" : "Lead needs your attention",
              body: reason,
              priority: urgency === "normal" ? "medium" : urgency,
              entity_type: "lead",
              entity_id: ctx.leadId,
            })
          }
        }
        // Always log on the lead so the conversation timeline shows it.
        await supabase.from("activities").insert({
          // activities.contact_id FKs contacts(id); ctx.leadId is a LEAD id, so this
          // was FK-rejected and the escalation never reached the timeline it claims
          // to write to. entity_type/entity_id carry the lead (same shape as above).
          contact_id: null,
          entity_type: "lead",
          entity_id: ctx.leadId,
          brokerage_id: ctx.brokerageId,
          activity_type: "ai_isa_escalation",
          title: `ISA escalation (${urgency})`,
          description: reason,
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        return { success: true, urgency, escalatedAt: new Date().toISOString() }
      },
    }),

    mark_qualification: tool({
      description:
        "Score this lead based on the conversation so far. Use when the lead's message reveals a clearer signal about their motivation, timeline, or readiness.",
      inputSchema: z.object({
        signal: z.enum(["hot", "warm", "cold", "unqualified"]).describe("Qualification temperature"),
        reason: z.string().describe("Brief justification — what in the message indicated this signal"),
      }),
      execute: async ({ signal, reason }) => {
        const supabase = createServiceClient()
        // leads table holds the rolling qualification state in lead_temperature +
        // lead_score (qualification-core owns both mappings). The previous write
        // targeted a phantom qualification_signal column — PGRST204 failed the WHOLE
        // update, so lead_score never persisted and readinessForAgent (which requires
        // lead_score >= 50) could never fire for conversation-scored leads: the
        // qualify→assign chain was starved.
        const tempScore = signalScore(signal)
        await supabase
          .from("leads")
          .update({
            lead_temperature: signalTemperature(signal),
            lead_score: tempScore,
            updated_at: new Date().toISOString(),
          })
          .eq("id", ctx.leadId)
          .eq("brokerage_id", ctx.brokerageId)
        await supabase.from("activities").insert({
          contact_id: null,
          entity_type: "lead",
          entity_id: ctx.leadId,
          brokerage_id: ctx.brokerageId,
          activity_type: "ai_isa_qualification",
          title: `ISA marked lead ${signal}`,
          description: reason,
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        return { success: true, signal, leadScore: tempScore }
      },
    }),

    request_appointment: tool({
      description:
        "Capture that the lead wants to meet/call/tour. Logs the intent and notifies the agent — the agent will follow up with concrete time slots. Use when the lead explicitly asks for a meeting, showing, or call.",
      inputSchema: z.object({
        meeting_type: z
          .enum(["phone_call", "in_person_meeting", "property_showing", "video_call"])
          .describe("What kind of meeting the lead asked for"),
        preferred_window: z
          .string()
          .nullable()
          .describe("Free-text time preference if mentioned (e.g. 'this Saturday morning'), or null"),
        notes: z.string().describe("Any details the lead provided (property of interest, etc.)"),
      }),
      execute: async ({ meeting_type, preferred_window, notes }) => {
        const supabase = createServiceClient()
        await supabase.from("activities").insert({
          contact_id: null,
          entity_type: "lead",
          entity_id: ctx.leadId,
          brokerage_id: ctx.brokerageId,
          agent_id: ctx.agentId,
          activity_type: "appointment_request",
          title: `Appointment requested: ${meeting_type.replace("_", " ")}`,
          description: [preferred_window ? `Preferred: ${preferred_window}` : null, notes]
            .filter(Boolean)
            .join("\n"),
          status: "scheduled",
          created_at: new Date().toISOString(),
        })
        // Page the agent so they can confirm + book.
        if (ctx.agentId) {
          const { data: agent } = await supabase
            .from("agents").select("user_id").eq("id", ctx.agentId).maybeSingle()
          if (agent?.user_id) {
            // Real notifications shape (see escalate_to_agent note) — the phantom
            // insert meant a lead asking to MEET never paged the agent.
            await supabase.from("notifications").insert({
              user_id: agent.user_id,
              brokerage_id: ctx.brokerageId,
              type: "appointment_request",
              title: "Lead wants to meet — book a time",
              body: `${meeting_type.replace("_", " ")}${preferred_window ? ` (${preferred_window})` : ""}`,
              priority: "high",
              entity_type: "lead",
              entity_id: ctx.leadId,
            })
          }
        }
        return { success: true, meetingType: meeting_type }
      },
    }),

    mark_do_not_contact: tool({
      description:
        "TCPA opt-out: the lead has clearly said to stop contacting them (or worded it ambiguously and you're being cautious). Halts ALL outreach immediately and flags do_not_contact=true. Use sparingly — once set, the platform cannot contact this person again without an explicit human re-opt-in.",
      inputSchema: z.object({
        reason: z.string().describe("What the lead said that triggered this — for the audit log"),
      }),
      execute: async ({ reason }) => {
        // Reuse the existing TCPA halt path so all the same notifications +
        // sequence stops fire as if a human had set DNC.
        await haltEngagementForNegativeReply({
          leadId: ctx.leadId,
          body: ctx.inboundExcerpt ?? reason,
          brokerageId: ctx.brokerageId,
        })
        return { success: true, reason }
      },
    }),
  }
}
