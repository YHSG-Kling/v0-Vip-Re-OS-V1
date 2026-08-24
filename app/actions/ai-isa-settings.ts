'use server'

/**
 * app/actions/ai-isa-settings.ts
 *
 * AI ISA configuration — now PER USER, not only per tenant.
 *
 * OWNER RULING (2026-08-24), verbatim: "ai customizations are also per user".
 *
 * ── STORE: `ai_isa_settings`. TOMBSTONE for the blob it replaces ─────────────
 * SURVIVOR: lib/ai-isa/resolve-isa-settings.ts (the cascade + the reads/writes).
 *
 * This file used to read and write
 * `global_settings.additional_settings->'ai_isa_settings'`, a JSONB blob on a
 * table that is ONE ROW PER BROKERAGE. That store could not express the ruling
 * even in principle — there is nowhere on a per-brokerage row to put a second
 * user's answer — and it was dead besides: `public.global_settings` held 0 rows
 * live (hrvaqgvukzxfskkcrwbt, 2026-08-24), so `getAIISASettings()` returned
 * DEFAULT_AISA_SETTINGS for every brokerage for its whole life and
 * `saveAIISASettings()` returned "Global settings row not found for this
 * brokerage" for every write. Nothing was migrated because there was nothing to
 * migrate; both stores held zero rows, verified before and after m552.
 *
 * The `ai_isa_settings` TABLE is the survivor: m552 gave it the same owner grain
 * `brand_voice_profile` already had (brokerage_id / team_id / agent_id) plus an
 * explicit `owner_type`, so it can hold an agent's own answer, a team's, a
 * brokerage's, and the platform's, one row each.
 *
 * ── WHAT RESOLUTION LOOKS LIKE NOW ──────────────────────────────────────────
 * agent → team → brokerage → platform, most-specific-wins, over the ONE cascade
 * order in lib/connections/scope.ts. There is no second walker (CLAUDE.md §6).
 *
 * ── TENANCY, HONESTLY STATED ────────────────────────────────────────────────
 * `getAIISASettings(brokerageId)` and `saveAIISASettings(brokerageId, …)` keep
 * their brokerage-id parameter for the three ISA pages that already pass their own
 * session brokerage. They are PUBLIC HTTP ENDPOINTS (CLAUDE.md §4 — every export
 * of a "use server" file is), and a body-supplied brokerage id is the IDOR shape
 * this repo keeps finding. `saveAIISASettings` checks the id against the session;
 * `getAIISASettings` does NOT, and that is RECORDED HERE rather than quietly left.
 * What it exposes is ISA POLICY (which channels, which capabilities, which
 * thresholds) and no tenant DATA, so the exposure is configuration disclosure
 * rather than record disclosure — real, but not record disclosure, and closing it
 * means changing the shape of UI call sites on a branch another lane is editing.
 * `isCapabilityEnabled` — the third such export — is GONE (tombstone below): its
 * two callers were background paths that never had a session to gate against.
 * The per-actor entry points take NO tenant argument at all and derive everything
 * from the session, which is the shape new callers should use.
 *
 * The per-user tier is applied automatically when the requested brokerage IS the
 * session's: the caller's own agent/team rows are consulted first. A read for a
 * DIFFERENT brokerage resolves at the brokerage tier only — it never borrows the
 * session user's personal settings into another tenant's answer.
 */

import { getAgentContext } from '@/lib/identity/get-agent-context'
// THE session superadmin gate, not a re-spelling of it. `getAgentContext()` does
// not carry users.platform_role, and live 0 of 23 rows carry
// user_type='superadmin' — so testing `ctx.role === 'superadmin'` (which is what
// this file used to do) is DEAD CODE that can never admit the one account it
// exists for. requireSuperadmin() reads BOTH identity columns through
// lib/platform/platform-staff-roster.ts::isPlatformSuperadminIdentity, which also
// refuses `ai_isa_system` by name.
import { requireSuperadmin } from '@/lib/auth/platform-guard'
import {
  resolveIsaSettings,
  resolveIsaSettingsResult,
  writeIsaSettings,
  type IsaSettingsOwnerType,
  type IsaSettingsResult,
} from '@/lib/ai-isa/resolve-isa-settings'
import { type AIISASettings } from '@/lib/ai-isa/settings-types'
import { TENANT_ADMIN_USER_TYPES } from '@/lib/auth/resolve-user-role'

// ── Roles allowed to write TENANT-scoped settings ───────────────────────────
// An agent may always write their OWN row (that is the ruling); changing the
// brokerage's or a team's answer stays a manager decision.
//
// DERIVED, NOT RESTATED (§6). This was `new Set(['broker', 'broker_admin',
// 'broker_owner', 'admin', 'team_lead'])` — the five members of
// TENANT_ADMIN_USER_TYPES, retyped. That Set's own header asks surfaces needing
// a Set to derive it "instead of restating it… retyping the five is the
// duplication the ruling forbids", and lib/vendors/vendor-scope.ts and
// lib/auth/authorize-for-user.ts already spread it the same way.
//
// The duplication was not theoretical: `broker_admin` became a real user type
// only under the owner's 2026-08-22 ruling, and every hand-typed copy of this
// roster is a place it can be missed. An inline copy silently stops agreeing
// with the roster the moment a member is added — and it would fail OPEN on a
// write gate, which is the wrong direction (§4).
const TENANT_WRITE_ROLES = TENANT_ADMIN_USER_TYPES

