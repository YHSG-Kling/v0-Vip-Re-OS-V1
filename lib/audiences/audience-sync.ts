/**
 * lib/audiences/audience-sync.ts
 *
 * Wave 38 — auto-add new leads to the brokerage's FB custom audience,
 * and re-promote to the agent's audience when the lead converts to a
 * contact. Reads the canonical facebook_custom_audiences row keyed by
 * (brokerage_id, scope_type, agent_user_id?), inserts an audience_
 * members row with sync_status='pending', and queues the actual FB
 * Marketing API push for the existing audience-sync runner (which
 * exists at audience_sync_runs).
 *
 * Two entry points, both called from lib/kernel/event-reactor:
 *
 *   onLeadCaptured(leadId, brokerageId)
 *     · Resolves the brokerage's DEFAULT retargeting audience
 *       (scope_type='brokerage'). When the brokerage hasn't connected
 *       FB yet, this is a no-op — the lead capture still succeeds.
 *     · Skip-if-no-consent: leads have implicit no-consent until
 *       they explicitly opt in. FB custom audience matching is
 *       allowed under FB's hashed-email match (no SMS consent
 *       required); but we still respect direct_mail_opt_out as a
 *       proxy for "this person doesn't want our marketing".
 *
 *   onLeadConvertedToContact(contactId, brokerageId, agentUserId)
 *     · Promotes the audience membership: keeps the brokerage row,
 *       adds an agent_user_id-scoped row. Now the contact is in
 *       BOTH the brokerage's retargeting pool AND the assigned
 *       agent's personal ad audience.
 *     · If the agent hasn't connected their FB account, only the
 *       brokerage push runs.
 *
 * The actual FB Marketing API call (POST /act_<account>/customaudiences/
 * <id>/users with hashed payload) happens in the existing audience-
 * sync runner. This module is the staging layer.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface AudienceSyncOutcome {
  ok:                      boolean
  audiencesProcessed:      number
  membersInserted:         number
  skippedReasons:          string[]
}

interface AudienceRow {
  id:            string
  scope_type:    "agent" | "team" | "brokerage"
  agent_user_id: string | null
  audience_type: string | null
  status:        string | null
}

async function findAudienceForScope(args: {
  brokerageId: string
  agentUserId?: string | null
}): Promise<AudienceRow | null> {
  const svc = createServiceClient()
  if (args.agentUserId) {
    const { data } = await svc.from("facebook_custom_audiences")
      .select("id, scope_type, agent_user_id, audience_type, status")
      .eq("brokerage_id", args.brokerageId)
      .eq("scope_type", "agent")
      .eq("agent_user_id", args.agentUserId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as AudienceRow | null) ?? null
  }
  const { data } = await svc.from("facebook_custom_audiences")
    .select("id, scope_type, agent_user_id, audience_type, status")
    .eq("brokerage_id", args.brokerageId)
    .eq("scope_type", "brokerage")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as AudienceRow | null) ?? null
}

/** Insert the audience_members row idempotently. Unique constraint
 *  on (audience_id, contact_id, lead_id) handles re-fires. */
async function stageMembership(args: {
  brokerageId: string
  audienceId:  string
  contactId?:  string | null
  leadId?:     string | null
  consent:     Record<string, unknown>
}): Promise<{ inserted: boolean; skipped?: string }> {
  if (!args.contactId && !args.leadId) return { inserted: false, skipped: "no_recipient_id" }
  const svc = createServiceClient()
  const { error } = await svc.from("audience_members").insert({
    brokerage_id:     args.brokerageId,
    audience_id:      args.audienceId,
    contact_id:       args.contactId ?? null,
    lead_id:          args.leadId ?? null,
    sync_status:      "pending",
    consent_snapshot: args.consent,
  })
  if (error) {
    // 23505 = unique violation → already a member. Treat as success.
    if (error.code === "23505") return { inserted: false, skipped: "already_member" }
    return { inserted: false, skipped: error.message }
  }
  return { inserted: true }
}

/**
 * Hook for KernelEvent.LEAD_CAPTURED.
 *
 * Stages the lead into the brokerage's default FB retargeting
 * audience. No-op when the brokerage hasn't connected FB.
 */
