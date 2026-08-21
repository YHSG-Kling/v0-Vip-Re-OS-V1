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
 *   onLeadConvertedForAudience({contactId, leadId, brokerageId, agentUserId})
 *     · NAME CORRECTED. This header called it onLeadConvertedToContact, which
 *       is not and never was an export of this file — so the documented API
 *       named nothing, and a reader grepping for it found only this comment.
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
 *
 * ── FAIR HOUSING LIVES HERE NOW (owner ruling, wave 15) ──────────────────
 * The ruling took the fair-housing control OFF the data lane — scraping,
 * enrichment, scoring, sourcing, signals and buyer property search — and
 * left it on outbound CONTENT. That leaves one act unguarded that the
 * statute actually reaches: TARGETING HOUSING ADVERTISING BY A PROTECTED
 * CLASS. 42 U.S.C. § 3604(c) reaches the publication of a housing ad
 * indicating a protected-class preference; HUD's actions against Meta
 * reached protected-class ad TARGETING. Neither reaches holding a
 * homeowner's age in a CRM.
 *
 * WHAT THIS FILE CARRIES, MEASURED BEFORE THE GATE WAS DESIGNED. This
 * module itself carries NO segmentation criteria — `stageMembership`
 * writes only (audience_id, contact_id, lead_id, consent_snapshot), so
 * there is nothing here to segment ON. The segmentation is chosen ONE
 * LEVEL UP, on the audience row: `facebook_custom_audiences.source_rule`
 * (jsonb), written by lib/kernel/ads.ts:915 (`createAudienceSegment`) and
 * read back by lib/kernel/ads.ts:757 (`syncAudience`) to build the contact
 * query it uploads to Meta/Google. That is a REAL segmentation point, not
 * an invented one.
 *
 * So the gate reads the audience's own `source_rule` at resolve time and
 * refuses to stage ANY person into an audience whose rule leans on a
 * protected class. It fails CLOSED (CLAUDE.md §4): a rule that cannot be
 * evaluated is a refusal, never a pass, and the refusal is COUNTED into
 * `skippedReasons` rather than swallowed.
 *
 * EVERY audience in this product is a housing audience — this is a real
 * estate CRM and `facebook_custom_audiences` exists only to retarget
 * housing services — so there is deliberately no "is this a housing
 * campaign?" branch: a per-campaign housing flag would be one unchecked
 * checkbox away from turning the gate off.
 *
 * NOT FIXED HERE, and named so it is tracked rather than assumed: the
 * CREATION path (lib/kernel/ads.ts:915) still accepts any `sourceRule`
 * without running this check, so a protected-class audience can still be
 * DEFINED — it just cannot be POPULATED through this module. Wiring
 * `assertAudienceSegmentationAllowed` into `createAudienceSegment` and
 * into `syncAudience`'s contact query belongs to the lane that owns
 * lib/kernel/ads.ts.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { protectedClassSegmentationIn } from "@/lib/lead-governance/protected-class-signals"

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
  /** The segmentation rule lib/kernel/ads.ts:757 turns into the contact query
   *  it uploads to Meta/Google. THE thing the fair-housing gate reads. */
  audience_name: string | null
  source_rule:   unknown
}

/** The columns the gate needs. `source_rule` and `audience_name` were added to
 *  this select FOR the gate — without them it would be judging a row it cannot
 *  see, which reads as "checked and fine" (CLAUDE.md §2). */
const AUDIENCE_COLS = "id, scope_type, agent_user_id, audience_type, status, audience_name, source_rule"

/**
 * The fair-housing refusal, at the act the statute actually reaches.
 *
 * Returns null when the audience may be populated, or a SKIP REASON naming the
 * offending attributes when it may not. A reason, never a bare false: an
 * operator reading `skippedReasons` has to know which audience to fix.
 *
 * FAILS CLOSED. A `source_rule` that cannot be walked (a thrown classifier, a
 * shape nobody anticipated) refuses rather than passes.
 */
function protectedClassAudienceRefusal(aud: AudienceRow): string | null {
  let hits: string[]
  try {
    hits = protectedClassSegmentationIn(aud.source_rule)
  } catch (e) {
    return `fair_housing_unevaluable:${aud.id}:${e instanceof Error ? e.message : String(e)}`
  }
  if (hits.length === 0) return null
  return `fair_housing_protected_segmentation:${aud.audience_name ?? aud.id}:${hits.join("|")}`
}

