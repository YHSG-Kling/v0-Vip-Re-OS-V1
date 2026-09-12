/**
 * lib/auth/require-caller.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE "who is calling, and which tenant do they belong to?" READ.
 *
 * MEASURED 2026-09-03 (wave 26, lane H4): THIRTY-TWO file-local copies of a
 * function named `requireCaller` live under app/actions/** — the list is in the
 * lane report and is reproduced at the foot of this file so the integrator can
 * fold them in without re-measuring. Every copy is the same three steps:
 *
 *     1. session user            supabase.auth.getUser()
 *     2. the caller's users row  .from("users").select(brokerage_id, …).eq("id", user.id)
 *     3. ok / error              { ok: true, userId, brokerageId, … } | { ok: false, error }
 *
 * and they DISAGREE on exactly the things a gate must not disagree on:
 *
 *   · 22 of 32 never destructure `error` from step 2. supabase-js RESOLVES a
 *     refused read (CLAUDE.md §3), so on those copies an RLS refusal of the
 *     users row is reported as "Unauthorized" / "no brokerage" — a permissions
 *     bug wearing a data bug's clothes. The 10 that do check are the newest
 *     (career-tier, daily-plan, mentor-session, email-campaigns, present-to-seller,
 *     seller-decision-governance, and the three video/* copies + memory-video).
 *   · 9 copies default a missing user_type to "agent" — a row with no user_type
 *     is then GRADED as an agent by every predicate downstream. The H1 copies
 *     use String(u.user_type ?? "") instead. This survivor returns the column
 *     as read (`string | null`); every predicate in lib/auth/resolve-user-role.ts
 *     already accepts null and answers "no" to it, which is the fail-closed
 *     reading (§4) — an absent role must never read as a granted one.
 *   · Not one copy reads `platform_role`. So none of them can tell platform
 *     staff from a tenant user, and any surface that needs the platform half
 *     (the brokerage dashboard's "may this caller name another tenant?") has to
 *     do a SECOND users read, or — as app/dashboard/brokerage/page.tsx did until
 *     this wave — skip the question. Platform staff live in `platform_role`
 *     (§4); `user_type='superadmin'` has zero live rows.
 *
 * ── WHAT THE SURVIVOR CARRIES, AND WHAT IT DELIBERATELY DOES NOT ─────────────
 *
 *   CARRIED (merged ONTO this survivor, §1 — nothing a copy had is dropped):
 *     · the error check on both the session read and the users read;
 *     · the four identity columns the copies between them read
 *       (brokerage_id, user_type, platform_role — team_id is below);
 *     · the created session client, so an action does not build a second one
 *       (career-tier / daily-plan / mentor-session return it too);
 *     · a `reason` discriminator on refusal, because a PAGE has to redirect an
 *       unauthenticated caller to /login and a tenant-less one to onboarding,
 *       and a bare error string cannot tell those apart.
 *
 *   NOT CARRIED, on purpose — these are COMPOSED at the call site, not baked in:
 *     · agents.id  (ai-communication-hub, seller-open-house, business-card):
 *       `agents.id` and `users.id` are DISJOINT (§3, 23503). A caller that needs
 *       the agents row asks for it explicitly, crossing on agents.user_id.
 *     · team_id (ai-identity, referral-appreciation): returned raw here as
 *       `teamId` because it is on the same row and costs nothing, but it is a
 *       users-row DENORMALISATION, not the team anchor — team lead anchors on
 *       teams.team_lead_id (§4).
 *     · the impersonation seam (listings.ts resolves through
 *       lib/platform/acting-context.ts, content-studio through getAgentContext).
 *       Those are DIFFERENT questions ("whom is this staff member acting as?")
 *       and stay on their own survivors.
 *     · any ROLE decision. This resolves identity; it grants nothing. Gate with
 *       the named predicates in lib/auth/resolve-user-role.ts, or with
 *       lib/auth/require-brokerage-admin.ts when the answer must also honour a
 *       role GRANT.
 *
 * ── TWO ENTRY POINTS, ONE READ ───────────────────────────────────────────────
 *
 *   resolveCallerIdentity()  the session + the row, brokerage_id MAY be null.
 *                            For surfaces where a platform-staff caller with no
 *                            tenant of their own is a legitimate caller.
 *   requireCaller()          the same, with brokerage_id REQUIRED — the exact
 *                            contract all 32 copies enforce.
 *
 * Both take NO arguments. The tenant comes from the SESSION and from nowhere
 * else (§4); a version of this that accepted a userId or a brokerageId would be
 * the IDOR shape this repository keeps paying for.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

type SessionClient = Awaited<ReturnType<typeof createClient>>

export type CallerIdentity = {
  /** The SESSION user's id (users.id / auth.users.id). Never a body-supplied id. */
  userId: string
  /** users.brokerage_id, exactly as stored. */
  brokerageId: string | null
  /** users.user_type, exactly as stored. NOT defaulted to "agent" — see header. */
  userType: string | null
  /** users.platform_role — the platform-staff column (§4). */
  platformRole: string | null
  /** users.team_id — a denormalisation, not the team anchor (see header). */
  teamId: string | null
  /** The session (RLS-bound) client that performed the read, for reuse. */
  supabase: SessionClient
}