/**
 * The caller's own cascade scope, from the SESSION. Never from a parameter.
 * `agentId` is agents.id and `teamId` is teams.id — the two id classes
 * `ai_isa_settings.agent_id` / `.team_id` actually store.
 */
async function sessionScope() {
  const ctx = await getAgentContext()
  return {
    ctx,
    scope: { agentId: ctx.agentId, teamId: ctx.teamId, brokerageId: ctx.brokerageId },
  }
}

// ─── `isCapabilityEnabled` — DELETED (this wave) ─────────────────────────────
// SURVIVOR: lib/ai-isa/resolve-isa-settings.ts :: isIsaCapabilityEnabledForScope.
//
// It had exactly two callers — lib/predictive-listing/auto-send.ts and
// lib/sphere-resonance/run-resonance-scan.ts — and BOTH are background paths with
// no session, so routing them through a "use server" export bought nothing and
// cost the thing the owner asked for: the action derives the per-user tier from
// `getAgentContext()`, which answers UNAUTHENTICATED in a cron, so the agent's own
// settings could never be consulted from either call site. Both now call the
// resolver directly and pass the agent id they already hold, which is what makes
// "ai customizations are also per user" true where it decides something.
//
// NOTHING TO MERGE, verified rather than assumed: its whole body was
// `isIsaCapabilityEnabledForScope(scopeForBrokerage(brokerageId), capability)`.
// The master-switch check and the defaultEnabledCapabilities() fallback it used to
// own were moved INTO the survivor before this was removed, and the survivor adds
// the refusal this one never had — an unreadable tier answers false instead of
// falling through to a less specific owner's policy.
//
// It was also a PUBLIC HTTP ENDPOINT taking a body-supplied brokerage id, so
// removing it closes one instance of the shape recorded below.

/**
 * Resolve the settings that govern this brokerage — per-user when the caller IS
 * of this brokerage, brokerage-tier otherwise.
 */
export async function getAIISASettings(brokerageId: string): Promise<AIISASettings> {
  const scope = await scopeForBrokerage(brokerageId)
  return resolveIsaSettings(scope)
}

// ─── `getAIISASettingsForActor` — DELETED (this wave) ────────────────────────
// SURVIVOR: `getAIISASettingsResolution`, immediately below (this same file).
//
// Two spellings of one question (CLAUDE.md §6): both read the SAME cascade from
// the SAME session scope, and the survivor additionally says WHICH tier answered.
// A settings screen needs that — showing an inherited brokerage value as though
// the viewer had chosen it is how a per-user setting silently reads as somebody
// else's — so the poorer answer had no caller and could only have grown one by
// accident. `getAIISASettingsResolution().settings` is this function, exactly.

/**
 * The per-actor read WITH its provenance: which tier answered, or that a tier
 * could not be read. A settings screen needs this to say "you are inheriting your
 * brokerage's answer" rather than showing an inherited value as if it were the
 * user's own.
 */
export async function getAIISASettingsResolution(): Promise<IsaSettingsResult> {
  const { scope } = await sessionScope()
  return resolveIsaSettingsResult(scope)
}

/**
 * Save the BROKERAGE-tier settings. Signature unchanged for the existing settings
 * screens; the tenant predicate is still checked against the session.
 */
export async function saveAIISASettings(
  brokerageId: string,
  updates: Partial<AIISASettings>,
): Promise<{ success: boolean; error?: string }> {
  const { ctx } = await sessionScope()

  if (!ctx.isAuthenticated) return { success: false, error: 'Not signed in' }
  const isPlatform = (await requireSuperadmin()).ok
  if (!isPlatform && !TENANT_WRITE_ROLES.has(ctx.role)) {
    return { success: false, error: 'Insufficient permissions' }
  }
  if (!isPlatform && ctx.brokerageId !== brokerageId) {
    return { success: false, error: 'Brokerage mismatch' }
  }

  return writeIsaSettings({
    owner: { ownerType: 'brokerage', ownerId: brokerageId },
    brokerageId,
    updates,
  })
}

/**
 * THE PER-USER WRITE. An agent customizes their OWN ISA behaviour; a team lead or
 * broker may write the team's and the brokerage's.
 *
 * The owner tier is NAMED by the caller and then AUTHORISED against the session —
 * it is never inferred from which id happens to be present, and the ids
 * themselves come from the session, never from the request. That is what keeps
 * this from being "pass me an agent_id and I will write their settings".
 */
