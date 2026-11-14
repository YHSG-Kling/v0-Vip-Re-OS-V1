/**
 * lib/marketing/qr-governance.ts — THE GOVERNED QR DOORS (wave 152, lane 152C).
 *
 * Owner (verbatim, 2026-11-11): "qr minted bar code has a destination url and each bar code needs is unique and needs
 * tracking, creating one and managing. all mail including letters can have a section that can use a qr bar code."
 *
 * EXTENDS THE ONE REGISTRY — it is not a second one. `qr_codes` stays THE registry, lib/marketing/tracked-qr.ts
 * mintTrackedQr stays its ONE writer of new rows, /api/qr/scan stays THE resolver (scripts/qr-registry-guard.ts §1).
 * What this module adds is the path a PERSON's request takes before it reaches that writer (constitution LAW 4/5):
 *
 *   session actor (the caller's gate: resolveWriteContext — tenant from the SESSION, never a body)
 *     → typed instruction (GovernedQrMintInput / destination edit / lifecycle / duplicate)
 *     → policy: input rules · office/team permission · tenant-scoped campaign/listing · destination safety
 *       (qr-contract.ts validateQrDestination: https, verified tenant hosts + the external allow-list, no loop,
 *       no personal data in the URL) — allow or refuse with the tenant-facing sentence
 *     → the canonical writer (mintTrackedQr / one counted UPDATE)
 *     → withActionLedger evidence (who, why HUMAN_REQUESTED, which tool, what happened; idempotency for the mint)
 *     → readback (the row the write returned, or the ledger's provider_ref on a replay)
 *
 * SERVER-ONLY: every export takes the ALREADY-RESOLVED session actor. The callers are the SESSION gates —
 * app/api/admin/qr-codes/route.ts (create + edit on the board) and app/actions/qr-management.ts (lifecycle,
 * duplicate, activity) — each resolveWriteContext first, then here (CLAUDE.md §4: gate first, then the service client).
 * WAVE 153 (lane 153E): behind that gate every door now also decides the actor's QR AUTHORITY (resolveQrAuthority — a
 * live seat, the solo plan, the hierarchy scope) and the code's / listing's / campaign's place inside it, so a solo
 * subscriber and every authorized seat manage their OWN codes and nobody reaches past their scope.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { withActionLedger, type LedgerClient, type NonActingClaim } from "@/lib/kernel/action-ledger"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
// WAVE 153 (lane 153E): THE hierarchy answer (tenant / offices / teams / own) every QR door's authority is built on.
import { resolveViewerHierarchy } from "@/lib/kernel/resolve-user-office"
import { MAIL_LAYOUT_LIBRARY } from "@/lib/direct-mail/mail-piece-rules"
import { mintTrackedQr, isQrDestinationType, isQrPurpose, normalizeOrigin, type QrDestinationType, type QrPurpose, type MintedTrackedQr } from "./tracked-qr"
import {
  validateQrDestination, qrLifecycleState, appendQrDestinationVersion, classifyQrScan, qrReferrerHost,
  summarizeQrScans, isAbsentColumnRefusal, qrLabelKind, QR_TOKEN_SCOPES, QR_CONSENT_CONTEXTS, QR_PLACEMENT_TYPES, QR_REPEAT_WINDOW_MS,
  QR_RETIRED_REASONS, QR_TRAFFIC_CLASSES, QR_DEVICE_CLASSES,
  type QrMintContext, type QrDestinationVersion, type QrLifecycleState, type QrScanSummary, type QrTokenScope, type QrConsentContext,
  type QrTrafficClass,
} from "./qr-contract"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any }

/** The SESSION actor a gate resolved (resolveWriteContext): tenant, users.id, agents.id (nullable), user_type. */
export interface QrActor {
  brokerageId: string
  userId: string
  agentId: string | null
  userType: string
}

interface QrDoorDeps {
  /** Service client (the gate already ran). */
  client?: Db
  /** The action ledger's client (a proof injects the same in-memory client). */
  ledgerClient?: LedgerClient
  /** The app's own origins (NEXT_PUBLIC_APP_URL + the request origin). */
  appOrigins?: ReadonlyArray<string | null | undefined>
  /** Origin for the scan link the minter builds. */
  origin?: string | null
}

type Refusal = { ok: false; code: "invalid" | "unsafe_destination" | "not_permitted" | "not_found" | "terminal" | "conflict" | "refused" | "in_flight" | "unavailable"; message: string }

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/
/** `<kind>:<id>` is a minter's server-side key namespace (listing:, open_house:, lead_magnet:, …) — a person's label may
 *  not take that shape, or a later automated mint for that entity would find the person's code. */
const GENERATED_KEY_RE = /^(platform:)?[a-z][a-z_]*:/

// ─── tenant hosts (verified custom domains + the declared website) ────────────

/**
 * The hosts a tenant may point a code at as its OWN site: ACTIVE verified custom domains (tenant_custom_domains,
 * status 'active' — lib/platform/custom-domains.ts owns that state) and the website it declared in its brand settings.
 * A refused read returns what it could read — fewer hosts means MORE refusals (fail closed), never fewer.
 */
export async function loadQrTenantHosts(db: Db, brokerageId: string): Promise<{ customDomains: string[]; websiteHosts: string[] }> {
  const customDomains: string[] = []
  const websiteHosts: string[] = []
  const { data: domains, error: dErr } = await db.from("tenant_custom_domains").select("domain, status").eq("brokerage_id", brokerageId).eq("status", "active")
  if (dErr) console.error("[qr-governance] verified domains not read — tenant-site destinations refused:", dErr.message)
  for (const d of (domains ?? []) as Array<{ domain?: string | null }>) if (d.domain) customDomains.push(d.domain.toLowerCase())
  const hostOf = (u: string | null | undefined): string | null => {
    if (!u) return null
    try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase() } catch { return null }
  }
  const { data: brand, error: bErr } = await db.from("brokerage_brand_settings").select("website_url").eq("brokerage_id", brokerageId).maybeSingle()
  if (bErr) console.error("[qr-governance] brand website not read:", bErr.message)
  const { data: firm, error: fErr } = await db.from("brokerages").select("website").eq("id", brokerageId).maybeSingle()
  if (fErr) console.error("[qr-governance] brokerage website not read:", fErr.message)
  for (const h of [hostOf((brand as { website_url?: string | null } | null)?.website_url), hostOf((firm as { website?: string | null } | null)?.website)]) {
    if (h && !websiteHosts.includes(h)) websiteHosts.push(h)
  }
  return { customDomains, websiteHosts }
}

// ─── WHO MAY CREATE AND MANAGE WHICH CODES (wave 153, lane 153E) ──────────────
//
// Owner (verbatim, 2026-11-14): "qr codes can be used by tenant and seat holders. you redid the qr code section for
// brokerage/teams but agents and solo agent tenants use qr codes."
//
// ONE authority for every QR door — the board's list, the mint, the destination edit, the lifecycle, the duplicate, the
// activity panel and the link pickers. It is built from EXISTING facts only (no QR-specific role, product or seat type):
//   · THE SEAT: users.brokerage_id = the session tenant, users.status ≠ 'suspended' and users.deleted_at IS NULL (the
//     seat meter's own rule, lib/kernel/seat-usage.ts), and a producing record that is not deactivated
//     (agents.is_active = false is how lib/agents/agent-deactivation.ts revokes an agent; an account admin whose
//     producing row was retired still administers, filed without an agent record);
//   · THE PLAN: a SOLO-tier subscriber is their own broker — "TIER PARITY", the rule
//     lib/auth/require-caller.ts requireTenantAdminOrSoloOwner already applies — so the whole account is theirs,
//     whatever their user_type says (their one seat often carries 'agent');
//   · otherwise THE hierarchy answer, lib/kernel/resolve-user-office.ts resolveViewerHierarchy (contract C34): a tenant
//     leadership grant or a single-office tenant admin → every code; an office head / office leadership → their
//     offices and those offices' teams; a team lead (teams.team_lead_id) / team leadership → their teams; everyone else
//     → their own work. users.user_type never widens a multi-location row (C34).
// A person ALWAYS manages a code they created and a code filed to their own agent record.
//
// TOMBSTONE (this lane): OFFICE_FILERS (the roster minus team_lead) decided office/team filing by user_type alone — on a
// multi-location tenant an office-A broker could file under office B. SURVIVOR: decideFilingScope below reads the
// authority (hierarchy scope + the person's own team/office), the same answer every other door uses.

