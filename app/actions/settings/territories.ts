"use server"

/**
 * app/actions/settings/territories.ts   (Settings → Territories)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SURFACE THAT OWNS subscriber_service_areas.
 *
 * ── WHAT WAS BROKEN ─────────────────────────────────────────────────────────
 * "Settings sets territories covered" was not true anywhere in this codebase.
 * subscriber_service_areas — the per-zip roster lib/platform/distribution-engine.ts
 * routes every platform lead through — had exactly ONE writer:
 * syncServiceAreasForMarket in app/actions/lead-scraping-config.ts, which runs as
 * a side effect of creating a lead-SCRAPING market. Its own comment admitted the
 * hole it left:
 *
 *     agent_user_id: null, // brokerage-level territory claim; agent claims come later
 *
 * So agent_user_id was ALWAYS null, team_id only ever inherited whatever the
 * market happened to carry, and is_primary was ALWAYS false. Three columns of
 * grain that the schema declares and no code has ever populated.
 *
 * MEASURED on the live database before writing this: subscriber_service_areas
 * holds 0 rows, and lead_scraping_markets holds 0 rows. Not sparse — EMPTY. The
 * only door was a side door, and nobody had walked through it.
 *
 * ── THE TENANT COMES FROM THE SESSION ───────────────────────────────────────
 * Every function here calls supabase.auth.getUser() and resolves brokerage_id
 * from the users row. No function takes a brokerageId, a teamId-as-tenant, or any
 * other caller-supplied tenancy. requireBrokerageAdmin (lib/auth/require-brokerage-admin.ts)
 * is the ONE brokerage-admin test — not a re-implemented user_type check.
 *
 * ── THE GRAIN GATE IS A FACT, NOT A LABEL ───────────────────────────────────
 * A team lead is someone whose id is in teams.team_lead_id. That is the record.
 * There is no user_type='team_lead' test here, because a role label is a claim
 * about a person and team_lead_id is the fact of which team they lead.
 *
 * ── RLS VERDICT: THE SESSION CLIENT IS ENOUGH ───────────────────────────────
 * MEASURED: subscriber_service_areas has RLS on with four per-command policies for
 * `authenticated`, each `brokerage_id = current_user_brokerage_id()` (SELECT/DELETE
 * USING, INSERT WITH CHECK, UPDATE both). A session client can read and write this
 * table for its own tenant, so NOTHING in this file reaches for a service client.
 * What RLS does not do is separate grains inside one tenant — that is this file's
 * job, sitting inside the database's boundary rather than past it.
 *
 * ── EVERY READ CHECKS error ─────────────────────────────────────────────────
 * supabase-js RESOLVES a failed query. An unchecked read reports a permission
 * denial as "not there" — which, in the old check-then-insert sync, meant a
 * refused read produced a DUPLICATE INSERT. And a zero-row RLS refusal on UPDATE
 * arrives as error:null, so every update here ends `.select("id")` and counts the
 * rows it actually changed.
 */

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { requireBrokerageAdmin } from "@/lib/auth/require-brokerage-admin"
import {
  authorizeTerritoryWrite,
  feedsPlatformRotation,
  grainOf,
  parseZipInput,
  resolveGrainColumns,
  ZIP_RE,
  TERRITORY_GRAINS,
  type TerritoryGrain,
  type TerritoryViewer,
} from "@/app/dashboard/settings/territories/territory-rules"

const SETTINGS_PATH = "/dashboard/settings/territories"

export interface TerritoryClaim {
  id: string
  zipCode: string
  city: string | null
  state: string | null
  grain: TerritoryGrain
  teamId: string | null
  teamName: string | null
  agentUserId: string | null
  agentName: string | null
  isPrimary: boolean
  active: boolean
  joinedAt: string | null
  /** True only for an active brokerage-grain row — the platform rotation reads nothing else. */
  feedsRotation: boolean
}

export interface TerritorySettingsView {
  ok: boolean
  error?: string
  viewer: {
    userId: string
    brokerageId: string
    isBrokerageAdmin: boolean
    ledTeamIds: string[]
    /** Grains this viewer may create at all — drives which controls render. */
    writableGrains: TerritoryGrain[]
  } | null
  claims: TerritoryClaim[]
  teams: Array<{ id: string; name: string; isLed: boolean }>
  agents: Array<{ id: string; name: string }>
}