async function findAudienceForScope(args: {
  brokerageId: string
  agentUserId?: string | null
}): Promise<AudienceRow | null> {
  const svc = createServiceClient()
  if (args.agentUserId) {
    const { data } = await svc.from("facebook_custom_audiences")
      .select(AUDIENCE_COLS)
      .eq("brokerage_id", args.brokerageId)
      .eq("scope_type", "agent")
      .eq("agent_user_id", args.agentUserId)
      .eq("status", "synced")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as AudienceRow | null) ?? null
  }
  const { data } = await svc.from("facebook_custom_audiences")
    .select(AUDIENCE_COLS)
    .eq("brokerage_id", args.brokerageId)
    .eq("scope_type", "brokerage")
    .eq("status", "synced")
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
 * Wave 38 CORRECTION — `onLeadCapturedForAudience` REMOVED.
 *
 * Meta's Custom Audiences policy requires that uploaded recipients have
 * an opt-in relationship. Leads on this platform are explicitly
 * unconsented (lifecycle_state='unconsented' at capture); pushing
 * them violates FB's TOS and risks the brokerage's ad account.
 *
 * Audience membership now begins ONLY when a lead becomes a contact
 * (handleLeadAssigned, and — since the manual lane was wired —
 * lib/kernel/crm.ts convertLeadToContact). At that point
 * the kernel has either explicit tcpa_consent OR established active
 * representation, both of which satisfy FB's consent requirement.
 *
 * Hook for KernelEvent.LEAD_CONVERTED_TO_CONTACT.
 *
 * Adds the contact to BOTH the brokerage-tier audience AND the
 * assigned agent's personal FB audience (when the agent has connected).
 * Hard-gates on tcpa_consent being true OR dnc_status being false
 * with an active representation flag — leads that converted via the
 * web-form/QR path with explicit consent satisfy the first; agent-
 * imported contacts where the agent has an existing relationship
 * satisfy the second.
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

  // Wave 38 CORRECTION — FB Custom Audiences requires an opt-in
  // relationship. Hard gate: tcpa_consent must be true OR the contact
  // is in active representation (where consent is implied by signed
  // agreement). Without one of those signals, skip the push entirely.
  if (c.tcpa_consent !== true) {
    const { hasActiveRepresentation } = await import("@/lib/kernel/compliance/active-representation")
    const repFlag = await hasActiveRepresentation(svc, args.contactId, args.brokerageId)
    if (!repFlag) {
      out.skippedReasons.push("no_consent_or_representation")
      return out
    }
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
    // FAIR HOUSING (owner ruling, wave 15) — an audience whose source_rule
    // segments on a protected class may not be populated. See the file header
    // for why this is the point of enforcement and the data lane is not.
    const refusal = protectedClassAudienceRefusal(brokerageAud)
    if (refusal) {
      out.ok = false
      out.skippedReasons.push(`brokerage:${refusal}`)
    } else {
      // Wave 38 CORRECTION — contact-only push (no lead_id). Membership
      // begins at conversion; legacy lead-keyed rows from prior code
      // paths are no longer expected.
      const r = await stageMembership({
        brokerageId: args.brokerageId,
        audienceId:  brokerageAud.id,
        contactId:   args.contactId,
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
      const refusal = protectedClassAudienceRefusal(agentAud)
      if (refusal) {
        out.ok = false
        out.skippedReasons.push(`agent:${refusal}`)
      } else {
        const r = await stageMembership({
          brokerageId: args.brokerageId,
          audienceId:  agentAud.id,
          contactId:   args.contactId,
          consent,
        })
        if (r.inserted) out.membersInserted++
        if (r.skipped) out.skippedReasons.push(`agent:${r.skipped}`)
      }
    } else {
      out.skippedReasons.push("no_agent_audience_configured")
    }
  }

  return out
}

/**
 * onContactBecameLifetimeForAudience — when a contact crosses into LIFETIME (a deal closed,
 * contact_type='lifetime'), ensure the past client is in the brokerage + assigned-agent FB
 * retargeting audiences. Past clients are the highest-ROI real-estate audience (referrals +
 * repeat business + the lookalike seed), yet the lifetime transition had NO audience hook —
 * a past client could be retargeted-eligible and never added (e.g. an agent-imported client
 * who never flowed through the conversion path). Resolves the agent itself; consent-gated
 * (a closed deal implies active representation, which satisfies Meta's opt-in requirement);
 * idempotent (already a member → no-op). Best-effort; never throws.
 */
export async function onContactBecameLifetimeForAudience(args: {
  contactId:   string
  brokerageId: string
}): Promise<AudienceSyncOutcome> {
  const out: AudienceSyncOutcome = { ok: true, audiencesProcessed: 0, membersInserted: 0, skippedReasons: [] }
  const svc = createServiceClient()

  const { data: contact } = await svc.from("contacts")
    .select("id, brokerage_id, agent_id, direct_mail_opt_out, email_opt_out, tcpa_consent, dnc_status")
    .eq("id", args.contactId)
    .maybeSingle()
  const c = contact as {
    brokerage_id: string | null; agent_id: string | null
    direct_mail_opt_out: boolean | null; email_opt_out: boolean | null
    tcpa_consent: boolean | null; dnc_status: boolean | null
  } | null
  if (!c) { out.ok = false; out.skippedReasons.push("contact_not_found"); return out }
  if (c.brokerage_id !== args.brokerageId) { out.ok = false; out.skippedReasons.push("tenant_mismatch"); return out }
  if (c.dnc_status) { out.skippedReasons.push("dnc_status_blocked"); return out }

  // Consent gate — same as conversion: tcpa_consent OR active representation. A closed deal
  // is representation, so a true past client clears this; an opted-out one is skipped.
  if (c.tcpa_consent !== true) {
    const { hasActiveRepresentation } = await import("@/lib/kernel/compliance/active-representation")
    const repFlag = await hasActiveRepresentation(svc, args.contactId, args.brokerageId)
    if (!repFlag) { out.skippedReasons.push("no_consent_or_representation"); return out }
  }

  const consent = {
    tcpa_consent:        c.tcpa_consent ?? false,
    direct_mail_opt_out: c.direct_mail_opt_out ?? false,
    email_opt_out:       c.email_opt_out ?? false,
    dnc_status:          c.dnc_status ?? false,
    lifetime:            true,
    snapshot_at:         new Date().toISOString(),
  }

  // Resolve the assigned agent's user (agents.id → users.id) so the past client also lands
  // in the agent's personal audience (their sphere/referral ad pool).
  let agentUserId: string | null = null
  if (c.agent_id) {
    const { data: a } = await svc.from("agents").select("user_id").eq("id", c.agent_id).maybeSingle()
    agentUserId = (a as { user_id: string | null } | null)?.user_id ?? null
  }

  const brokerageAud = await findAudienceForScope({ brokerageId: args.brokerageId })
  if (brokerageAud) {
    out.audiencesProcessed++
    // FAIR HOUSING (owner ruling, wave 15) — same refusal as the conversion path.
    // A past client is the highest-value retargeting seed, which is exactly why
    // the protected-class check has to hold on this path too.
    const refusal = protectedClassAudienceRefusal(brokerageAud)
    if (refusal) {
      out.ok = false
      out.skippedReasons.push(`brokerage:${refusal}`)
    } else {
      const r = await stageMembership({ brokerageId: args.brokerageId, audienceId: brokerageAud.id, contactId: args.contactId, consent })
      if (r.inserted) out.membersInserted++
      if (r.skipped) out.skippedReasons.push(`brokerage:${r.skipped}`)
    }
  } else {
    out.skippedReasons.push("no_brokerage_audience_configured")
  }

  if (agentUserId) {
    const agentAud = await findAudienceForScope({ brokerageId: args.brokerageId, agentUserId })
    if (agentAud) {
      out.audiencesProcessed++
      const refusal = protectedClassAudienceRefusal(agentAud)
      if (refusal) {
        out.ok = false
        out.skippedReasons.push(`agent:${refusal}`)
      } else {
        const r = await stageMembership({ brokerageId: args.brokerageId, audienceId: agentAud.id, contactId: args.contactId, consent })
        if (r.inserted) out.membersInserted++
        if (r.skipped) out.skippedReasons.push(`agent:${r.skipped}`)
      }
    } else {
      out.skippedReasons.push("no_agent_audience_configured")
    }
  }

  return out
}
