'use server'

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { detectStaleLeads } from "@/lib/lead-assignment/stale-lead-detector"
import { triggerGhostRecovery } from "@/app/actions/ai-isa"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface SLABreachResult {
  brokerageId: string
  breachedCount: number
  staleCount: number
  errors: string[]
}

// ─── SLA BREACH PROCESSOR ─────────────────────────────────────────────────────

export async function processStaleLeadsAndSLA(
  brokerageId: string,
): Promise<SLABreachResult> {
  const supabase = createServiceClient()
  const errors: string[] = []
  let breachedCount = 0
  let staleCount = 0

  // ── Step 1: Find unbreached SLA rows that are past target_at ─────────────
  const now = new Date().toISOString()

  const { data: breachedRows, error: slaError } = await supabase
    .from("lead_sla_tracking")
    .select("id, lead_id, sla_type, target_at")
    .eq("brokerage_id", brokerageId)
    .lt("target_at", now)
    .is("completed_at", null)
    .eq("breached", false)

  if (slaError) {
    errors.push(`SLA fetch error: ${slaError.message}`)
  }

  const rows = breachedRows ?? []

  if (rows.length > 0) {
    // ── Step 2: Bulk-mark all as breached ─────────────────────────────────
    const ids = rows.map((r) => r.id)

    const { error: updateError } = await supabase
      .from("lead_sla_tracking")
      .update({ breached: true })
      .in("id", ids)

    if (updateError) {
      errors.push(`SLA breach update error: ${updateError.message}`)
    }

    // ── Step 3: Per-breach notifications ──────────────────────────────────
    for (const row of rows) {
      try {
        // a) lifecycle_events insert
        await supabase.from("lifecycle_events").insert({
          brokerage_id: brokerageId,
          entity_type:  "lead",
          entity_id:    row.lead_id,
          event_type:   KernelEvent.LEAD_SLA_BREACHED,
          metadata: {
            sla_type:  row.sla_type,
            target_at: row.target_at,
          },
          created_at: new Date().toISOString(),
        })

        // b) Find broker/admin user_id for this brokerage
        const { data: adminUsers } = await supabase
          .from("users")
          .select("id")
          .eq("brokerage_id", brokerageId)
          .in("user_type", ["broker", "admin", "superadmin"])
          .limit(5)

        for (const admin of adminUsers ?? []) {
          await supabase.from("notifications").insert({
            user_id:     admin.id,
            brokerage_id: brokerageId,
            type:        "sla_breach",
            priority:    "high",
            channel:     "in_app",
            entity_type: "lead",
            entity_id:   row.lead_id,
            title:       `SLA Breached: ${row.sla_type} for lead ${row.lead_id}`,
            body:        `The ${row.sla_type} SLA was due at ${new Date(row.target_at).toLocaleString()} and has not been completed.`,
            is_read:     false,
          })
        }

        // c) Mark breach_notified
        await supabase
          .from("lead_sla_tracking")
          .update({ breach_notified: true })
          .eq("id", row.id)

        breachedCount++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`Breach processing error for lead ${row.lead_id}: ${msg}`)
      }
    }
  }

  // ── Step 4: Run existing stale-lead-detector logic (DO NOT REPLACE) ──────
  try {
    const staleLeads = await detectStaleLeads(brokerageId)
    staleCount = staleLeads.length

    // Fetch a default active AI-ISA campaign for this brokerage (needed by triggerGhostRecovery)
    const { data: defaultCampaign } = await supabase
      .from("ai_isa_campaigns")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    // Emit STALE_LEAD_ALERT event for each stale lead not already tracked
    for (const lead of staleLeads) {
      try {
        // Check if we already emitted this alert today
        const todayStart = new Date()
        todayStart.setHours(0, 0, 0, 0)

        const { data: existing } = await supabase
          .from("lifecycle_events")
          .select("id")
          .eq("entity_id", lead.id)
          .eq("entity_type", "lead")
          .eq("event_type", KernelEvent.STALE_LEAD_ALERT)
          .gte("created_at", todayStart.toISOString())
          .maybeSingle()

        if (!existing) {
          await supabase.from("lifecycle_events").insert({
            brokerage_id: brokerageId,
            entity_type:  "lead",
            entity_id:    lead.id,
            event_type:   KernelEvent.STALE_LEAD_ALERT,
            metadata: {
              stale_reason:       lead.staleReason,
              days_stale:         lead.daysStale,
              last_activity_date: lead.lastActivityDate,
            },
            created_at: new Date().toISOString(),
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`Stale alert error for lead ${lead.id}: ${msg}`)
      }

      // ── AI-ISA Takeover: hand off each stale lead to AI-ISA ────────────
      try {
        // Resolve the full lead row to get contact_id and agent_id
        const { data: leadRow } = await supabase
          .from("leads")
          .select("id, contact_id, agent_id, lifecycle_state, reengagement_status")
          .eq("id", lead.id)
          .maybeSingle()

        if (
          leadRow &&
          leadRow.contact_id &&
          defaultCampaign?.id &&
          leadRow.lifecycle_state !== "isa_qualifying" &&
          leadRow.reengagement_status !== "active"
        ) {
          // Trigger AI-ISA ghost recovery (non-blocking)
          const recoveryResult = await triggerGhostRecovery({
            contactId:   leadRow.contact_id,
            campaignId:  defaultCampaign.id,
            brokerageId,
          })

          if (recoveryResult.success) {
            // Mark the lead as ISA-owned and in re-engagement
            await supabase
              .from("leads")
              .update({
                lifecycle_state:    "isa_qualifying",
                reengagement_status: "active",
                updated_at:          new Date().toISOString(),
              })
              .eq("id", lead.id)

            // Notify the assigned agent via activity — schema has no metadata column
            if (leadRow.agent_id) {
              await supabase.from("activities").insert({
                agent_id:      leadRow.agent_id,
                contact_id:    leadRow.contact_id,
                brokerage_id:  brokerageId,
                activity_type: "isa_takeover_notification",
                entity_type:   "lead",
                title:         "AI-ISA took over a stale lead",
                description:   `Your lead has been inactive for ${lead.daysStale ?? 0} days. AI-ISA is now attempting re-engagement on your behalf. You'll be notified when they respond.`,
                status:        "pending",
                priority:      "medium",
              })
            }
          }
        }
      } catch (err) {
        // Non-blocking — log but don't fail the broader processor
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[stale-processor] AI-ISA takeover failed:', msg)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`Stale lead detector error: ${msg}`)
  }

  return { brokerageId, breachedCount, staleCount, errors }
}