export type CallerRefusal = {
  ok: false
  /**
   * WHY, so a caller can route: a page redirects `unauthenticated` to /login and
   * `no_brokerage` to onboarding; `unreadable` means the gate could not run and
   * must be surfaced as a refusal, never as "no data" (§4 fail closed).
   */
  reason: "unauthenticated" | "unreadable" | "no_brokerage"
  error: string
}

export type ResolveCallerResult = ({ ok: true } & CallerIdentity) | CallerRefusal

export type RequireCallerResult =
  | ({ ok: true } & Omit<CallerIdentity, "brokerageId"> & { brokerageId: string })
  | CallerRefusal

/**
 * Session user → users row. brokerage_id may be null on success.
 */
export async function resolveCallerIdentity(): Promise<ResolveCallerResult> {
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    return { ok: false, reason: "unauthenticated", error: "Not authenticated" }
  }

  // §3 — supabase-js RESOLVES a refused read. Without `error`, an RLS refusal of
  // the caller's own row is indistinguishable from "this user has no row".
  const { data: row, error: rowError } = await supabase
    .from("users")
    .select("brokerage_id, user_type, platform_role, team_id")
    .eq("id", auth.user.id)
    .maybeSingle()

  if (rowError) {
    return { ok: false, reason: "unreadable", error: `Could not resolve your profile: ${rowError.message}` }
  }

  const u = (row ?? null) as {
    brokerage_id?: string | null
    user_type?: string | null
    platform_role?: string | null
    team_id?: string | null
  } | null

  return {
    ok: true,
    userId: auth.user.id,
    brokerageId: u?.brokerage_id ?? null,
    userType: u?.user_type ?? null,
    platformRole: u?.platform_role ?? null,
    teamId: u?.team_id ?? null,
    supabase,
  }
}

/**
 * Session user → users row → refuse unless the caller belongs to a brokerage.
 * The contract every file-local copy enforced, in one place.
 */
export async function requireCaller(): Promise<RequireCallerResult> {
  const id = await resolveCallerIdentity()
  if (!id.ok) return id
  if (!id.brokerageId) {
    return { ok: false, reason: "no_brokerage", error: "Your account is not linked to a brokerage" }
  }
  return { ...id, brokerageId: id.brokerageId }
}

export type CallerWithAgentResult =
  | { ok: true; userId: string; brokerageId: string; agentId: string | null; supabase: SessionClient }
  | CallerRefusal

/**
 * requireCaller() + the caller's agents.id, crossed via agents.user_id (§3 —
 * `agents.id` and `users.id` are DISJOINT). Survivor for THREE byte-identical
 * private `requireCaller` copies (SAME BODY census round 3, 2026-09-09):
 *   app/actions/ai-communication-hub.ts:31, app/actions/business-card/business-card-actions.ts:17,
 *   app/actions/seller-open-house.ts:28
 * Each copy swallowed the agents-read `error` (§3 — supabase-js resolves a
 * refusal) and returned a bare "Unauthorized" for every refusal reason; this
 * carries requireCaller()'s error-checked reads and `reason` discriminator and
 * adds only the agentId lookup. Imported at each former site AS `requireCaller`
 * so every existing `auth.userId` / `auth.brokerageId` / `auth.agentId` /
 * `auth.error` call site needed no further edit.
 */
