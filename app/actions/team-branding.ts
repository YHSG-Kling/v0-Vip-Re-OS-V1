"use server"

/**
 * app/actions/team-branding.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MISSING WRITER for a team's own brand.
 *
 * The owner's ruling is "teams also may have a different logo than the
 * brokerage." That capability was already BUILT and already WIRED:
 * `lib/branding/resolve-brand-context.ts:211` cascades
 *
 *     team.logo_url → brokerages.logo_url → global_settings.app_logo_url
 *
 * per ATTRIBUTE (not per row), and every rendered piece — postcard, portal,
 * email, marketing image — reads that one resolver. `teams.logo_url`,
 * `primary_color`, `accent_color`, `tagline`, `website` and `phone` all exist on
 * the live table, and `lib/onboarding/setup-readiness.ts:210` already tells a
 * team lead to "Set your team logo & colors".
 *
 * NOTHING WROTE ANY OF THEM. Every `from("teams")` call in `app/` and `lib/` was
 * a SELECT. The columns were reachable only by hand-editing the database, so the
 * required setup task pointed at a page that redirected to user management and
 * the cascade's top rung was permanently empty. The gap was the SCREEN, not the
 * capability.
 *
 * So this module adds the writer and NOTHING else. It does not re-derive the
 * cascade: the "what you inherit when you leave this blank" values the panel
 * shows come from calling `resolveBrandContext` itself with `teamId: null`,
 * which is by definition the answer the real resolver gives with no team on top.
 * A second copy of the precedence rules here is exactly the duplicate this
 * workstream keeps deleting.
 *
 * ── WHO MAY WRITE ───────────────────────────────────────────────────────────
 * `teams` RLS UPDATE, read from pg_policies on the live database:
 *
 *     teams_tenant_update  USING      (brokerage_id = current_user_brokerage_id())
 *                          WITH CHECK (brokerage_id = current_user_brokerage_id())
 *
 * That is TENANT-WIDE with no role test and no lead test — the database lets ANY
 * authenticated user rebrand ANY team in their own brokerage. That is wider than
 * the ruling, so this module is deliberately NARROWER than RLS and the gate here
 * is the real constraint:
 *
 *   - a TEAM LEAD may write the team they lead, and the team id is resolved from
 *     the SESSION by `resolveLedTeamId` — never taken from the caller.
 *   - a BROKERAGE ADMIN (`is_brokerage_admin()` = user_type in admin/broker/
 *     broker_owner) may write any team in their OWN brokerage, which is what RLS
 *     already permits. There is no session-derivable single team for an admin who
 *     runs several, so that path is the only one that reads a teamId off the
 *     wire — and it does not TRUST it: the tenant comes from the session, the row
 *     is re-read, and `brokerage_id` must match before a single column is written.
 *   - everyone else is refused, even though the database would allow them.
 *
 * Leading a team is a FACT (`teams.team_lead_id = <me>`), never
 * `user_type === 'team_lead'`. On the live data that label is INVERTED on both
 * accounts that carry it: teamlead@vip.demo is user_type='agent' and leads one
 * team, buyer@yourbrokerage.com is user_type='team_lead' and leads none. A role
 * label is not a fact; the FK is. Hence `resolveLedTeamId`.
 *
 * Writes go through the SESSION client, so RLS still applies underneath the app
 * gate and this can never exceed what the database permits. supabase-js RESOLVES
 * a refused write and an RLS refusal on UPDATE is ZERO ROWS with `error: null`,
 * so every write confirms itself with `.select("id")` and a length check. A
 * "Saved" toast over a write that touched nothing is the defect class this repo
 * keeps finding.
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { resolveLedTeamId } from "@/lib/kernel/resolve-user-team"
import { resolveBrandContext } from "@/lib/branding/resolve-brand-context"
import { revalidatePath } from "next/cache"

/**
 * THE ALLOW-LIST. `teams` also carries tenancy (`brokerage_id`, `team_lead_id`),
 * identity (`name`, `public_slug`) and MONEY (`team_split_type`,
 * `team_split_value`, `team_fees_json`, `member_overrides_json`). A settings
 * action that spread a client payload into an update would let a team lead
 * rewrite their own split. Only these seven columns are ever written here.
 */
const TEAM_BRAND_COLUMNS = [
  "logo_url",
  "primary_color",
  "accent_color",
  "tagline",
  "website",
  "phone",
  "bio_text",
] as const

export interface TeamBrandValues {
  logoUrl: string | null
  primaryColor: string | null
  accentColor: string | null
  tagline: string | null
  website: string | null
  phone: string | null
  bioText: string | null
}