interface QrAuthority {
  /** tenant = every code in the account · offices / teams = those scopes · own = what the person created or owns. */
  kind: "tenant" | "offices" | "teams" | "own"
  locationIds: string[]
  teamIds: string[]
  /** The person's own ACTIVE agents.id in this account — null for an admin with no producing record. */
  ownAgentId: string | null
  ownTeamId: string | null
  ownLocationId: string | null
  /** True when the account is on the solo plan (the person is their own broker). */
  solo: boolean
  /** Why — the facts or grants that decided (shown on the board, written on every mint's evidence). */
  basis: string[]
}

type QrAuthorityResult = { ok: true; authority: QrAuthority } | Refusal

const SEAT_OFF = "Your seat in this account is turned off, so QR codes can't be created or changed. Ask an account admin to restore it."
const NOT_YOUR_CODE = "This QR code belongs to someone else. You can change codes you created, codes filed to you, and codes in a team or office you lead — ask the code's creator or an account admin."

/**
 * The SESSION actor's QR authority in ONE account (the actor came from the caller's gate — tenant from the session).
 * Every read's error is READ and any refusal REFUSES (fail closed): "we couldn't tell" never renders as "allowed".
 */
export async function resolveQrAuthority(actor: QrActor, deps: QrDoorDeps = {}): Promise<QrAuthorityResult> {
  const db: Db = deps.client ?? createServiceClient()
  if (!actor?.brokerageId || !actor.userId) return { ok: false, code: "not_permitted", message: "Sign in to an account to use QR codes." }
  const refused: Refusal = { ok: false, code: "refused", message: "We couldn't confirm your seat in this account, so nothing was changed. Try again in a moment." }
  const { data: u, error: uErr } = await db.from("users").select("id, brokerage_id, user_type, status, deleted_at").eq("id", actor.userId).maybeSingle()
  if (uErr) return refused
  const user = u as { brokerage_id?: string | null; user_type?: string | null; status?: string | null; deleted_at?: string | null } | null
  if (!user || user.brokerage_id !== actor.brokerageId) return { ok: false, code: "not_permitted", message: "Your sign-in isn't a seat in this account, so its QR codes aren't available to you." }
  if (user.status === "suspended" || user.deleted_at) return { ok: false, code: "not_permitted", message: SEAT_OFF }
  const { data: ag, error: aErr } = await db.from("agents").select("id, is_active, team_id, location_id").eq("user_id", actor.userId).eq("brokerage_id", actor.brokerageId)
  if (aErr) return refused
  const rows = (ag ?? []) as Array<{ id: string; is_active?: boolean | null; team_id?: string | null; location_id?: string | null }>
  const active = rows.find((r) => r.is_active !== false) ?? null
  const userType = String(user.user_type ?? actor.userType ?? "")
  if (rows.length > 0 && !active && !TENANT_ADMIN_USER_TYPES.has(userType)) return { ok: false, code: "not_permitted", message: SEAT_OFF }
  const h = await resolveViewerHierarchy(db as never, { userId: actor.userId, brokerageId: actor.brokerageId })
  if (!h.ok) return { ok: false, code: "refused", message: "We couldn't confirm which QR codes you manage, so nothing was changed. Try again in a moment." }
  const own = { ownAgentId: active?.id ?? null, ownTeamId: active?.team_id ?? null, ownLocationId: active?.location_id ?? null }
  if (h.tier === "solo_agent") {
    return { ok: true, authority: { kind: "tenant", locationIds: h.scope.locationIds, teamIds: h.scope.teamIds, ...own, solo: true, basis: ["solo plan — the whole account is your own business"] } }
  }
  return { ok: true, authority: { kind: h.scope.kind, locationIds: h.scope.locationIds, teamIds: h.scope.teamIds, ...own, solo: false, basis: h.scope.basis } }
}

/** PURE — does a row (filed to an agent, a team and/or an office) sit inside this authority? */
function withinQrScope(auth: QrAuthority, f: { agentId?: string | null; teamIds: Array<string | null | undefined>; locationIds: Array<string | null | undefined> }): boolean {
  if (auth.kind === "tenant") return true
  if (f.agentId && auth.ownAgentId && f.agentId === auth.ownAgentId) return true
  if (auth.kind === "offices" && f.locationIds.some((id) => !!id && auth.locationIds.includes(id))) return true
  if ((auth.kind === "offices" || auth.kind === "teams") && f.teamIds.some((id) => !!id && auth.teamIds.includes(id))) return true
  return false
}