export async function onLeadCapturedForAudience(args: {
  leadId:      string
  brokerageId: string
}): Promise<AudienceSyncOutcome> {
  const out: AudienceSyncOutcome = { ok: true, audiencesProcessed: 0, membersInserted: 0, skippedReasons: [] }
  const svc = createServiceClient()

  // Consent + opt-out check on the lead.
  const { data: lead } = await svc.from("leads")
    .select("id, brokerage_id, direct_mail_opt_out, email_opt_out, tcpa_consent")
    .eq("id", args.leadId)
    .maybeSingle()
  const l = lead as { brokerage_id: string | null; direct_mail_opt_out: boolean | null; email_opt_out: boolean | null; tcpa_consent: boolean | null } | null
  if (!l) { out.ok = false; out.skippedReasons.push("lead_not_found"); return out }
  if (l.brokerage_id !== args.brokerageId) {
    out.ok = false; out.skippedReasons.push("tenant_mismatch"); return out
  }
  // Soft suppression — leads who've opted out of every marketing
  // channel shouldn't be in retargeting audiences either.
  if (l.direct_mail_opt_out && l.email_opt_out) {
    out.skippedReasons.push("all_channels_opted_out")
    return out
  }

  const audience = await findAudienceForScope({ brokerageId: args.brokerageId })
  if (!audience) {
    out.skippedReasons.push("no_brokerage_audience_configured")
    return out
  }
  out.audiencesProcessed = 1
  const r = await stageMembership({
    brokerageId: args.brokerageId,
    audienceId:  audience.id,
    leadId:      args.leadId,
    consent:     {
      tcpa_consent:        l.tcpa_consent ?? false,
      direct_mail_opt_out: l.direct_mail_opt_out ?? false,
      email_opt_out:       l.email_opt_out ?? false,
      snapshot_at:         new Date().toISOString(),
    },
  })
  if (r.inserted) out.membersInserted++
  if (r.skipped) out.skippedReasons.push(r.skipped)
  return out
}

/**
 * Hook for KernelEvent.LEAD_CONVERTED_TO_CONTACT.
 *
 * Adds the contact to the assigned agent's personal FB audience
 * (when the agent has connected) while keeping the brokerage-tier
 * membership intact. Both audiences sync independently via the
 * existing audience-sync runner.
 */
export async function onLeadConvertedForAudience(args: {
  contactId:   string
  leadId:      string
  brokerageId: string
  agentUserId: string | null
}): Promise<AudienceSyncOutcome> {
  const out: AudienceSyncOutcome = { ok: true, audiencesProcessed: 0, membersInserted: 0, skippedReasons: [] }
  const svc = createServiceClient()

  const { data: contact } = await svc.from("contacts")
    .select("id, brokerage_id, direct_mail_opt_out, email_opt_out, tcpa_consent, dnc_status")
    .eq("id", args.contactId)
    .maybeSingle()
  const c = contact as {
    brokerage_id: string | null
    direct_mail_opt_out: boolean | null
    email_opt_out: boolean | null
    tcpa_consent: boolean | null
    dnc_status: boolean | null
  } | null
  if (!c) { out.ok = false; out.skippedReasons.push("contact_not_found"); return out }
  if (c.brokerage_id !== args.brokerageId) {
    out.ok = false; out.skippedReasons.push("tenant_mismatch"); return out
  }
  if (c.dnc_status) {
    out.skippedReasons.push("dnc_status_blocked")
    return out
  }

  const consent = {
    tcpa_consent:        c.tcpa_consent ?? false,
    direct_mail_opt_out: c.direct_mail_opt_out ?? false,
    email_opt_out:       c.email_opt_out ?? false,
    dnc_status:          c.dnc_status ?? false,
    snapshot_at:         new Date().toISOString(),
  }

  // Brokerage-tier — promote lead membership to contact_id so the
  // canonical row is contact-anchored once they're promoted.
  const brokerageAud = await findAudienceForScope({ brokerageId: args.brokerageId })
  if (brokerageAud) {
    out.audiencesProcessed++
    // Try to update the existing lead-keyed row first; if not present
    // insert a fresh contact-keyed row.
    const { data: existing } = await svc.from("audience_members")
      .select("id")
      .eq("audience_id", brokerageAud.id)
      .eq("lead_id", args.leadId)
      .maybeSingle()
    if (existing) {
      await svc.from("audience_members")
        .update({ contact_id: args.contactId, consent_snapshot: consent, sync_status: "pending" })
        .eq("id", existing.id)
    } else {
      const r = await stageMembership({
        brokerageId: args.brokerageId,
        audienceId:  brokerageAud.id,
        contactId:   args.contactId,
        leadId:      args.leadId,
        consent,
      })
      if (r.inserted) out.membersInserted++
      if (r.skipped) out.skippedReasons.push(`brokerage:${r.skipped}`)
    }
  } else {
    out.skippedReasons.push("no_brokerage_audience_configured")
  }

  // Agent-tier — add the contact to the assigned agent's audience.
  if (args.agentUserId) {
    const agentAud = await findAudienceForScope({
      brokerageId: args.brokerageId,
      agentUserId: args.agentUserId,
    })
    if (agentAud) {
      out.audiencesProcessed++
      const r = await stageMembership({
        brokerageId: args.brokerageId,
        audienceId:  agentAud.id,
        contactId:   args.contactId,
        leadId:      args.leadId,
        consent,
      })
      if (r.inserted) out.membersInserted++
      if (r.skipped) out.skippedReasons.push(`agent:${r.skipped}`)
    } else {
      out.skippedReasons.push("no_agent_audience_configured")
    }
  }

  return out
}