export async function requireCallerWithAgent(): Promise<CallerWithAgentResult> {
  const caller = await requireCaller()
  if (!caller.ok) return caller
  const { data: a, error: agentError } = await caller.supabase
    .from("agents")
    .select("id")
    .eq("user_id", caller.userId)
    .maybeSingle()
  if (agentError) {
    return { ok: false, reason: "unreadable", error: `Could not resolve your agent record: ${agentError.message}` }
  }
  return { ok: true, userId: caller.userId, brokerageId: caller.brokerageId, agentId: a?.id ?? null, supabase: caller.supabase }
}

export type TenantAdminOrSoloOwnerResult =
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }

/**
 * Tenant admin (isAdminOrBroker), OR a solo-tier subscriber acting on their OWN
 * brokerage (`brokerages.plan_tier = 'solo_agent'`) — "TIER PARITY" (owner
 * rule): a solo-tier subscriber IS their own broker, and their one working seat
 * often carries `user_type` 'agent'/'solo_agent', which locked them out of
 * their own admin-only rails.
 *
 * Survivor for TWO byte-identical private `requireAdmin` copies (SAME BODY
 * census round 3, 2026-09-09): app/actions/marketing-ai-approvals.ts:25 and
 * app/actions/marketing-campaigns-admin.ts:17. Same allowance the voice
 * 'draft_save_plays' intent already applies (app/api/internal/voice-command).
 */
export async function requireTenantAdminOrSoloOwner(): Promise<TenantAdminOrSoloOwnerResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const { data: row } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!row?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  const userType = row.user_type as string
  if (!isAdminOrBroker({ user_type: userType })) {
    const svc = createServiceClient()
    const { data: b } = await svc
      .from("brokerages").select("plan_tier").eq("id", row.brokerage_id).maybeSingle()
    if ((b as { plan_tier?: string } | null)?.plan_tier !== "solo_agent") {
      return { ok: false, error: "Forbidden" }
    }
  }
  return { ok: true, userId: user.id, brokerageId: row.brokerage_id as string, userType }
}

/**
 * Confirm a row from `table` belongs to `brokerageId` — the service client is
 * used deliberately so RLS never masks the check. Survivor for two
 * byte-identical private copies (SAME BODY census round 3, 2026-09-09):
 * app/actions/workflow-orchestrator.ts:37 `ensureBrokerageOwnership` and
 * app/actions/workflows.ts:26 `assertOwnership`.
 */
export async function assertRowBrokerageOwnership(
  table: string,
  id: string,
  brokerageId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient()
  const { data } = await svc.from(table).select("brokerage_id").eq("id", id).maybeSingle()
  if (!data) return { ok: false, error: `${table} not found` }
  if ((data as { brokerage_id?: string | null }).brokerage_id !== brokerageId) return { ok: false, error: "Forbidden" }
  return { ok: true }
}

/**
 * Session → tenant admin's brokerage, or `null` on any refusal. Survivor for
 * two byte-identical private `authBrokerage` copies (SAME BODY census round
 * 3, 2026-09-09): app/dashboard/admin/campaign-center/actions.ts:7 and
 * app/dashboard/admin/content-studio/actions.ts:7.
 */
export async function authTenantAdminBrokerage(): Promise<{ brokerageId: string; userId: string } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id || !isAdminOrBroker({ user_type: u.user_type ?? "" })) return null
  return { brokerageId: u.brokerage_id, userId: user.id }
}

/**
 * `users.brokerage_id` + `users.user_type` for an EXPLICIT `userId` (not the
 * session — the caller already resolved which user it means, e.g. a webhook
 * payload's linked user). Throws when the row is missing or refused, so
 * callers that need a soft failure should catch, not add a third body.
 *
 * Survivor for two byte-identical private `requireUserContext` copies (SAME
 * BODY census round 3, 2026-09-09): lib/kernel/agent-onboarding.ts:55 and
 * lib/kernel/calendar-sync.ts:77.
 */