const EMPTY_VIEW: TerritorySettingsView = { ok: false, viewer: null, claims: [], teams: [], agents: [] }

// ─────────────────────────────────────────────────────────────────────────────
// SESSION → VIEWER. The single place tenancy is decided.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { supabase: Awaited<ReturnType<typeof createClient>>; viewer: TerritoryViewer }

async function resolveViewer(): Promise<{ ok: true; ctx: Ctx } | { ok: false; error: string }> {
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError) return { ok: false, error: `Could not read your session: ${authError.message}` }
  const user = auth?.user
  if (!user) return { ok: false, error: "Not signed in." }

  // requireBrokerageAdmin THROWS on refusal. A refusal is not an error here — a
  // team lead and an agent are both legitimate callers with a narrower grain — so
  // the throw is caught and turned into isBrokerageAdmin:false. But the tenant
  // still has to be resolved for those callers, hence the explicit read below.
  let isBrokerageAdmin = false
  try {
    await requireBrokerageAdmin(supabase as never, user.id)
    isBrokerageAdmin = true
  } catch {
    isBrokerageAdmin = false
  }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (profileError) return { ok: false, error: `Could not resolve your brokerage: ${profileError.message}` }

  const brokerageId = (profile as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  if (!brokerageId) return { ok: false, error: "Your account is not attached to a brokerage." }

  // THE FACT: teams this user actually leads. Not a role label.
  const { data: ledTeams, error: ledError } = await supabase
    .from("teams")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("team_lead_id", user.id)
    .is("deleted_at", null)
  if (ledError) return { ok: false, error: `Could not resolve the teams you lead: ${ledError.message}` }

  return {
    ok: true,
    ctx: {
      supabase,
      viewer: {
        userId: user.id,
        brokerageId,
        isBrokerageAdmin,
        ledTeamIds: ((ledTeams ?? []) as Array<{ id: string }>).map((t) => t.id),
      },
    },
  }
}

function writableGrainsFor(viewer: TerritoryViewer): TerritoryGrain[] {
  // The full-roster branch reads the ONE grain roster (§6) instead of restating
  // ["brokerage","team","agent"] — a grain added to territory-rules.ts now
  // reaches the admin's controls without a second edit here.
  if (viewer.isBrokerageAdmin) return [...TERRITORY_GRAINS]
  const grains: TerritoryGrain[] = ["agent"]
  if (viewer.ledTeamIds.length > 0) grains.unshift("team")
  return grains
}

// ─────────────────────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────────────────────