export interface TeamBrandOption {
  id: string
  name: string
  /** True when the caller is this team's `team_lead_id`. */
  isLed: boolean
  values: TeamBrandValues
}

/** What the piece looks like RIGHT NOW, and what it falls back to when blank.
 *  Both come from `resolveBrandContext`, never from a second cascade here. */
export interface TeamBrandCascade {
  /** Resolved with NO team on top — i.e. exactly what a blank field inherits. */
  inherited: {
    logoUrl: string | null
    primaryColor: string
    accentColor: string
    tagline: string | null
    website: string | null
    phone: string | null
  }
  /** Resolved WITH the active team — what the pieces render today. */
  effective: {
    logoUrl: string | null
    primaryColor: string
    accentColor: string
    tagline: string | null
    displayName: string
    /** The resolver's own audit trail: which tier supplied each field. */
    logoSource: string
    colorSource: string
    taglineSource: string
  }
  brokerageName: string
}

export type TeamBrandAccess = "lead" | "admin" | "none"

export interface TeamBrandingSnapshot {
  ok: boolean
  error?: string
  access: TeamBrandAccess
  teams: TeamBrandOption[]
  activeTeamId: string | null
  cascade: TeamBrandCascade | null
}

/** `is_brokerage_admin()` in SQL — the same three types the brokerages policy uses. */
function isBrokerageAdmin(userType: string): boolean {
  return ["admin", "broker", "broker_owner"].includes(userType)
}

const EMPTY_SNAPSHOT: TeamBrandingSnapshot = {
  ok: true,
  access: "none",
  teams: [],
  activeTeamId: null,
  cascade: null,
}

function rowToValues(row: Record<string, unknown>): TeamBrandValues {
  return {
    logoUrl: (row.logo_url as string | null) ?? null,
    primaryColor: (row.primary_color as string | null) ?? null,
    accentColor: (row.accent_color as string | null) ?? null,
    tagline: (row.tagline as string | null) ?? null,
    website: (row.website as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    bioText: (row.bio_text as string | null) ?? null,
  }
}

// ── Validation ───────────────────────────────────────────────────────────────
// A malformed value here does not fail loudly — it flows straight out through
// the cascade onto every postcard, email header and public team page, where a
// broken <img> is the first anyone hears of it. So it is refused at the door.

type FieldResult = { ok: true; value: string | null } | { ok: false; error: string }

/** An ABSOLUTE http(s) URL, or null for "inherit". Nothing else. */
function normalizeUrl(raw: string, label: string): FieldResult {
  const t = raw.trim()
  if (!t) return { ok: true, value: null }
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return { ok: false, error: `${label} must be a full web address starting with https:// — "${t}" is not one.` }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `${label} must start with http:// or https:// — "${u.protocol}" is not a web address.` }
  }
  if (!u.hostname || (!u.hostname.includes(".") && u.hostname !== "localhost")) {
    return { ok: false, error: `${label} is missing a domain name — "${t}" will not load anywhere.` }
  }
  return { ok: true, value: u.toString() }
}

/** `#rgb` or `#rrggbb`, lower-cased, or null for "inherit". */
function normalizeHex(raw: string, label: string): FieldResult {
  const t = raw.trim()
  if (!t) return { ok: true, value: null }
  const withHash = t.startsWith("#") ? t : `#${t}`
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(withHash)) {
    return { ok: false, error: `${label} must be a hex colour like #1d4ed8 — "${t}" is not one.` }
  }
  return { ok: true, value: withHash.toLowerCase() }
}

function normalizeText(raw: string, label: string, max: number): FieldResult {
  const t = raw.trim().replace(/\s+/g, " ")
  if (!t) return { ok: true, value: null }
  if (t.length > max) {
    return { ok: false, error: `${label} is ${t.length} characters; the limit is ${max}.` }
  }
  return { ok: true, value: t }
}

function normalizeParagraph(raw: string, label: string, max: number): FieldResult {
  const t = raw.trim()
  if (!t) return { ok: true, value: null }
  if (t.length > max) {
    return { ok: false, error: `${label} is ${t.length} characters; the limit is ${max}.` }
  }
  return { ok: true, value: t }
}

// ── Gate ─────────────────────────────────────────────────────────────────────

interface Gate {
  ok: true
  userId: string
  brokerageId: string
  ledTeamId: string | null
  admin: boolean
  access: TeamBrandAccess
  supabase: Awaited<ReturnType<typeof createClient>>
}