export async function requireUserRowContext(
  userId: string,
): Promise<{ brokerageId: string; userType: string }> {
  const supabase = await createClient()
  const { data: user, error } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", userId)
    .single()

  if (error || !user) throw new Error("User not found")
  return { brokerageId: user.brokerage_id, userType: user.user_type }
}

export type AdsSessionActor = { userId: string; brokerageId: string }

/**
 * Resolve the signed-in user's brokerage for an ads-lane server action;
 * refuse when unauthenticated or tenant-less. Survivor for two byte-identical
 * private `requireActor` copies (SAME BODY census round 3, 2026-09-09):
 * app/actions/chatgpt-ads.ts:31 and app/actions/ctv-ads.ts:24. The chatgpt-ads
 * copy's own comment said it was "Copied ... per instruction — not imported,
 * so this file's session gate stands on its own"; §6 (one vocabulary) now
 * supersedes that — a THIRD ads lane duplicating this exact body is the
 * failure mode that instruction invited.
 */
export async function requireAdsActor(): Promise<{ actor?: AdsSessionActor; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  const { data: profile, error } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (error) return { error: error.message }
  if (!profile?.brokerage_id) return { error: "No brokerage on this account" }
  return { actor: { userId: user.id, brokerageId: profile.brokerage_id } }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE COPIES THIS SURVIVOR REPLACES — measured 2026-09-03, `function requireCaller`
// under app/actions/**. NOT folded in this wave: other lanes hold app/actions/**.
// Each line is the copy's definition site; "+" marks what it carries beyond the
// shared shape (compose it at the call site per the header).
// ═══════════════════════════════════════════════════════════════════════════
//   app/actions/ai-identity.ts:17                    + teamId; defaults user_type to "agent"
//   app/actions/ai-listing-packet.ts:19
//   app/actions/ai-lead-nurturing.ts:19
//   app/actions/referrals/referral-appreciation.ts:28  returns null instead of {ok:false}; + teamId
//   app/actions/video/create-video-project.ts:48       checks error
//   app/actions/video/memory-video.ts:42               checks error
//   app/actions/video/generate-script.ts:118           checks error
//   app/actions/onboarding/mentor-session.ts:14        checks error; + supabase; userType String(?? "")
//   app/actions/onboarding/daily-plan.ts:24            checks error; + supabase; userType String(?? "")
//   app/actions/email-campaigns.ts:40                  checks error
//   app/actions/lead-intelligence.ts:68
//   app/actions/ai-lead-scoring.ts:19
//   app/actions/seller-decision-governance.ts:49       checks error; brokerage_id MAY be null (→ resolveCallerIdentity)
//   app/actions/ai-insights.ts:23                      defaults user_type to "agent"
//   app/actions/multi-persona.ts:22                    defaults user_type to "agent"
//   app/actions/offers/present-to-seller.ts:55         checks error
//   app/actions/career-tier.ts:22                      checks error; + supabase; userType String(?? "")
//   app/actions/business-card/business-card-actions.ts:16  + agentId (agents.id via agents.user_id)
//   app/actions/content-studio.ts:10                   via getAgentContext (different seam — leave)
//   app/actions/ai-isa.ts:41
//   app/actions/link-to-video.ts:32
//   app/actions/tour-planner.ts:24
//   app/actions/ai-market-intelligence.ts:17
//   app/actions/seller-showings.ts:15
//   app/actions/seller-open-house.ts:28                + agentId (agents.id via agents.user_id)
//   app/actions/ai-listing-presentation.ts:23
//   app/actions/listings.ts:38                         via resolveActingContext (impersonation seam — leave)
//   app/actions/ai-communication-hub.ts:31             + agentId (agents.id via agents.user_id)
//   app/actions/seller-offers.ts:27
//   app/actions/buyer-fatigue.ts:14
//   app/actions/video-repurposing.ts:28
//   app/actions/video-generation.ts:68