export async function getTerritorySettings(): Promise<TerritorySettingsView> {
  const resolved = await resolveViewer()
  if (!resolved.ok) return { ...EMPTY_VIEW, error: resolved.error }
  const { supabase, viewer } = resolved.ctx

  // No select("*") and no select("*") inside an embed: name every column, and
  // resolve team/agent labels with separate scoped reads rather than an embed,
  // because subscriber_service_areas carries no FK to teams or users (MEASURED —
  // scripts/schema-fk-map.ts records only brokerage_id → brokerages), so an embed
  // would not resolve at all.
  const { data: rows, error: rowsError } = await supabase
    .from("subscriber_service_areas")
    .select("id, zip_code, city, state, team_id, agent_user_id, is_primary, active, joined_at")
    .eq("brokerage_id", viewer.brokerageId)
    .order("active", { ascending: false })
    .order("zip_code", { ascending: true })
  if (rowsError) return { ...EMPTY_VIEW, error: `Could not load your territories: ${rowsError.message}` }

  const { data: teamRows, error: teamsError } = await supabase
    .from("teams")
    .select("id, name, team_lead_id")
    .eq("brokerage_id", viewer.brokerageId)
    .is("deleted_at", null)
    .order("name", { ascending: true })
  if (teamsError) return { ...EMPTY_VIEW, error: `Could not load teams: ${teamsError.message}` }

  const { data: userRows, error: usersError } = await supabase
    .from("users")
    .select("id, first_name, last_name, email")
    .eq("brokerage_id", viewer.brokerageId)
    .is("deleted_at", null)
    .order("last_name", { ascending: true })
  if (usersError) return { ...EMPTY_VIEW, error: `Could not load people: ${usersError.message}` }

  const teams = ((teamRows ?? []) as Array<{ id: string; name: string | null; team_lead_id: string | null }>).map((t) => ({
    id: t.id,
    name: t.name?.trim() || "Untitled team",
    isLed: t.team_lead_id === viewer.userId,
  }))
  const teamNameById = new Map(teams.map((t) => [t.id, t.name]))

  const agents = ((userRows ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>)
    .map((u) => ({
      id: u.id,
      name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || u.id.slice(0, 8),
    }))
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]))

  const claims: TerritoryClaim[] = ((rows ?? []) as Array<{
    id: string
    zip_code: string
    city: string | null
    state: string | null
    team_id: string | null
    agent_user_id: string | null
    is_primary: boolean | null
    active: boolean | null
    joined_at: string | null
  }>).map((r) => ({
    id: r.id,
    zipCode: r.zip_code,
    city: r.city,
    state: r.state,
    grain: grainOf(r),
    teamId: r.team_id,
    teamName: r.team_id ? teamNameById.get(r.team_id) ?? null : null,
    agentUserId: r.agent_user_id,
    agentName: r.agent_user_id ? agentNameById.get(r.agent_user_id) ?? null : null,
    isPrimary: r.is_primary === true,
    active: r.active !== false,
    joinedAt: r.joined_at,
    feedsRotation: feedsPlatformRotation(r),
  }))

  return {
    ok: true,
    viewer: {
      userId: viewer.userId,
      brokerageId: viewer.brokerageId,
      isBrokerageAdmin: viewer.isBrokerageAdmin,
      ledTeamIds: viewer.ledTeamIds,
      writableGrains: writableGrainsFor(viewer),
    },
    claims,
    teams,
    agents,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE — add
// ─────────────────────────────────────────────────────────────────────────────

export interface AddTerritoryResult {
  success: boolean
  error?: string
  added: string[]
  alreadyClaimed: string[]
  reactivated: string[]
  rejected: string[]
}

const EMPTY_ADD: AddTerritoryResult = { success: false, added: [], alreadyClaimed: [], reactivated: [], rejected: [] }

export async function addTerritoryZips(input: {
  zips: string
  grain: TerritoryGrain
  teamId?: string | null
  agentUserId?: string | null
  city?: string | null
  state?: string | null
}): Promise<AddTerritoryResult> {
  const resolved = await resolveViewer()
  if (!resolved.ok) return { ...EMPTY_ADD, error: resolved.error }
  const { supabase, viewer } = resolved.ctx

  const columns = resolveGrainColumns(input.grain, { teamId: input.teamId, agentUserId: input.agentUserId })
  if (!columns.ok) return { ...EMPTY_ADD, error: columns.reason }

  const verdict = authorizeTerritoryWrite(viewer, {
    grain: input.grain,
    teamId: columns.columns.team_id,
    agentUserId: columns.columns.agent_user_id,
  })
  if (!verdict.ok) return { ...EMPTY_ADD, error: verdict.reason }

  // A team or agent named in the request must belong to THIS tenant. RLS would
  // stop a cross-tenant brokerage_id, but team_id and agent_user_id are plain
  // uuid columns with no FK (MEASURED) — nothing in the database stops a claim
  // being filed against another tenant's team id, so this is checked here.
  if (columns.columns.team_id) {
    const { data: team, error: teamError } = await supabase
      .from("teams")
      .select("id")
      .eq("id", columns.columns.team_id)
      .eq("brokerage_id", viewer.brokerageId)
      .is("deleted_at", null)
      .maybeSingle()
    if (teamError) return { ...EMPTY_ADD, error: `Could not verify that team: ${teamError.message}` }
    if (!team) return { ...EMPTY_ADD, error: "That team is not in your brokerage." }
  }
  if (columns.columns.agent_user_id) {
    // agent_user_id is a users.id — never an agents.id. Verified against users.
    const { data: person, error: personError } = await supabase
      .from("users")
      .select("id")
      .eq("id", columns.columns.agent_user_id)
      .eq("brokerage_id", viewer.brokerageId)
      .maybeSingle()
    if (personError) return { ...EMPTY_ADD, error: `Could not verify that person: ${personError.message}` }
    if (!person) return { ...EMPTY_ADD, error: "That person is not in your brokerage." }
  }

  const { zips, rejected } = parseZipInput(input.zips)
  // REFUSE, do not silently drop. The market sync's `.filter(/^\d{5}$/)` swallowed
  // a typo and claimed nothing; a person who typed "9021" deserves to be told.
  if (rejected.length > 0) {
    return { ...EMPTY_ADD, rejected, error: `Not five-digit ZIPs: ${rejected.join(", ")}. Nothing was saved.` }
  }
  if (zips.length === 0) return { ...EMPTY_ADD, error: "Enter at least one five-digit ZIP." }

  const city = input.city?.trim() || null
  const state = input.state?.trim()?.toUpperCase() || null

  const added: string[] = []
  const alreadyClaimed: string[] = []
  const reactivated: string[] = []

  for (const zip of zips) {
    let existingQuery = supabase
      .from("subscriber_service_areas")
      .select("id, active")
      .eq("brokerage_id", viewer.brokerageId)
      .eq("zip_code", zip)
    existingQuery = columns.columns.team_id
      ? existingQuery.eq("team_id", columns.columns.team_id)
      : existingQuery.is("team_id", null)
    existingQuery = columns.columns.agent_user_id
      ? existingQuery.eq("agent_user_id", columns.columns.agent_user_id)
      : existingQuery.is("agent_user_id", null)

    const { data: existing, error: existingError } = await existingQuery.maybeSingle()
    // A refused read is NOT "not there". The old sync dropped this error and
    // inserted a duplicate on every refusal.
    if (existingError) return { ...EMPTY_ADD, added, alreadyClaimed, reactivated, error: `Could not check ${zip}: ${existingError.message}` }

    if (existing) {
      const row = existing as { id: string; active: boolean | null }
      if (row.active !== false) { alreadyClaimed.push(zip); continue }
      const { data: revived, error: reviveError } = await supabase
        .from("subscriber_service_areas")
        .update({ active: true, city, state, joined_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("brokerage_id", viewer.brokerageId)
        .select("id")
      // A zero-row RLS refusal on UPDATE arrives as error:null — count the rows.
      if (reviveError) return { ...EMPTY_ADD, added, alreadyClaimed, reactivated, error: `Could not re-open ${zip}: ${reviveError.message}` }
      if (!revived || revived.length === 0) {
        return { ...EMPTY_ADD, added, alreadyClaimed, reactivated, error: `Re-opening ${zip} changed no rows — you may not have permission.` }
      }
      reactivated.push(zip)
      continue
    }

    const { data: inserted, error: insertError } = await supabase
      .from("subscriber_service_areas")
      .insert({
        brokerage_id: viewer.brokerageId,
        team_id: columns.columns.team_id,
        agent_user_id: columns.columns.agent_user_id,
        zip_code: zip,
        city,
        state,
        is_primary: false,
        active: true,
        joined_at: new Date().toISOString(),
      })
      .select("id")
    if (insertError) {
      // 23505 = the partial unique index for this grain fired (m462). That means a
      // concurrent writer — the market sync, or another admin — won the race. This
      // is the outcome we WANT: the row exists exactly once. Report it as claimed,
      // not as a failure.
      if (String((insertError as { code?: string }).code) === "23505") { alreadyClaimed.push(zip); continue }
      return { ...EMPTY_ADD, added, alreadyClaimed, reactivated, error: `Could not claim ${zip}: ${insertError.message}` }
    }
    if (!inserted || inserted.length === 0) {
      return { ...EMPTY_ADD, added, alreadyClaimed, reactivated, error: `Claiming ${zip} wrote no row — you may not have permission.` }
    }
    added.push(zip)
  }

  revalidatePath(SETTINGS_PATH)
  return { success: true, added, alreadyClaimed, reactivated, rejected: [] }
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE — deactivate / reactivate (never hard-delete)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load a claim the caller is allowed to touch, or say why not. Every mutation
 * below goes through this, so the grain gate cannot be skipped by passing an id.
 */
async function loadWritableClaim(ctx: Ctx, claimId: string) {
  const { supabase, viewer } = ctx
  if (!claimId || typeof claimId !== "string") return { ok: false as const, error: "Missing territory id." }

  const { data: row, error } = await supabase
    .from("subscriber_service_areas")
    .select("id, zip_code, team_id, agent_user_id, active, is_primary")
    .eq("id", claimId)
    .eq("brokerage_id", viewer.brokerageId)
    .maybeSingle()
  if (error) return { ok: false as const, error: `Could not load that territory: ${error.message}` }
  if (!row) return { ok: false as const, error: "That territory is not in your brokerage." }

  const claim = row as { id: string; zip_code: string; team_id: string | null; agent_user_id: string | null; active: boolean | null; is_primary: boolean | null }
  const verdict = authorizeTerritoryWrite(viewer, {
    grain: grainOf(claim),
    teamId: claim.team_id,
    agentUserId: claim.agent_user_id,
  })
  if (!verdict.ok) return { ok: false as const, error: verdict.reason }
  return { ok: true as const, claim }
}

export async function setTerritoryActive(claimId: string, active: boolean): Promise<{ success: boolean; error?: string }> {
  const resolved = await resolveViewer()
  if (!resolved.ok) return { success: false, error: resolved.error }
  const { supabase, viewer } = resolved.ctx

  const loaded = await loadWritableClaim(resolved.ctx, claimId)
  if (!loaded.ok) return { success: false, error: loaded.error }

  // Deactivate, never DELETE. The market sync already keeps history this way on
  // market delete, and history is the point: a zip that was covered last quarter
  // explains last quarter's lead routing.
  const patch: { active: boolean; is_primary?: boolean } = { active }
  // A retired territory cannot stay the primary one. m462's partial primary
  // indexes are scoped `WHERE is_primary AND active`, so a stale primary on an
  // inactive row would silently block the next primary from being set.
  if (!active && loaded.claim.is_primary) patch.is_primary = false

  const { data: updated, error } = await supabase
    .from("subscriber_service_areas")
    .update(patch)
    .eq("id", loaded.claim.id)
    .eq("brokerage_id", viewer.brokerageId)
    .select("id")
  if (error) return { success: false, error: `Could not update that territory: ${error.message}` }
  if (!updated || updated.length === 0) {
    return { success: false, error: "That change affected no rows — you may not have permission." }
  }

  revalidatePath(SETTINGS_PATH)
  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE — primary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark one active claim as the claimant's primary zip, clearing the previous one
 * at the SAME grain first. m462 enforces at-most-one primary per claimant per
 * grain, so clearing first is not politeness — an unclear write raises 23505.
 */
export async function setTerritoryPrimary(claimId: string): Promise<{ success: boolean; error?: string }> {
  const resolved = await resolveViewer()
  if (!resolved.ok) return { success: false, error: resolved.error }
  const { supabase, viewer } = resolved.ctx

  const loaded = await loadWritableClaim(resolved.ctx, claimId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const claim = loaded.claim

  if (claim.active === false) return { success: false, error: "Re-open this territory before making it primary." }
  if (!ZIP_RE.test(claim.zip_code)) return { success: false, error: `Stored ZIP "${claim.zip_code}" is not five digits — fix the row before making it primary.` }

  // Clear the previous primary at this grain only. `.neq("id", …)` keeps the
  // target row out of the clear so the two writes cannot fight.
  let clearQuery = supabase
    .from("subscriber_service_areas")
    .update({ is_primary: false })
    .eq("brokerage_id", viewer.brokerageId)
    .eq("is_primary", true)
    .neq("id", claim.id)
  clearQuery = claim.team_id ? clearQuery.eq("team_id", claim.team_id) : clearQuery.is("team_id", null)
  clearQuery = claim.agent_user_id ? clearQuery.eq("agent_user_id", claim.agent_user_id) : clearQuery.is("agent_user_id", null)

  // No row-count assertion here on purpose: clearing zero rows is the CORRECT
  // and common outcome (there was no previous primary). Only `error` is a fault.
  const { error: clearError } = await clearQuery.select("id")
  if (clearError) return { success: false, error: `Could not clear the previous primary: ${clearError.message}` }

  const { data: updated, error } = await supabase
    .from("subscriber_service_areas")
    .update({ is_primary: true })
    .eq("id", claim.id)
    .eq("brokerage_id", viewer.brokerageId)
    .select("id")
  if (error) return { success: false, error: `Could not set the primary territory: ${error.message}` }
  if (!updated || updated.length === 0) {
    return { success: false, error: "Setting the primary territory affected no rows — you may not have permission." }
  }

  revalidatePath(SETTINGS_PATH)
  return { success: true }
}