async function gate(): Promise<Gate | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
    return { ok: false, error: "Not authenticated." }
  }
  const supabase = await createClient()
  // THE FACT, not the label. resolveLedTeamId reads teams.team_lead_id and logs
  // a refused read rather than reporting it as "leads nobody".
  const ledTeamId = await resolveLedTeamId(supabase, ctx.userId)
  const admin = isBrokerageAdmin(ctx.userType ?? ctx.role ?? "")
  const access: TeamBrandAccess = ledTeamId ? "lead" : admin ? "admin" : "none"
  return { ok: true, userId: ctx.userId, brokerageId: ctx.brokerageId, ledTeamId, admin, access, supabase }
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Everything the panel renders: the teams this caller may brand, their current
 * values, and — so "blank" reads as "inherit" rather than "nothing" — what the
 * brokerage supplies underneath.
 *
 * Called by `app/dashboard/settings/components/team-branding-panel.tsx`, which
 * renders on `/dashboard/settings/teams`.
 */
export async function loadTeamBranding(): Promise<TeamBrandingSnapshot> {
  const g = await gate()
  if (!g.ok) return { ...EMPTY_SNAPSHOT, ok: false, error: g.error }
  if (g.access === "none") return EMPTY_SNAPSHOT

  const select = `id, name, team_lead_id, ${TEAM_BRAND_COLUMNS.join(", ")}`

  // A LEAD gets exactly their own team. An ADMIN gets their brokerage's teams —
  // scoped by brokerage_id in the query as well as by RLS, because `NULL =
  // <uuid>` is NULL and an untenanted team must not appear in anybody's list.
  const query = g.ledTeamId
    ? g.supabase.from("teams").select(select).eq("id", g.ledTeamId)
    : g.supabase.from("teams").select(select).eq("brokerage_id", g.brokerageId).is("deleted_at", null).order("name")

  const { data, error } = await query
  if (error) {
    // supabase-js resolves a refused read as an empty list. Say what happened.
    return { ...EMPTY_SNAPSHOT, ok: false, access: g.access, error: `Could not read your teams: ${error.message}` }
  }

  // Two-step cast, and it is not laziness. `select` above is BUILT AT RUNTIME
  // from TEAM_BRAND_COLUMNS, so supabase-js cannot resolve the column list
  // statically and degrades `data` to GenericStringError[] — a type that does
  // not overlap Record<string, unknown>, which is why the direct cast is a
  // compile error rather than a warning. Going through `unknown` states plainly
  // that the shape is known to us and not to the compiler. The alternative —
  // inlining a literal select so the generated types apply — would fork the
  // column list away from TEAM_BRAND_COLUMNS, and the write path uses that same
  // constant; two lists that must agree is the drift this repo keeps paying for.
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  const teams: TeamBrandOption[] = rows.map((r) => ({
    id: r.id as string,
    name: (r.name as string | null) ?? "Untitled team",
    isLed: (r.team_lead_id as string | null) === g.userId,
    values: rowToValues(r),
  }))

  const activeTeamId = g.ledTeamId ?? teams[0]?.id ?? null
  if (!activeTeamId) {
    return { ok: true, access: g.access, teams, activeTeamId: null, cascade: null }
  }

  // THE CASCADE, from the resolver itself. `teamId: null` IS the inheritance —
  // there is no second copy of the precedence rules in this file.
  const [inheritedCtx, effectiveCtx] = await Promise.all([
    resolveBrandContext({ brokerageId: g.brokerageId, teamId: null }),
    resolveBrandContext({ brokerageId: g.brokerageId, teamId: activeTeamId }),
  ])

  return {
    ok: true,
    access: g.access,
    teams,
    activeTeamId,
    cascade: {
      inherited: {
        logoUrl: inheritedCtx.visual.logoUrl,
        primaryColor: inheritedCtx.visual.primaryColor,
        accentColor: inheritedCtx.visual.accentColor,
        tagline: inheritedCtx.display.tagline,
        website: inheritedCtx.display.websiteWordmark,
        phone: inheritedCtx.display.phone,
      },
      effective: {
        logoUrl: effectiveCtx.visual.logoUrl,
        primaryColor: effectiveCtx.visual.primaryColor,
        accentColor: effectiveCtx.visual.accentColor,
        tagline: effectiveCtx.display.tagline,
        displayName: effectiveCtx.displayName,
        logoSource: effectiveCtx.source.logo,
        colorSource: effectiveCtx.source.color,
        taglineSource: effectiveCtx.source.tagline,
      },
      brokerageName: effectiveCtx.brokerageName,
    },
  }
}

// ── Write ────────────────────────────────────────────────────────────────────