/** An agent record's placement (team + office), tenant-pinned. A refused read is reported, never "no placement". */
async function readAgentPlacement(db: Db, brokerageId: string, agentId: string): Promise<{ ok: true; team_id: string | null; location_id: string | null } | { ok: false }> {
  const { data, error } = await db.from("agents").select("team_id, location_id").eq("id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false }
  const a = data as { team_id?: string | null; location_id?: string | null } | null
  return { ok: true, team_id: a?.team_id ?? null, location_id: a?.location_id ?? null }
}

/** May this person CHANGE / VIEW this code? Tenant first (another account's code reads as missing — the same answer as a
 *  code that does not exist), then the code's creator, its agent's team/office and its own filing against the authority. */
async function decideCodeAccess(db: Db, actor: QrActor, auth: QrAuthority, qrCodeId: string): Promise<{ ok: true } | Refusal> {
  let { data, error } = await db.from("qr_codes").select("id, agent_id, created_by_user_id, mint_context").eq("id", qrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error && isAbsentColumnRefusal(error)) ({ data, error } = await db.from("qr_codes").select("id, agent_id").eq("id", qrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle())
  if (error) return { ok: false, code: "refused", message: "We couldn't load this code, so nothing was changed. Try again in a moment." }
  if (!data) return { ok: false, code: "not_found", message: "That QR code isn't in your account." }
  const row = data as { agent_id?: string | null; created_by_user_id?: string | null; mint_context?: Partial<QrMintContext> | null }
  if (auth.kind === "tenant" || (row.created_by_user_id && row.created_by_user_id === actor.userId)) return { ok: true }
  const ctx = row.mint_context ?? {}
  let owner: { team_id: string | null; location_id: string | null } = { team_id: null, location_id: null }
  if (row.agent_id && row.agent_id !== auth.ownAgentId) {
    const p = await readAgentPlacement(db, actor.brokerageId, row.agent_id)
    if (!p.ok) return { ok: false, code: "refused", message: "We couldn't confirm who this code belongs to, so nothing was changed. Try again in a moment." }
    owner = p
  }
  return withinQrScope(auth, { agentId: row.agent_id, teamIds: [ctx.team_id, owner.team_id], locationIds: [ctx.location_id, owner.location_id] })
    ? { ok: true }
    : { ok: false, code: "not_permitted", message: NOT_YOUR_CODE }
}

/**
 * The gate a caller runs before a change that has no governed door of its own (the board's name / purpose / end-date
 * edit, app/api/admin/qr-codes PATCH): the seat, then the code's scope. Refusal codes match the doors' own.
 */
export async function authorizeQrCodeChange(qrCodeId: string, actor: QrActor, deps: QrDoorDeps = {}): Promise<{ ok: true; authority: QrAuthority } | Refusal> {
  const db: Db = deps.client ?? createServiceClient()
  if (!qrCodeId) return { ok: false, code: "invalid", message: "Choose the code to change." }
  const auth = await resolveQrAuthority(actor, { ...deps, client: db })
  if (!auth.ok) return auth
  const access = await decideCodeAccess(db, actor, auth.authority, qrCodeId)
  return access.ok ? { ok: true, authority: auth.authority } : access
}

/** PURE — the listing a destination PATH names (`/listings/<uuid>`), so pointing a code at a listing's page is judged
 *  like linking it to that listing. Null for any other path. */
function listingIdInDestination(url: string | null | undefined): string | null {
  if (!url) return null
  let path = url
  try { path = new URL(url, "https://destination.invalid").pathname } catch { return null }
  const m = /^\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(path)
  return m ? m[1].toLowerCase() : null
}

/** PURE — may this person put a code on this listing? Their own listing (agents.id), or one filed to a team / office they
 *  lead (the listing's own team_id / location_id, or its agent's), or any listing when the whole account is theirs. */
function listingOpenToActor(auth: QrAuthority, l: { agent_id?: string | null; team_id?: string | null; location_id?: string | null }, owner: { team_id: string | null; location_id: string | null }): boolean {
  return withinQrScope(auth, { agentId: l.agent_id, teamIds: [l.team_id, owner.team_id], locationIds: [l.location_id, owner.location_id] })
}

/** An agent cannot mint a code onto a listing they cannot edit — another agent's listing is refused with a sentence. */
async function decideListingAccess(db: Db, actor: QrActor, auth: QrAuthority, listingId: string): Promise<{ ok: true } | Refusal> {
  const { data, error } = await db.from("listings").select("id, agent_id, team_id, location_id, deleted_at").eq("id", listingId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error) return { ok: false, code: "refused", message: "We couldn't confirm that listing, so nothing was created. Try again in a moment." }
  if (!data) return { ok: false, code: "not_permitted", message: "That listing isn't in your account. Pick one of your listings." }
  const l = data as { agent_id?: string | null; team_id?: string | null; location_id?: string | null; deleted_at?: string | null }
  if (l.deleted_at) return { ok: false, code: "not_permitted", message: "That listing is archived, so a new code can't point at it. Pick an active listing." }
  let owner: { team_id: string | null; location_id: string | null } = { team_id: null, location_id: null }
  if (auth.kind !== "tenant" && l.agent_id && l.agent_id !== auth.ownAgentId) {
    const p = await readAgentPlacement(db, actor.brokerageId, l.agent_id)
    if (!p.ok) return { ok: false, code: "refused", message: "We couldn't confirm who that listing belongs to, so nothing was created. Try again in a moment." }
    owner = p
  }
  return listingOpenToActor(auth, l, owner)
    ? { ok: true }
    : { ok: false, code: "not_permitted", message: "That listing belongs to another agent. You can create codes for your own listings, or for listings in a team or office you lead — ask the listing agent or your team lead." }
}

/** PURE — may this person attach a code to this campaign? Theirs (agent_user_id / created_by), one shared with the whole
 *  account (visibility_scope brokerage / multi_location / platform — the live column is NOT NULL with DEFAULT 'brokerage',
 *  so an unstated value reads as that default), one shared with a team they belong to or lead, or any when the whole
 *  account is theirs. */
function campaignOpenToActor(auth: QrAuthority, userId: string, c: { agent_user_id?: string | null; created_by?: string | null; team_id?: string | null; visibility_scope?: string | null }): boolean {
  if (auth.kind === "tenant") return true
  if ((c.agent_user_id && c.agent_user_id === userId) || (c.created_by && c.created_by === userId)) return true
  const visibility = c.visibility_scope ?? "brokerage"
  if (visibility === "brokerage" || visibility === "multi_location" || visibility === "platform") return true
  if (c.team_id && auth.teamIds.includes(c.team_id)) return true
  return visibility === "team" && !!c.team_id && c.team_id === auth.ownTeamId
}

async function decideCampaignAccess(db: Db, actor: QrActor, auth: QrAuthority, campaignId: string): Promise<{ ok: true } | Refusal> {
  const { data, error } = await db.from("marketing_campaigns").select("id, agent_user_id, created_by, team_id, visibility_scope").eq("id", campaignId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error) return { ok: false, code: "refused", message: "We couldn't confirm that campaign, so nothing was created. Try again in a moment." }
  if (!data) return { ok: false, code: "not_permitted", message: "That campaign isn't in your account. Pick one of your campaigns." }
  return campaignOpenToActor(auth, actor.userId, data as never)
    ? { ok: true }
    : { ok: false, code: "not_permitted", message: "That campaign belongs to another agent. Pick one of your own campaigns, or one shared with your team or the whole account." }
}

/**
 * WHOSE code is it? The person's own active record by default. A NAMED agent (a lead filing a code for a team member)
 * must be an active record of THIS account inside the person's scope; the person's own record in another account (or a
 * retired one) files to their record here. TOMBSTONE (this lane): the board route resolved a BODY-supplied
 * `agentUserId` with an unscoped lookup and wrote it as qr_codes.agent_id — any seat could file a code to a peer, or to
 * an agents row of ANOTHER account (the FK proves existence, never tenancy). SURVIVOR: this decision.
 */
async function decideAttribution(db: Db, actor: QrActor, auth: QrAuthority, named: string | null | undefined): Promise<{ ok: true; agentId: string | null } | Refusal> {
  if (!named || named === auth.ownAgentId) return { ok: true, agentId: auth.ownAgentId }
  const { data, error } = await db.from("agents").select("id, user_id, brokerage_id, team_id, location_id, is_active").eq("id", named).maybeSingle()
  if (error) return { ok: false, code: "refused", message: "We couldn't confirm whose code this is, so nothing was created. Try again in a moment." }
  const a = data as { id: string; user_id?: string | null; brokerage_id?: string | null; team_id?: string | null; location_id?: string | null; is_active?: boolean | null } | null
  if (a && a.user_id === actor.userId) return { ok: true, agentId: auth.ownAgentId }
  if (!a || a.brokerage_id !== actor.brokerageId) return { ok: false, code: "not_permitted", message: "That agent isn't in your account, so a code can't be filed to them." }
  if (a.is_active === false) return { ok: false, code: "not_permitted", message: "That agent's seat is turned off, so a code can't be filed to them." }
  return withinQrScope(auth, { agentId: a.id, teamIds: [a.team_id], locationIds: [a.location_id] })
    ? { ok: true, agentId: a.id }
    : { ok: false, code: "not_permitted", message: "You can file a code to another agent only when they are in a team or office you lead. Create it as your own code, or ask an account admin." }
}

// ─── office / team permission ─────────────────────────────────────────────────

/** May this actor file a code under this team / office? The authority's scope (hierarchy facts and grants) plus the
 *  person's own team / office and the two leadership facts (teams.team_lead_id, locations.managing_broker_user_id). */
async function decideFilingScope(db: Db, actor: QrActor, auth: QrAuthority, input: { teamId?: string | null; locationId?: string | null }): Promise<{ ok: true } | Refusal> {
  if (!input.teamId && !input.locationId) return { ok: true }
  const whole = auth.kind === "tenant"
  if (input.teamId) {
    const { data: team, error } = await db.from("teams").select("id, team_lead_id").eq("id", input.teamId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (error) return { ok: false, code: "refused", message: "We couldn't confirm that team, so nothing was created. Try again in a moment." }
    const t = team as { id?: string; team_lead_id?: string | null } | null
    if (!t?.id) return { ok: false, code: "not_permitted", message: "That team isn't in your account. Pick one of your teams, or leave the team empty." }
    if (!whole && t.team_lead_id !== actor.userId && auth.ownTeamId !== t.id && !auth.teamIds.includes(t.id)) {
      return { ok: false, code: "not_permitted", message: "You can file a code only under a team you lead or belong to. Ask an account admin to create it for that team." }
    }
  }
  if (input.locationId) {
    const { data: loc, error } = await db.from("locations").select("id, managing_broker_user_id").eq("id", input.locationId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (error) return { ok: false, code: "refused", message: "We couldn't confirm that office, so nothing was created. Try again in a moment." }
    const l = loc as { id?: string; managing_broker_user_id?: string | null } | null
    if (!l?.id) return { ok: false, code: "not_permitted", message: "That office isn't in your account. Pick one of your offices, or leave the office empty." }
    if (!whole && l.managing_broker_user_id !== actor.userId && auth.ownLocationId !== l.id && !auth.locationIds.includes(l.id)) {
      return { ok: false, code: "not_permitted", message: "You can file a code only under your own office. Ask an account admin to create it for that office." }
    }
  }
  return { ok: true }
}

// ─── THE BOARD'S READS: codes in scope + what a new code may link to ──────────

/** The code columns the board reads (m945 applied live 2026-11-12, so one literal). */
const BOARD_CODE_COLUMNS = "id, slug, label, purpose, target_url, destination_type, listing_id, scan_count, lead_count, is_active, created_at, expires_at, marketing_campaign_id, agent_id, created_by_user_id, mint_context, destination_history, retired_at, retired_reason"

/**
 * Every code this authority covers, newest first: the whole account; or the union of codes filed to an agent in scope,
 * codes the person created, and codes filed (mint_context) to a team / office in scope. Error READ on every query.
 */
export async function listQrCodesInScope(actor: QrActor, auth: QrAuthority, deps: QrDoorDeps = {}): Promise<{ ok: true; rows: Array<Record<string, unknown>> } | Refusal> {
  const db: Db = deps.client ?? createServiceClient()
  const base = () => db.from("qr_codes").select(BOARD_CODE_COLUMNS).eq("brokerage_id", actor.brokerageId)
  const refused: Refusal = { ok: false, code: "refused", message: "We couldn't load your QR codes right now. Nothing was changed — refresh the page in a moment." }
  if (auth.kind === "tenant") {
    const { data, error } = await base().order("created_at", { ascending: false })
    return error ? refused : { ok: true, rows: (data ?? []) as Array<Record<string, unknown>> }
  }
  const agentIds = new Set<string>(auth.ownAgentId ? [auth.ownAgentId] : [])
  if (auth.teamIds.length) {
    const { data, error } = await db.from("agents").select("id").eq("brokerage_id", actor.brokerageId).in("team_id", auth.teamIds)
    if (error) return refused
    for (const a of (data ?? []) as Array<{ id: string }>) agentIds.add(a.id)
  }
  if (auth.kind === "offices" && auth.locationIds.length) {
    const { data, error } = await db.from("agents").select("id").eq("brokerage_id", actor.brokerageId).in("location_id", auth.locationIds)
    if (error) return refused
    for (const a of (data ?? []) as Array<{ id: string }>) agentIds.add(a.id)
  }
  const queries = [base().eq("created_by_user_id", actor.userId)]
  if (agentIds.size) queries.push(base().in("agent_id", [...agentIds]))
  if (auth.teamIds.length) queries.push(base().in("mint_context->>team_id", auth.teamIds))
  if (auth.kind === "offices" && auth.locationIds.length) queries.push(base().in("mint_context->>location_id", auth.locationIds))
  const results = await Promise.all(queries)
  const byId = new Map<string, Record<string, unknown>>()
  for (const r of results) {
    if (r.error) return refused
    for (const row of (r.data ?? []) as Array<Record<string, unknown>>) byId.set(String(row.id), row)
  }
  return { ok: true, rows: [...byId.values()].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))) }
}

interface QrLinkTargets {
  campaigns: Array<{ id: string; name: string }>
  listings: Array<{ id: string; line: string; status: string | null }>
}

/** The campaigns and listings a NEW code may be linked to — the same rules the mint enforces, so the pickers never offer
 *  what the mint would refuse. A refused read leaves that picker empty (the mint still decides), never wider. */
export async function loadQrLinkTargets(actor: QrActor, auth: QrAuthority, deps: QrDoorDeps = {}): Promise<QrLinkTargets> {
  const db: Db = deps.client ?? createServiceClient()
  const out: QrLinkTargets = { campaigns: [], listings: [] }
  const { data: camps, error: cErr } = await db.from("marketing_campaigns").select("id, campaign_name, agent_user_id, created_by, team_id, visibility_scope, created_at").eq("brokerage_id", actor.brokerageId).order("created_at", { ascending: false }).limit(200)
  if (cErr) console.error("[qr-governance] campaign picker not read:", cErr.message)
  for (const c of (camps ?? []) as Array<{ id: string; campaign_name?: string | null; agent_user_id?: string | null; created_by?: string | null; team_id?: string | null; visibility_scope?: string | null }>) {
    if (out.campaigns.length < 100 && campaignOpenToActor(auth, actor.userId, c)) out.campaigns.push({ id: c.id, name: c.campaign_name ?? "Untitled campaign" })
  }
  const { data: lst, error: lErr } = await db.from("listings").select("id, address, city, state, status, agent_id, team_id, location_id, created_at").eq("brokerage_id", actor.brokerageId).is("deleted_at", null).order("created_at", { ascending: false }).limit(300)
  if (lErr) { console.error("[qr-governance] listing picker not read:", lErr.message); return out }
  const listingRows = (lst ?? []) as Array<{ id: string; address?: string | null; city?: string | null; state?: string | null; status?: string | null; agent_id?: string | null; team_id?: string | null; location_id?: string | null }>
  const placement = new Map<string, { team_id: string | null; location_id: string | null }>()
  const others = [...new Set(listingRows.map((l) => l.agent_id).filter((id): id is string => !!id && id !== auth.ownAgentId))]
  if (auth.kind !== "tenant" && others.length) {
    const { data: ags, error: aErr } = await db.from("agents").select("id, team_id, location_id").eq("brokerage_id", actor.brokerageId).in("id", others)
    if (aErr) console.error("[qr-governance] listing owners not read — only own listings offered:", aErr.message)
    for (const a of (ags ?? []) as Array<{ id: string; team_id?: string | null; location_id?: string | null }>) placement.set(a.id, { team_id: a.team_id ?? null, location_id: a.location_id ?? null })
  }
  for (const l of listingRows) {
    const owner = (l.agent_id && placement.get(l.agent_id)) || { team_id: null, location_id: null }
    if (!listingOpenToActor(auth, l, owner)) continue
    const line = [l.address, [l.city, l.state].filter(Boolean).join(", ")].filter(Boolean).join(" — ") || "Listing without an address"
    out.listings.push({ id: l.id, line, status: l.status ?? null })
  }
  return out
}

// ─── THE GOVERNED MINT ────────────────────────────────────────────────────────

interface GovernedQrMintInput {
  /** The request's idempotency key — a replay with the same key returns the SAME code (never a second mint). */
  idempotencyKey: string
  /** The name a person reads on the board. */
  label: string
  purpose: QrPurpose
  destinationType: QrDestinationType | null
  /** The destination. Empty → the code's own landing (allowed only for landing_page / book_meeting / no type). */
  targetUrl?: string | null
  listingId?: string | null
  marketingCampaignId?: string | null
  expiresAt?: string | null
  teamId?: string | null
  locationId?: string | null
  channel?: string | null
  source?: string | null
  placement?: string | null
  mailLayout?: string | null
  assetId?: string | null
  purposeContext?: string | null
  consentContext?: QrConsentContext | null
  tokenScope?: QrTokenScope
  printSizeIn?: number | null
  trackingEnabled?: boolean
  duplicatedFrom?: string | null
}

interface GovernedQrRecord {
  id: string
  slug: string
  label: string
  scanUrl: string
  targetUrl: string
  destinationType: string | null
  purpose: string | null
  imageDataUrl: string | null
}

type GovernedQrResult = { ok: true; replayed: boolean; code: GovernedQrRecord } | Refusal

/** PURE (module-private) — the instruction's own rules, before anything is read. */
function inputRefusal(input: GovernedQrMintInput, nowMs: number): Refusal | null {
  const bad = (message: string): Refusal => ({ ok: false, code: "invalid", message })
  if (!IDEMPOTENCY_KEY_RE.test(input.idempotencyKey ?? "")) return bad("This request is missing its safety key, so nothing was created. Reload the page and try again.")
  const label = (input.label ?? "").trim()
  if (!label || label.length > 120) return bad("Give the code a name of 1–120 characters so you can find it later.")
  if (GENERATED_KEY_RE.test(label)) return bad("Names that start with a word and a colon (like “listing:”) are reserved for codes the system creates. Rename it — for example “Spring open house sign”.")
  if (!isQrPurpose(input.purpose)) return bad("Choose what this code is for.")
  if (input.destinationType != null && !isQrDestinationType(input.destinationType)) return bad("Choose where scanners should land.")
  if (input.tokenScope && !(QR_TOKEN_SCOPES as readonly string[]).includes(input.tokenScope)) return bad("Choose whether this is one code for the design or one code per printed piece.")
  if (input.consentContext && !(QR_CONSENT_CONTEXTS as readonly string[]).includes(input.consentContext)) return bad("Choose what the destination does with personal details.")
  if (input.placement && !(QR_PLACEMENT_TYPES as readonly string[]).includes(input.placement)) return bad("Choose where the code is printed or shown.")
  if (input.mailLayout && !(input.mailLayout in MAIL_LAYOUT_LIBRARY && MAIL_LAYOUT_LIBRARY[input.mailLayout as keyof typeof MAIL_LAYOUT_LIBRARY].qrRegion)) return bad("That mail layout has no QR area. Choose a letter, personal note or postcard side.")
  if (input.printSizeIn !== null && input.printSizeIn !== undefined && !(input.printSizeIn >= 0.8 && input.printSizeIn <= 4)) return bad("Print the code between 0.8 and 4 inches wide — smaller than 0.8 inches phones misread it.")
  if (input.expiresAt) {
    const t = new Date(input.expiresAt).getTime()
    if (!Number.isFinite(t) || t <= nowMs) return bad("Pick an end date in the future, or leave it empty.")
  }
  return null
}

const OWN_LANDING_TYPES = new Set<string | null>([null, "landing_page", "book_meeting"])

/** Re-read a minted code (the mint's readback, and a replay's answer). Tenant-scoped. */
async function readGovernedRecord(db: Db, brokerageId: string, qrCodeId: string, origin: string): Promise<GovernedQrRecord | null> {
  const { data, error } = await db.from("qr_codes").select("id, slug, label, target_url, destination_type, purpose").eq("id", qrCodeId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error || !data) return null
  const r = data as { id: string; slug: string; label: string; target_url: string; destination_type: string | null; purpose: string | null }
  return { id: r.id, slug: r.slug, label: r.label, scanUrl: `${origin}/api/qr/scan?slug=${r.slug}`, targetUrl: r.target_url, destinationType: r.destination_type, purpose: r.purpose, imageDataUrl: null }
}

type MintRun = { kind: "minted"; minted: MintedTrackedQr } | { kind: "refused" } | { kind: "replay"; claim: NonActingClaim }

/**
 * Mint ONE new, unique code for a person's request. Same idempotency key → the same record (the ledger's UNIQUE key;
 * the replay re-reads the code its provider_ref names). Two requests with two keys → two codes with two unpredictable
 * tokens, whatever their labels. Refused requests write nothing and say what to do.
 */
export async function mintGovernedQr(input: GovernedQrMintInput, actor: QrActor, deps: QrDoorDeps = {}): Promise<GovernedQrResult> {
  const db: Db = deps.client ?? createServiceClient()
  const origin = normalizeOrigin(deps.origin ?? null)
  const nowMs = Date.now()
  if (!actor.brokerageId || !actor.userId) return { ok: false, code: "not_permitted", message: "Sign in to an account to create QR codes." }
  const invalid = inputRefusal(input, nowMs)
  if (invalid) return invalid

  // WAVE 153 (153E): WHO is asking — the seat (not suspended / revoked), the plan (solo = the whole account) and the
  // hierarchy scope. Every rule below reads this one answer.
  const authority = await resolveQrAuthority(actor, { ...deps, client: db })
  if (!authority.ok) return authority
  const auth = authority.authority

  const scope = await decideFilingScope(db, actor, auth, { teamId: input.teamId, locationId: input.locationId })
  if (!scope.ok) return scope

  // Whose code it is: the person's own record, or a named agent inside their scope — never a body's say-so.
  const attribution = await decideAttribution(db, actor, auth, actor.agentId)
  if (!attribution.ok) return attribution

  // A campaign or listing FK proves a row exists, never that it is THIS tenant's — nor that THIS person may use it.
  if (input.marketingCampaignId) {
    const c = await decideCampaignAccess(db, actor, auth, input.marketingCampaignId)
    if (!c.ok) return c
  }
  if (input.listingId) {
    const l = await decideListingAccess(db, actor, auth, input.listingId)
    if (!l.ok) return l
  }

  const target = (input.targetUrl ?? "").trim()
  let destinationKind: string = "own_landing"
  let destination: string | null = null
  if (!target) {
    if (!OWN_LANDING_TYPES.has(input.destinationType ?? null)) return { ok: false, code: "invalid", message: "This kind of destination needs a web address. Paste the page people should reach." }
  } else {
    const hosts = await loadQrTenantHosts(db, actor.brokerageId)
    const verdict = validateQrDestination({ url: target, appOrigins: [...(deps.appOrigins ?? []), origin], tenantHosts: [...hosts.customDomains, ...hosts.websiteHosts] })
    if (!verdict.ok) return { ok: false, code: "unsafe_destination", message: verdict.message }
    destination = verdict.url
    destinationKind = verdict.kind
  }
  // A destination that IS a listing's page is a link to that listing: judged by the same listing rule, and recorded on
  // the code (listing_id) so the listing's QR scans are attributed to it.
  const pathListingId = destinationKind === "in_app" ? listingIdInDestination(destination) : null
  if (pathListingId && pathListingId !== (input.listingId ?? "").toLowerCase()) {
    const l = await decideListingAccess(db, actor, auth, pathListingId)
    if (!l.ok) return l
  }
  const listingId = input.listingId ?? pathListingId ?? null

  const context: Partial<QrMintContext> = {
    token_scope: input.tokenScope ?? "per_design",
    tracking: input.trackingEnabled === false ? "disabled" : "enabled",
    channel: input.channel ?? null, source: input.source ?? null, placement: input.placement ?? null, mail_layout: input.mailLayout ?? null,
    asset_id: input.assetId ?? null, team_id: input.teamId ?? null, location_id: input.locationId ?? null,
    purpose_context: input.purposeContext ?? null,
    // Said only where it is KNOWN: the code's own landing asks for consent before any contact (app/qr/[slug]); another
    // site has its own terms. An in-app page varies (a listing has a request form, a video page has none) — unstated.
    consent_context: input.consentContext ?? (destinationKind === "own_landing" ? "consented_form" : destinationKind === "allowed_external" || destinationKind === "tenant_site" ? "external_site" : null),
    print_size_in: input.printSizeIn ?? null, idempotency_key: input.idempotencyKey, duplicated_from: input.duplicatedFrom ?? null,
  }

  const run = await withActionLedger<MintRun>(
    {
      brokerageId: actor.brokerageId,
      action: "marketing.qr.mint",
      actor: { type: "user", userId: actor.userId, agentId: actor.agentId },
      subject: { type: "qr_code", ref: input.idempotencyKey },
      reasonCode: "HUMAN_REQUESTED",
      riskClass: "LOW_RISK_WRITE",
      idempotencyKey: `qr_mint:${actor.brokerageId}:${input.idempotencyKey}`,
      channel: input.channel ?? null,
      systemSource: "qr_registry",
      // WAVE 153 (153E): which authority permitted it (scope kind + the facts behind it) and whose code it is.
      detail: { label: input.label.trim(), purpose: input.purpose, destination_type: input.destinationType, destination_kind: destinationKind, marketing_campaign_id: input.marketingCampaignId ?? null, listing_id: listingId, authority_scope: auth.kind, authority_basis: auth.basis, attributed_agent_id: attribution.agentId, ...context },
    },
    async () => {
      const minted = await mintTrackedQr({
        brokerageId: actor.brokerageId, agentId: attribution.agentId, label: input.label.trim(), destinationType: input.destinationType,
        targetUrl: destination, listingId, marketingCampaignId: input.marketingCampaignId ?? null,
        expiresAt: input.expiresAt ?? null, purpose: input.purpose, origin, createdByUserId: actor.userId, mintContext: context, governed: true,
      }, db as never)
      return minted ? { kind: "minted", minted } : { kind: "refused" }
    },
    {
      settle: (r) => r.kind === "minted"
        ? { status: "executed", outcome: "minted", provider: "qr_registry", providerRef: r.minted.qrCodeId }
        : { status: "failed", outcome: "mint_refused", error: "the registry refused the new code" },
      replay: (claim) => (claim.kind === "refused" ? { kind: "refused" as const } : { kind: "replay" as const, claim }),
    },
    { client: deps.ledgerClient },
  )

  if (run.kind === "minted") {
    const m = run.minted
    return { ok: true, replayed: false, code: { id: m.qrCodeId, slug: m.slug, label: input.label.trim(), scanUrl: m.scanUrl, targetUrl: m.targetUrl, destinationType: m.destinationType, purpose: input.purpose, imageDataUrl: m.qrCodeDataUrl } }
  }
  if (run.kind === "refused") return { ok: false, code: "refused", message: "The QR code wasn't created — the registry refused the write. Nothing was saved; try again, and contact platform support if it keeps happening." }
  const claim = run.claim
  if (claim.kind === "replay" && claim.entry.provider_ref) {
    const again = await readGovernedRecord(db, actor.brokerageId, claim.entry.provider_ref, origin)
    if (again) return { ok: true, replayed: true, code: again }
  }
  if (claim.kind === "in_flight" || claim.kind === "unknown") return { ok: false, code: "in_flight", message: "This code is already being created from your earlier click. Wait a moment and reload the page to see it." }
  return { ok: false, code: "refused", message: "We couldn't confirm whether this code was created, so nothing new was made. Reload the page; if it isn't listed, create it again." }
}

// ─── DESTINATION EDIT (versioned) ─────────────────────────────────────────────

const EDIT_COLUMNS = "id, slug, brokerage_id, target_url, destination_type, is_active, expires_at, retired_at, retired_reason, destination_history"

type QrDestinationEditResult =
  | { ok: true; unchanged: boolean; targetUrl: string; destinationType: string | null; history: QrDestinationVersion[] }
  | Refusal

/**
 * Point a code at a new destination. The printed token never changes, so every printed copy follows the NEXT scan;
 * the previous destination is kept as a version (m945's trigger refuses a history that shrinks or a target change
 * without a new version). Tenant isolation: the row is read and written under the SESSION's brokerage only — another
 * tenant's code reads as "not in your account", the same answer as a code that does not exist.
 */
export async function editQrDestination(
  input: { qrCodeId: string; targetUrl: string; destinationType?: QrDestinationType | null; reason?: string | null },
  actor: QrActor,
  deps: QrDoorDeps = {},
): Promise<QrDestinationEditResult> {
  const db: Db = deps.client ?? createServiceClient()
  const origin = normalizeOrigin(deps.origin ?? null)
  if (!input?.qrCodeId) return { ok: false, code: "invalid", message: "Choose the code to change." }
  if (input.destinationType !== undefined && input.destinationType !== null && !isQrDestinationType(input.destinationType)) return { ok: false, code: "invalid", message: "Choose where scanners should land." }
  // WAVE 153 (153E): the seat first (a suspended / revoked seat changes nothing), the code's scope after the row read.
  const authority = await resolveQrAuthority(actor, { ...deps, client: db })
  if (!authority.ok) return authority

  const { data, error } = await db.from("qr_codes").select(EDIT_COLUMNS).eq("id", input.qrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error && isAbsentColumnRefusal(error)) return { ok: false, code: "unavailable", message: "Destination history isn't switched on for your account yet, so the destination wasn't changed. Platform support can finish the update." }
  if (error) return { ok: false, code: "refused", message: "We couldn't load this code, so nothing was changed. Try again in a moment." }
  const row = data as { id: string; slug: string; target_url: string; destination_type: string | null; is_active: boolean | null; expires_at: string | null; retired_at: string | null; retired_reason: string | null; destination_history: QrDestinationVersion[] | null } | null
  if (!row) return { ok: false, code: "not_found", message: "That QR code isn't in your account." }
  const access = await decideCodeAccess(db, actor, authority.authority, row.id)
  if (!access.ok) return access
  const state = qrLifecycleState(row)
  if (state === "retired" || state === "revoked") return { ok: false, code: "terminal", message: "This code is retired, so its destination can't change. Duplicate it to print a new code with a new destination." }

  const hosts = await loadQrTenantHosts(db, actor.brokerageId)
  const verdict = validateQrDestination({ url: input.targetUrl, appOrigins: [...(deps.appOrigins ?? []), origin], tenantHosts: [...hosts.customDomains, ...hosts.websiteHosts], ownSlug: row.slug })
  if (!verdict.ok) return { ok: false, code: "unsafe_destination", message: verdict.message }
  // Re-pointing a code at a listing's page is putting a code on that listing — the same rule as the mint.
  const pathListingId = verdict.kind === "in_app" ? listingIdInDestination(verdict.url) : null
  if (pathListingId) {
    const l = await decideListingAccess(db, actor, authority.authority, pathListingId)
    if (!l.ok) return l
  }
  const nextType = input.destinationType === undefined ? row.destination_type : input.destinationType
  if (verdict.url === row.target_url && nextType === row.destination_type) {
    return { ok: true, unchanged: true, targetUrl: row.target_url, destinationType: row.destination_type, history: row.destination_history ?? [] }
  }

  const changedAt = new Date().toISOString()
  const history = appendQrDestinationVersion(row.destination_history, { target_url: row.target_url, destination_type: row.destination_type }, { target_url: verdict.url, destination_type: nextType, changed_at: changedAt, changed_by_user_id: actor.userId, reason: (input.reason ?? "").trim() || null })
  const version = history[history.length - 1].version

  type EditRun = { kind: "saved" } | { kind: "conflict" } | { kind: "refused"; message: string } | { kind: "replay" }
  const out = await withActionLedger<EditRun>(
    {
      brokerageId: actor.brokerageId,
      action: "marketing.qr.destination_edit",
      actor: { type: "user", userId: actor.userId, agentId: actor.agentId },
      subject: { type: "qr_code", id: row.id },
      reasonCode: "HUMAN_REQUESTED",
      riskClass: "LOW_RISK_WRITE",
      // One row per VERSION: a double-submitted save of the same version replays instead of writing twice.
      idempotencyKey: `qr_dest:${row.id}:v${version}`,
      systemSource: "qr_registry",
      detail: { from: row.target_url, to: verdict.url, from_type: row.destination_type, to_type: nextType, destination_kind: verdict.kind, version, reason: (input.reason ?? "").trim() || null },
    },
    async () => {
      // OPTIMISTIC: only the destination we read may be replaced; a write that matched nothing is COUNTED (§3).
      const { data: written, error: wErr } = await db.from("qr_codes")
        .update({ target_url: verdict.url, destination_type: nextType, destination_history: history })
        .eq("id", row.id).eq("brokerage_id", actor.brokerageId).eq("target_url", row.target_url)
        .select("id")
      if (wErr) return { kind: "refused", message: wErr.message }
      return Array.isArray(written) && written.length === 1 ? { kind: "saved" } : { kind: "conflict" }
    },
    {
      settle: (r) => r.kind === "saved" ? { status: "executed", outcome: "destination_changed", provider: "qr_registry", providerRef: row.id }
        : r.kind === "conflict" ? { status: "failed", outcome: "stale_destination", error: "the destination changed before this save" }
        : { status: "failed", outcome: "write_refused", error: r.kind === "refused" ? r.message : "refused" },
      replay: (claim) => (claim.kind === "refused" ? { kind: "refused" as const, message: claim.error } : { kind: "replay" as const }),
    },
    { client: deps.ledgerClient },
  )
  if (out.kind === "saved") return { ok: true, unchanged: false, targetUrl: verdict.url, destinationType: nextType, history }
  if (out.kind === "conflict") return { ok: false, code: "conflict", message: "Someone changed this code's destination a moment ago. Reload to see the latest version, then try again." }
  if (out.kind === "replay") return { ok: false, code: "in_flight", message: "This change was already saved from an earlier click. Reload to see it." }
  return { ok: false, code: "refused", message: "The destination wasn't changed — the save was refused. Nothing was changed; try again in a moment." }
}

// ─── LIFECYCLE: pause · resume · retire · revoke-unsafe ───────────────────────

export type QrLifecycleAction = "pause" | "resume" | "retire" | "revoke_unsafe"

/** The retirement each terminal action writes — typed against QR_RETIRED_REASONS (the m945 CHECK's one code source), so
 *  a vocabulary change that this door does not follow fails to compile instead of being refused by the database. */
const RETIREMENT_FOR: Record<"retire" | "revoke_unsafe", (typeof QR_RETIRED_REASONS)[number]> = { retire: "retired", revoke_unsafe: "revoked_unsafe" }

/** PURE (module-private) — the one transition table. Retirement is TERMINAL and never deletes the row: a code that was
 *  printed on mailed pieces is evidence of what was mailed. */
function lifecycleTransition(state: QrLifecycleState, action: QrLifecycleAction, nowIso: string): { ok: true; patch: Record<string, unknown> | null } | Refusal {
  const terminal = state === "retired" || state === "revoked"
  switch (action) {
    case "pause":
      if (terminal) return { ok: false, code: "terminal", message: "This code is already retired and doesn't route scans." }
      return { ok: true, patch: state === "paused" ? null : { is_active: false } }
    case "resume":
      if (terminal) return { ok: false, code: "terminal", message: "A retired code can't be resumed. Duplicate it to print a new code." }
      return { ok: true, patch: state === "paused" ? { is_active: true } : null }
    case "retire":
      if (terminal) return { ok: true, patch: null }
      return { ok: true, patch: { is_active: false, retired_at: nowIso, retired_reason: RETIREMENT_FOR.retire } }
    case "revoke_unsafe":
      if (state === "revoked") return { ok: true, patch: null }
      if (state === "retired") return { ok: false, code: "terminal", message: "This code is already retired and doesn't route scans, so there is nothing left to turn off." }
      return { ok: true, patch: { is_active: false, retired_at: nowIso, retired_reason: RETIREMENT_FOR.revoke_unsafe } }
  }
}

type QrLifecycleResult = { ok: true; state: QrLifecycleState; changed: boolean } | Refusal

export async function changeQrLifecycle(
  input: { qrCodeId: string; action: QrLifecycleAction; reason?: string | null },
  actor: QrActor,
  deps: QrDoorDeps = {},
): Promise<QrLifecycleResult> {
  const db: Db = deps.client ?? createServiceClient()
  if (!input?.qrCodeId) return { ok: false, code: "invalid", message: "Choose the code to change." }
  if (!["pause", "resume", "retire", "revoke_unsafe"].includes(input.action)) return { ok: false, code: "invalid", message: "Choose pause, resume, retire or turn off." }
  if (input.action === "revoke_unsafe" && !(input.reason ?? "").trim()) return { ok: false, code: "invalid", message: "Say why the destination is unsafe — it goes on the code's record." }

  const authority = await resolveQrAuthority(actor, { ...deps, client: db })
  if (!authority.ok) return authority

  const needsRetirement = input.action === "retire" || input.action === "revoke_unsafe"
  let { data, error } = await db.from("qr_codes").select("id, is_active, expires_at, retired_at, retired_reason").eq("id", input.qrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error && isAbsentColumnRefusal(error)) {
    if (needsRetirement) return { ok: false, code: "unavailable", message: "Retiring codes isn't switched on for your account yet. Pause the code instead — it stops routing scans right away." }
    ;({ data, error } = await db.from("qr_codes").select("id, is_active, expires_at").eq("id", input.qrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle())
  }
  if (error) return { ok: false, code: "refused", message: "We couldn't load this code, so nothing was changed. Try again in a moment." }
  if (!data) return { ok: false, code: "not_found", message: "That QR code isn't in your account." }
  const row = data as { id: string; is_active: boolean | null; expires_at: string | null; retired_at?: string | null; retired_reason?: string | null }
  // WAVE 153 (153E): pause / resume / retire / turn off only a code inside this person's scope.
  const access = await decideCodeAccess(db, actor, authority.authority, row.id)
  if (!access.ok) return access
  const before = qrLifecycleState(row)
  const decision = lifecycleTransition(before, input.action, new Date().toISOString())
  if (!decision.ok) return decision
  if (!decision.patch) return { ok: true, state: before, changed: false }
  const patch = decision.patch

  type LifeRun = { kind: "saved" } | { kind: "none" } | { kind: "refused"; message: string } | { kind: "replay" }
  const out = await withActionLedger<LifeRun>(
    {
      brokerageId: actor.brokerageId,
      action: "marketing.qr.lifecycle",
      actor: { type: "user", userId: actor.userId, agentId: actor.agentId },
      subject: { type: "qr_code", id: row.id },
      reasonCode: "HUMAN_REQUESTED",
      riskClass: "LOW_RISK_WRITE",
      systemSource: "qr_registry",
      detail: { action: input.action, from: before, reason: (input.reason ?? "").trim() || null },
    },
    async () => {
      const { data: written, error: wErr } = await db.from("qr_codes").update(patch).eq("id", row.id).eq("brokerage_id", actor.brokerageId).select("id")
      if (wErr) return { kind: "refused", message: wErr.message }
      return Array.isArray(written) && written.length === 1 ? { kind: "saved" } : { kind: "none" }
    },
    {
      settle: (r) => r.kind === "saved" ? { status: "executed", outcome: input.action, provider: "qr_registry", providerRef: row.id } : { status: "failed", outcome: "write_refused", error: r.kind === "refused" ? r.message : "matched no row" },
      replay: (claim) => (claim.kind === "refused" ? { kind: "refused" as const, message: claim.error } : { kind: "replay" as const }),
    },
    { client: deps.ledgerClient },
  )
  if (out.kind !== "saved") return { ok: false, code: out.kind === "none" ? "not_found" : "refused", message: out.kind === "none" ? "That QR code isn't in your account." : "The change wasn't saved. Nothing was changed; try again in a moment." }
  return { ok: true, state: qrLifecycleState({ ...row, ...patch } as Parameters<typeof qrLifecycleState>[0]), changed: true }
}

// ─── DUPLICATE (a new unique token, the same design) ──────────────────────────

/** Duplicate a code's design ON PURPOSE: the same destination, purpose and context under a NEW unpredictable token —
 *  never the old token (two printed runs stay separately measurable). The source may be retired (that is how a retired
 *  code is "re-printed"); its destination is re-validated as of today. */
export async function duplicateQrDesign(
  input: { sourceQrCodeId: string; idempotencyKey: string; label?: string | null },
  actor: QrActor,
  deps: QrDoorDeps = {},
): Promise<GovernedQrResult> {
  const db: Db = deps.client ?? createServiceClient()
  let { data, error } = await db.from("qr_codes").select("id, label, purpose, destination_type, target_url, slug, listing_id, marketing_campaign_id, mint_context").eq("id", input.sourceQrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error && isAbsentColumnRefusal(error)) ({ data, error } = await db.from("qr_codes").select("id, label, purpose, destination_type, target_url, slug, listing_id, marketing_campaign_id").eq("id", input.sourceQrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle())
  if (error) return { ok: false, code: "refused", message: "We couldn't load the code to copy, so nothing was created. Try again in a moment." }
  if (!data) return { ok: false, code: "not_found", message: "That QR code isn't in your account." }
  // WAVE 153 (153E): copy only a code inside this person's scope (the mint below re-checks the seat, listing and campaign).
  const authority = await resolveQrAuthority(actor, { ...deps, client: db })
  if (!authority.ok) return authority
  const access = await decideCodeAccess(db, actor, authority.authority, input.sourceQrCodeId)
  if (!access.ok) return access
  const src = data as { id: string; label: string; purpose: string | null; destination_type: string | null; target_url: string; slug: string; listing_id: string | null; marketing_campaign_id: string | null; mint_context?: Partial<QrMintContext> | null }
  const ctx = src.mint_context ?? {}
  // The source's own landing is ITS landing — a copy lands on its own (empty target → the minter's default).
  const ownLanding = /\/qr\/[^/?#]+$/.test(src.target_url) && src.target_url.endsWith(`/qr/${src.slug}`)
  const baseLabel = (input.label ?? "").trim() || (qrLabelKind(src.label) === "manual" ? `${src.label} (copy)` : "Copy of an automatic code")
  return mintGovernedQr({
    idempotencyKey: input.idempotencyKey,
    label: baseLabel.slice(0, 120),
    purpose: (isQrPurpose(src.purpose) ? src.purpose : "general"),
    destinationType: isQrDestinationType(src.destination_type) ? src.destination_type : null,
    targetUrl: ownLanding ? null : src.target_url,
    listingId: src.listing_id, marketingCampaignId: src.marketing_campaign_id,
    teamId: ctx.team_id ?? null, locationId: ctx.location_id ?? null, channel: ctx.channel ?? null, source: ctx.source ?? null,
    placement: ctx.placement ?? null, mailLayout: ctx.mail_layout ?? null, assetId: ctx.asset_id ?? null, purposeContext: ctx.purpose_context ?? null,
    consentContext: ctx.consent_context ?? null, tokenScope: ctx.token_scope ?? "per_design", printSizeIn: ctx.print_size_in ?? null,
    trackingEnabled: ctx.tracking !== "disabled", duplicatedFrom: src.id,
  }, actor, deps)
}

// ─── SCAN EVIDENCE (the resolver's permitted context) ─────────────────────────
// TOMBSTONE (152C, same wave): qrScanEvidence lived here first. SURVIVOR: lib/marketing/tracked-qr.ts qrScanEvidence —
// moved beside the minter so the lead-magnet tracker (in the CRM page's module graph) can derive the same evidence without
// pulling this module into that graph; the referring-host reducer is lib/marketing/qr-contract.ts qrReferrerHost.

/** Bot · repeat · human-likely for this scan. The repeat window reads the same visitor key on the same code; before
 *  m946 (no visitor_key column) the read is refused and the class falls back to the browser test alone. */
export async function classifyScanForCode(db: Db, input: { qrCodeId: string; visitorKey: string; userAgent: string | null | undefined; nowMs?: number }): Promise<QrTrafficClass> {
  const now = input.nowMs ?? Date.now()
  const since = new Date(now - QR_REPEAT_WINDOW_MS).toISOString()
  const { data, error } = await db.from("qr_scan_events").select("scanned_at").eq("qr_code_id", input.qrCodeId).eq("visitor_key", input.visitorKey).gte("scanned_at", since).order("scanned_at", { ascending: false }).limit(1)
  if (error && !isAbsentColumnRefusal(error)) console.error("[qr-governance] repeat-window read refused:", error.message)
  const last = Array.isArray(data) && data[0] ? (data[0] as { scanned_at?: string | null }).scanned_at ?? null : null
  return classifyQrScan({ userAgent: input.userAgent, lastSameVisitorScanAt: last, nowMs: now })
}

// ─── ACTIVITY (the board's scan history + aggregate outcomes) ─────────────────

export interface QrActivity {
  summary: QrScanSummary
  recent: Array<{ scannedAt: string | null; trafficClass: string | null; deviceClass: string | null; referrerHost: string | null; linkedToContact: boolean }>
  history: QrDestinationVersion[]
  /** Contacts created through this code's consented landing form (qr_codes.lead_count — the submit door's counter). */
  consentedContacts: number
}

/** Tenant-scoped scan history for one code. Raw scans, filtered visits, unique visitor-days and consented submissions
 *  stay separate; a scan is never shown as a person (no visitor key, no contact id leaves this function). */
export async function loadQrActivity(qrCodeId: string, actor: QrActor, deps: QrDoorDeps = {}): Promise<{ ok: true; activity: QrActivity } | Refusal> {
  const db: Db = deps.client ?? createServiceClient()
  let { data: code, error: codeErr } = await db.from("qr_codes").select("id, lead_count, destination_history").eq("id", qrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (codeErr && isAbsentColumnRefusal(codeErr)) ({ data: code, error: codeErr } = await db.from("qr_codes").select("id, lead_count").eq("id", qrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle())
  if (codeErr) return { ok: false, code: "refused", message: "We couldn't load this code's activity. Try again in a moment." }
  if (!code) return { ok: false, code: "not_found", message: "That QR code isn't in your account." }
  // WAVE 153 (153E): a code's scan history is shown to the people who manage it — the board lists only those codes,
  // and the door agrees with the list (an id typed by hand reaches no further).
  const authority = await resolveQrAuthority(actor, { ...deps, client: db })
  if (!authority.ok) return authority
  const access = await decideCodeAccess(db, actor, authority.authority, qrCodeId)
  if (!access.ok) return access
  let { data: events, error: evErr } = await db.from("qr_scan_events").select("scanned_at, traffic_class, visitor_key, device_class, contact_id, referrer").eq("qr_code_id", qrCodeId).eq("brokerage_id", actor.brokerageId).order("scanned_at", { ascending: false }).limit(500)
  if (evErr && isAbsentColumnRefusal(evErr)) ({ data: events, error: evErr } = await db.from("qr_scan_events").select("scanned_at, contact_id, referrer").eq("qr_code_id", qrCodeId).eq("brokerage_id", actor.brokerageId).order("scanned_at", { ascending: false }).limit(500))
  if (evErr) return { ok: false, code: "refused", message: "We couldn't load this code's scans. Try again in a moment." }
  const rows = (events ?? []) as Array<{ scanned_at?: string | null; traffic_class?: string | null; visitor_key?: string | null; device_class?: string | null; contact_id?: string | null; referrer?: string | null }>
  const c = code as { lead_count?: number | null; destination_history?: QrDestinationVersion[] | null }
  return {
    ok: true,
    activity: {
      summary: summarizeQrScans(rows),
      // Rows from before wave 152 stored the full referring URL — shown as its HOST only, like every new row.
      // Only values the m946 CHECKs admit are shown (QR_TRAFFIC_CLASSES / QR_DEVICE_CLASSES); anything else reads as unknown.
      recent: rows.slice(0, 25).map((r) => ({
        scannedAt: r.scanned_at ?? null,
        trafficClass: (QR_TRAFFIC_CLASSES as readonly string[]).includes(r.traffic_class ?? "") ? r.traffic_class ?? null : null,
        deviceClass: (QR_DEVICE_CLASSES as readonly string[]).includes(r.device_class ?? "") ? r.device_class ?? null : null,
        referrerHost: qrReferrerHost(r.referrer),
        linkedToContact: !!r.contact_id,
      })),
      history: Array.isArray(c.destination_history) ? c.destination_history : [],
      consentedContacts: c.lead_count ?? 0,
    },
  }
}