export async function saveAIISASettingsForOwner(
  ownerType: IsaSettingsOwnerType,
  updates: Partial<AIISASettings>,
): Promise<{ success: boolean; error?: string }> {
  const { ctx } = await sessionScope()
  if (!ctx.isAuthenticated) return { success: false, error: 'Not signed in' }

  if (ownerType === 'platform') {
    // Platform-tier ISA defaults are a total-control decision. `ai_isa_system`
    // is a platform ACTOR but is refused here by the same survivor predicate
    // that refuses it total control everywhere else.
    const gate = await requireSuperadmin()
    if (!gate.ok) {
      return { success: false, error: 'Only the platform superadmin may set platform-wide ISA defaults' }
    }
    return writeIsaSettings({ owner: { ownerType: 'platform', ownerId: null }, brokerageId: null, updates })
  }

  if (!ctx.brokerageId) {
    return { success: false, error: 'No brokerage on this session — refusing to write an untenanted ISA settings row' }
  }

  if (ownerType === 'agent') {
    if (!ctx.agentId) return { success: false, error: 'No agent profile on this session' }
    return writeIsaSettings({
      owner: { ownerType: 'agent', ownerId: ctx.agentId },
      brokerageId: ctx.brokerageId,
      updates,
    })
  }

  if (ownerType === 'team') {
    if (!ctx.teamId) return { success: false, error: 'No team on this session' }
    if (!TENANT_WRITE_ROLES.has(ctx.role)) return { success: false, error: 'Insufficient permissions' }
    return writeIsaSettings({
      owner: { ownerType: 'team', ownerId: ctx.teamId },
      brokerageId: ctx.brokerageId,
      updates,
    })
  }

  if (!TENANT_WRITE_ROLES.has(ctx.role)) return { success: false, error: 'Insufficient permissions' }
  return writeIsaSettings({
    owner: { ownerType: 'brokerage', ownerId: ctx.brokerageId },
    brokerageId: ctx.brokerageId,
    updates,
  })
}

/**
 * PRIVATE-BY-INTENT, but this is a "use server" file so it would be a public
 * endpoint if it were exported. It is not exported, and it is `async` anyway.
 *
 * The per-user tiers apply ONLY when the requested brokerage is the session's.
 * Consulting the caller's agent row while answering for a DIFFERENT tenant would
 * be exactly the cross-tenant bleed this cascade exists to prevent.
 */
async function scopeForBrokerage(brokerageId: string) {
  const { ctx } = await sessionScope()
  if (ctx.isAuthenticated && ctx.brokerageId && ctx.brokerageId === brokerageId) {
    return { agentId: ctx.agentId, teamId: ctx.teamId, brokerageId }
  }
  return { agentId: null, teamId: null, brokerageId }
}

// ── getAIISAStats ─────────────────────────────────────────────────────────────
// Dashboard-level stats for the admin/broker ISA reporting surface.

export async function getAIISAStats(brokerageId: string): Promise<{
  activeContactCount: number
  activeLeadCount: number
  staleContactCount: number
  handoffRequiredCount: number
  outreachLast30Days: number
  negativeOutcomeLast30Days: number
}> {
  const { createServiceClient } = await import('@/lib/supabase/service')
  const supabase = createServiceClient()
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const staleDate = new Date(Date.now() - 14 * 86_400_000).toISOString()

  const [
    activeContacts,
    activeLeads,
    staleContacts,
    handoffs,
    outreach,
    negativeOutcomes,
  ] = await Promise.all([
    // Contacts where ISA is enabled
    supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .eq('ai_outreach_paused', false)
      .eq('isa_reengage_allowed', true)
      .is('deleted_at', null),

    // Leads still in AI ISA owner queue
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .eq('ai_isa_owner', true)
      .eq('is_active', true),

    // Stale contacts
    supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .eq('ai_outreach_paused', false)
      .lt('last_contacted_at', staleDate)
      .is('deleted_at', null),

    // Handoffs awaiting human
    supabase
      .from('agent_handoffs')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .eq('handoff_status', 'pending'),

    // Outreach in last 30 days (contact-side)
    supabase
      .from('ai_isa_activities')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .gte('created_at', since30),

    // Negative outcomes in last 30 days
    supabase
      .from('ai_isa_activities')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', brokerageId)
      .in('outcome', ['not_interested', 'wrong_number', 'do_not_contact', 'do_not_call', 'bad_contact_data'])
      .gte('created_at', since30),
  ])

  return {
    activeContactCount:      activeContacts.count  ?? 0,
    activeLeadCount:         activeLeads.count     ?? 0,
    staleContactCount:       staleContacts.count   ?? 0,
    handoffRequiredCount:    handoffs.count         ?? 0,
    outreachLast30Days:      outreach.count         ?? 0,
    negativeOutcomeLast30Days: negativeOutcomes.count ?? 0,
  }
}
