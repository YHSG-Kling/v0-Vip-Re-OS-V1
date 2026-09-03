// NOT a server-action module (2026-09-03, integrator, lane R3-A's sweep — held
// back while lane H2 converted its lifecycle_events inserts). The module-level
// "use server" that stood here made processStaleLeadsAndSLA(brokerageId) a
// public HTTP door onto a service client with the tenant from the PARAMETER
// (CLAUDE.md §4). Its only caller is app/api/cron/stale-lead-monitor/route.ts,
// which gates on the cron secret and iterates tenants itself; the parameter is
// now an in-process contract. `server-only` fails a future client import.
import "server-only"

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { detectStaleLeads } from "@/lib/lead-assignment/stale-lead-detector"
import { triggerGhostRecovery } from "@/app/actions/ai-isa"
import {
  conversionVerdictForRow,
  describeConversionRefusal,
  partitionConvertedLeads,
} from "@/lib/contact-promotion/conversion-finality"

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

  // CONVERSION FINALITY — `lead_sla_tracking` carries NO conversion predicate of
  // its own, so this sweep was breaching and notifying on leads that had already
  // become contacts. A converted lead owes the brokerage no SLA: the clock ran
  // out on a person who is now a client. Converted rows are dropped from the
  // breach sweep (never marked, never notified); the partition FAILS CLOSED, so
  // a refused read leaves the sweep with nothing to breach rather than breaching
  // everything unchecked.
  const slaCandidates = (breachedRows ?? []) as Array<{ id: string; lead_id: string; sla_type: string; target_at: string }>
  const slaPartition = await partitionConvertedLeads(supabase, slaCandidates.map((r) => r.lead_id))
  if (slaPartition.error) errors.push(slaPartition.error)
  for (const [leadId, contactId] of slaPartition.converted) {
    errors.push(`SLA breach skipped for lead ${leadId}: converted to contact ${contactId} — the contact owns the relationship now.`)
  }
  for (const leadId of slaPartition.unreadable) {
    errors.push(`SLA breach skipped for lead ${leadId}: conversion state unreadable — failing closed.`)
  }
  const slaOpen = new Set(slaPartition.open)
  const rows = slaCandidates.filter((r) => slaOpen.has(r.lead_id))

  // CLOSE the converted leads' SLA rows instead of leaving them open forever.
  // Without this they stay `breached=false, completed_at IS NULL` and are
  // re-selected on EVERY run — which would make the contact-side ghost recovery
  // below fire again on every cron tick: a skip that turns into an over-touch.
  // `completed_at` is also the honest outcome: the lead did not miss its SLA, it
  // became a client.
  {
    const convertedSlaRowIds = slaCandidates
      .filter((r) => slaPartition.converted.has(r.lead_id))
      .map((r) => r.id)
    if (convertedSlaRowIds.length > 0) {
      const { error: closeError } = await supabase
        .from("lead_sla_tracking")
        .update({ completed_at: now })
        .in("id", convertedSlaRowIds)
      if (closeError) {
        errors.push(`SLA rows for converted leads NOT closed: ${closeError.message}`)
      }
    }
  }

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
        // a) kernel event — audit row + reactor (the bare insert reached nothing)
        const { emitKernelEvent } = await import("@/lib/kernel/emit")
        await emitKernelEvent({
          brokerageId,
          entityType: "lead",
          entityId:   row.lead_id,
          event:      KernelEvent.LEAD_SLA_BREACHED,
          source:     "cron",
          metadata: {
            sla_type:  row.sla_type,
            target_at: row.target_at,
          },
        })

        // b) Find broker/admin user_id for this brokerage
        const { data: adminUsers } = await supabase
          .from("users")
          .select("id")
          .eq("brokerage_id", brokerageId)
          // RECIPIENT FILTER: 'superadmin' dropped (matches zero users.user_type
          // rows); broker_owner added — storable seat that owns the brokerage.
          .in("user_type", ["broker", "admin", "broker_owner"])
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
      // SECOND GATE. detectStaleLeads is conversion-guarded at the query, but a
      // STALE_LEAD_ALERT is a lead-keyed UPDATE and the ruling says those cease
      // on conversion — so the verdict is re-read from the row the detector
      // carried rather than trusted from one filter. Refusals are REPORTED, not
      // swallowed: a skipped alert must be explainable.
      const verdict = conversionVerdictForRow({ id: lead.id, contact_id: lead.contactId })
      if (!verdict.allowed) {
        errors.push(describeConversionRefusal(verdict, "stale-lead alert"))
        continue
      }
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
          const { emitKernelEvent } = await import("@/lib/kernel/emit")
          await emitKernelEvent({
            brokerageId,
            entityType: "lead",
            entityId:   lead.id,
            event:      KernelEvent.STALE_LEAD_ALERT,
            source:     "cron",
            metadata: {
              stale_reason:       lead.staleReason,
              days_stale:         lead.daysStale,
              last_activity_date: lead.lastActivityDate,
            },
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`Stale alert error for lead ${lead.id}: ${msg}`)
      }
    }

    // ── Step 5: GHOST RECOVERY — dispatched to the CONTACT, never the lead ────
    //
    // WHAT THIS BLOCK USED TO BE, AND WHY IT WAS THE WORST DEFECT IN THE WAVE
    //
    // It required `leadRow.contact_id` to be truthy — so it ran ONLY on leads
    // that had already CONVERTED. It correctly fired ghost recovery at the
    // CONTACT… and then WROTE BACK TO THE LEAD, setting
    // `lifecycle_state='isa_qualifying'` and `reengagement_status='active'`, and
    // filed an `activities` row with `entity_type:"lead"`.
    //
    // `lifecycle_state='isa_qualifying'` is EXACTLY the value
    // lib/ai-isa/ghost-reengagement.ts:detectGhostLeads selects on. The job that
    // noticed a lead had converted put that lead straight back onto the ISA
    // OUTREACH QUEUE. The owner's ruling is that communication on a converted
    // lead CEASES; this loop re-armed it, automatically, on a schedule.
    //
    // WHAT IT IS NOW: the dispatch to the contact SURVIVES — that half was
    // right, and ghost recovery is a contact action. The lead write-back and the
    // entity_type:"lead" activity are GONE. The activity is re-keyed to the
    // CONTACT (entity_type 'contact'), which is who the recovery is actually
    // about.
    //
    // ITS POPULATION MOVED, DELIBERATELY: converted leads no longer reach
    // detectStaleLeads (it is conversion-guarded now), so this block is driven
    // by the converted rows the SLA sweep above already read — leads with a
    // breached SLA that converted, i.e. exactly "went quiet after becoming a
    // client". No extra query: `slaPartition.converted` is already in hand.
    const ghostTargets = [...slaPartition.converted.entries()]
    if (ghostTargets.length > 0 && defaultCampaign?.id) {
      for (const [leadId, contactId] of ghostTargets) {
        try {
          const recoveryResult = await triggerGhostRecovery({
            contactId,
            campaignId: defaultCampaign.id,
            brokerageId,
          })

          if (!recoveryResult.success) continue

          // The agent notification is filed against the CONTACT. No lead row is
          // touched: not lifecycle_state, not reengagement_status, not an
          // entity_type:'lead' activity. Once converted, the lead is history.
          const { data: contactRow, error: contactErr } = await supabase
            .from("contacts")
            .select("id, agent_id")
            .eq("id", contactId)
            .eq("brokerage_id", brokerageId)
            .maybeSingle()

          if (contactErr) {
            errors.push(`Ghost-recovery notification skipped for contact ${contactId}: ${contactErr.message}`)
            continue
          }

          if (contactRow?.agent_id) {
            const { error: activityErr } = await supabase.from("activities").insert({
              agent_id:      contactRow.agent_id,
              contact_id:    contactId,
              brokerage_id:  brokerageId,
              activity_type: "isa_takeover_notification",
              entity_type:   "contact",
              entity_id:     contactId,
              title:         "AI-ISA is re-engaging a quiet client",
              description:   `This client has gone quiet past their service SLA. AI-ISA is attempting re-engagement on your behalf. You'll be notified when they respond. (Origin lead ${leadId} converted — the lead itself is closed.)`,
              status:        "pending",
              priority:      "medium",
            })
            if (activityErr) {
              errors.push(`Ghost-recovery notification NOT filed for contact ${contactId}: ${activityErr.message}`)
            }
          }
        } catch (err) {
          // Non-blocking — log but don't fail the broader processor
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[stale-processor] contact ghost recovery failed:', msg)
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`Stale lead detector error: ${msg}`)
  }

  return { brokerageId, breachedCount, staleCount, errors }
}