export interface TeamBrandingInput {
  /** ONLY consulted on the brokerage-admin path, and re-authorised against the
   *  session's brokerage before use. A team lead's target is resolved from the
   *  session and this field cannot redirect it. */
  teamId?: string | null
  logoUrl: string
  primaryColor: string
  accentColor: string
  tagline: string
  website: string
  phone: string
  bioText: string
}

export interface SaveTeamBrandingResult {
  success: boolean
  error?: string
  /** Refreshed cascade, so the panel can show the new inherit/override state. */
  snapshot?: TeamBrandingSnapshot
}

/**
 * Write a team's brand. Every field is optional in the sense that BLANK MEANS
 * INHERIT: the column is set to NULL and `resolveBrandContext` falls through to
 * the brokerage, which is the whole point of a per-attribute cascade.
 */
export async function saveTeamBranding(input: TeamBrandingInput): Promise<SaveTeamBrandingResult> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }

  // ── Resolve the TARGET team. Identity first, then authorisation. ──────────
  let targetTeamId: string
  if (g.ledTeamId && (!input.teamId || input.teamId === g.ledTeamId)) {
    // The lead path never reads an id off the wire.
    targetTeamId = g.ledTeamId
  } else if (g.admin && input.teamId) {
    // The admin path does — and immediately re-authorises it against the
    // session's tenant. The id is evidence, not authority.
    const { data: row, error: rowErr } = await g.supabase
      .from("teams")
      .select("id, brokerage_id, deleted_at")
      .eq("id", input.teamId)
      .maybeSingle()
    if (rowErr) return { success: false, error: `Could not verify that team: ${rowErr.message}` }
    const team = row as { id: string; brokerage_id: string | null; deleted_at: string | null } | null
    if (!team) return { success: false, error: "That team does not exist in your brokerage." }
    if (team.brokerage_id !== g.brokerageId) {
      return { success: false, error: "That team belongs to another brokerage." }
    }
    if (team.deleted_at) return { success: false, error: "That team has been deleted." }
    targetTeamId = team.id
  } else if (g.ledTeamId) {
    // Led a team, but asked for a different one without being an admin.
    return { success: false, error: "You can only set the brand for the team you lead." }
  } else {
    return {
      success: false,
      error: "Only a team's lead, or a broker or admin at your brokerage, can set a team's brand.",
    }
  }

  // ── Validate every field before a single column is written. ───────────────
  const patch: Record<(typeof TEAM_BRAND_COLUMNS)[number] | "updated_at", string | null> = {
    logo_url: null,
    primary_color: null,
    accent_color: null,
    tagline: null,
    website: null,
    phone: null,
    bio_text: null,
    updated_at: new Date().toISOString(),
  }

  const checks: Array<[(typeof TEAM_BRAND_COLUMNS)[number], FieldResult]> = []
  checks.push(["logo_url", normalizeUrl(input.logoUrl ?? "", "Team logo URL")])
  checks.push(["website", normalizeUrl(input.website ?? "", "Team website")])
  checks.push(["primary_color", normalizeHex(input.primaryColor ?? "", "Primary colour")])
  checks.push(["accent_color", normalizeHex(input.accentColor ?? "", "Accent colour")])
  checks.push(["tagline", normalizeText(input.tagline ?? "", "Tagline", 160)])
  checks.push(["phone", normalizeText(input.phone ?? "", "Team phone", 32)])
  checks.push(["bio_text", normalizeParagraph(input.bioText ?? "", "Team bio", 2000)])

  for (const [column, result] of checks) {
    if (!result.ok) return { success: false, error: result.error }
    patch[column] = result.value
  }

  // ── Write, and CONFIRM it. ───────────────────────────────────────────────
  // An RLS refusal on UPDATE is zero rows with error: null. Without the
  // .select("id") length check below, a refused save would report success.
  const { data: written, error: writeErr } = await g.supabase
    .from("teams")
    .update(patch)
    .eq("id", targetTeamId)
    .select("id")

  if (writeErr) return { success: false, error: `The database refused the change: ${writeErr.message}` }
  if (!written || written.length === 0) {
    return {
      success: false,
      error:
        "The database accepted the request but changed no rows — your account is not permitted to edit this team. Nothing was saved.",
    }
  }

  // Every surface that reads the cascade: the panel itself, the settings control
  // centre (setup readiness counts hasTeamBrand), and the public team site.
  revalidatePath("/dashboard/settings/teams")
  revalidatePath("/dashboard/settings")

  const snapshot = await loadTeamBranding()
  return { success: true, snapshot }
}
