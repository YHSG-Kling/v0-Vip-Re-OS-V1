/**
 * lib/forms/tenant-form-packets.ts — FORM PACKETS BELONG TO THE BROKERAGE AND THE TEAM (wave 144, lane 144C).
 *
 * Owner ruling 3 (wave 144, verbatim essentials): "Form packets are NOT platform-owned. The brokerage or team uploads approved form
 * packets (often carrying their logos/branding, legal-form licensing, field templates, jurisdiction forms) into THEIR OWN
 * tenant/team bucket and shares them with their agents as templates. Agents only see packets reachable through their actual
 * memberships/permissions; no cross-tenant/team leakage. Do not move ownership to the platform because packets render inside
 * VIPAgents."
 *
 * ── AUDIT (CLAUDE.md §1 — the survivor, not a new store) ─────────────────────────────────────────────────────────────────────────
 *   BUILT       the tenant registry: `brokerage_form_library` (brokerage_id NOT NULL, tenant RLS) — "the ONE upload path"
 *               (app/actions/compliance/manage-required-docs.ts), written by app/api/admin/transaction-forms/route.ts.
 *   BUILT       the tenant bucket: `brokerage-forms`, private, laid out by owner — `brokerage/{brokerageId}/…`, `teams/{teamId}/…`,
 *               `agents/{userId}/…`, `filled/…` (lib/forms/form-path-scope.ts reads this layout).
 *   BUILT       membership: lib/kernel/resolve-user-team.ts resolveUserTeam — the TS twin of public.resolve_team_id() (lead →
 *               users.team_id → current team_members row → agents.team_id), and resolveLedTeamId for "who leads a team".
 *   PARTIAL     the registry was BROKERAGE-only (no team column, no license record, the stored PDF reached only by an expiring
 *               signed `pdf_url`), so a team could not share a packet with its own agents without sharing it with the whole
 *               brokerage, and the license a form is held under was nowhere.
 *   DUPLICATED  wave 143's `platform_form_packets` (m807) made the PLATFORM a packet owner handing packets straight to every
 *               tenant's agents. Converged here: the platform registry stays as a clearly labelled CATALOGUE (genuinely
 *               platform-provided, license-recorded) that a brokerage ADDS to its own library — a copy into the tenant's own
 *               bucket prefix, a `brokerage_form_library` row carrying `source_platform_packet_id` and the license — and agents
 *               only ever see the brokerage's / team's library (lib/forms/platform-form-packets.ts addPlatformPacketToLibrary).
 *   FOUND       the `brokerage-forms` bucket's storage policies admitted ANY signed-in user to read, overwrite and delete ANY
 *               object in it — every tenant's library and every filled offer (a buyer's name, price and terms). m853 scoped them
 *               to the owner layout above; its storage.objects block is owner SQL (docs/operations/OWNER-SQL.md §F). Measured live
 *               2026-10-25: 0 objects, 0 library rows, 0 platform packets.
 *   FOUND (145A) the owner layout admitted EVERY users row of the brokerage — portal CONTACTS and VENDOR seats carry brokerage_id
 *               (live 2026-10-27: 4 contact + 4 vendor users) — so a buyer could list the brokerage's licensed packets and fill /
 *               read another buyer's filled offer; and a suspended user or a deactivated agent kept access. The reader is now an
 *               ACTIVE tenant STAFF SEAT (FORM_LIBRARY_SEAT_USER_TYPES, below), in code (resolvePacketActor) and in SQL (m854
 *               public.brokerage_forms_seat_active()). The upload route also stopped PERSISTING a 10-year signed URL in
 *               brokerage_form_library.pdf_url — a bearer link no retirement, license expiry or membership end could revoke; every
 *               packet link is minted per view by issueTenantPacketUrl.
 *
 * THE RULES (each one is code below, and a check in scripts/closing-compliance-guard.ts section F)
 *   · A packet lives at `brokerage/{brokerageId}/packets/{rowId}/{file}.pdf` (shared with the whole brokerage) or
 *     `teams/{teamId}/packets/{rowId}/{file}.pdf` (shared with that team only). The row's path must sit under its owner (m853 CHECK).
 *   · An agent SEES a packet only when it is their brokerage's, active, in license, and either brokerage-wide or their OWN team's
 *     (canonical membership). The brokerage's oversight class (the tenant admin roster minus team_lead — "teams see only their
 *     own board", CLAUDE.md §4) sees every team's packets in their brokerage. Another tenant's packet is never visible.
 *   · Sharing with the whole brokerage is the oversight class's act; sharing with a team is that team's lead's (or oversight's).
 *   · Branding is allowed: nothing here inspects, strips or rewrites a packet's artwork. Licensing is RECORDED (`license_note`,
 *     `license_expires_at`), and an expired license stops the packet being offered or filled.
 *   · Fail closed: a refused read is an error, never "no packets"; an unmatched update is a refusal, not a success.
 *
 * Not server-only: every read is behind an injected client, so a plain tsx guard drives it on an in-memory client.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"
import { resolveLedTeamId, resolveUserTeam } from "@/lib/kernel/resolve-user-team"
import { listPdfFields } from "./pdf-form-fill"

type Svc = SupabaseClient<any, any, any>

/** The ONE bucket forms live in. */
export const FORM_PACKET_BUCKET = "brokerage-forms"
/** MIRRORS the live brokerage_form_library.packet_type CHECK (scripts/check-vocabularies.ts) — ONE vocabulary for the kind of packet. */
export const FORM_PACKET_TYPES = ["listing", "offer", "transaction", "disclosure", "custom"] as const
export type FormPacketType = (typeof FORM_PACKET_TYPES)[number]
/** How long a preview / fill link for a packet master lives. */
export const FORM_PACKET_PREVIEW_TTL_SECONDS = 15 * 60
/** Largest packet PDF the library takes. */
const FORM_PACKET_MAX_BYTES = 25 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The brokerage's library OVERSIGHT class — the tenant admin roster minus team_lead, by named subtraction (CLAUDE.md §4: spread
 * the Set, never copy the list). A team lead manages and sees their OWN team's packets; the brokerage's principals see them all.
 */
export const PACKET_OVERSIGHT_USER_TYPES: ReadonlySet<string> = new Set([...TENANT_ADMIN_USER_TYPES].filter((t) => t !== "team_lead"))

/**
 * WHO MAY TOUCH THE FORMS BUCKET AT ALL (wave 145, lane 145A — the P1 form-bucket ruling): a tenant STAFF seat — the operational
 * admin roster (spread, never restated — CLAUDE.md §4) plus the producing / processing seats that fill forms (agent, tc). The same
 * composition the transfer rail moves (lib/kernel/brokerage-transfer.ts MOVING_SEAT_TYPES). NOT here, by design: `contact` (a
 * client — sees only their own documents, CLAUDE.md §5), `vendor` (a lender / title seat is a VENDOR CATEGORY, never a form
 * library reader), `isa` (the AI system seat), `system`, `support`. The SQL twin is m854 public.brokerage_forms_seat_active(); the
 * guard (scripts/transfer-classification-guard.ts) holds the two lists equal.
 */
export const FORM_LIBRARY_SEAT_USER_TYPES: ReadonlySet<string> = new Set([...TENANT_ADMIN_USER_TYPES, "agent", "tc"])

/** PURE: is this users row an ACTIVE forms seat? Revocation on membership end: deleted, suspended / inactive, or not a staff seat
 *  refuses (platform superadmin is the one non-seat admitted — the SQL twin's is_platform_admin()). Null status = active. */
function formLibrarySeatRefusal(u: { user_type?: string | null; status?: string | null; deleted_at?: string | null; platform_role?: string | null } | null): string | null {
  if (!u) return "your account could not be found"
  if (u.deleted_at) return "your account was removed"
  if ((u.status ?? "active") !== "active") return `your account is ${u.status} — form packets are closed to it`
  // THE ONE platform discriminator (lib/platform/platform-staff-roster.ts — test:platform-discriminator), never a re-spelling.
  if (isPlatformSuperadminIdentity(u.user_type ?? null, u.platform_role ?? null)) return null
  if (!FORM_LIBRARY_SEAT_USER_TYPES.has(String(u.user_type ?? ""))) return "form packets are for the brokerage's staff seats (agents, team leads, transaction coordinators and the brokerage's admins) — not for this account type"
  return null
}

export interface PacketActor {
  userId: string
  brokerageId: string
  userType: string | null
  /** The person's ONE team, by the canonical precedence (null = on no team). Verified to belong to `brokerageId`. */
  teamId: string | null
  /** The team they LEAD (teams.team_lead_id), or null. */
  ledTeamId: string | null
  /** In the brokerage's library oversight class. */
  oversight: boolean
  /** The person's OFFICE (users.location_id, verified to be a location of `brokerageId`) — wave 156 (156C) office-specific packets.
   *  Optional so an actor built by hand keeps compiling; absent = on no office. */
  locationId?: string | null
}

export interface TenantPacketRow {
  id: string
  brokerage_id: string
  team_id: string | null
  name: string
  state: string
  packet_type: string
  form_code: string | null
  description: string | null
  storage_path: string | null
  field_count: number | null
  version: number | null
  is_active: boolean
  license_note: string | null
  license_expires_at: string | null
  source_platform_packet_id: string | null
  uploaded_by: string | null
  // ── wave 156 (lane 156C, m1005): provenance, office / agent scope, jurisdiction, revision, checksum, rights, retired replacement ──
  location_id?: string | null
  scope_user_id?: string | null
  source_kind?: string | null
  provider_name?: string | null
  provider_form_id?: string | null
  provider_form_version?: string | null
  purpose?: string | null
  county?: string | null
  effective_on?: string | null
  revision_date?: string | null
  checklist_keys?: string[] | null
  signer_roles?: string[] | null
  field_mapping?: Record<string, string> | null
  checksum_sha256?: string | null
  rights_basis?: string | null
  replaced_by_id?: string | null
  retired_at?: string | null
}

const PACKET_COLUMNS = "id, brokerage_id, team_id, name, state, packet_type, form_code, description, storage_path, field_count, version, is_active, license_note, license_expires_at, source_platform_packet_id, uploaded_by, location_id, scope_user_id, source_kind, provider_name, provider_form_id, provider_form_version, purpose, county, effective_on, revision_date, checklist_keys, signer_roles, field_mapping, checksum_sha256, rights_basis, replaced_by_id, retired_at"

// ── PURE ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const safeFileName = (fileName: string) => {
  const safe = fileName.replace(/^.*[\\/]/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "packet.pdf"
  return safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`
}

/** PURE: where a packet row's master lives — under its OWNER's prefix, keyed by the row id so a path can never name an unregistered row. */
function packetPathFor(owner: { brokerageId: string; teamId: string | null }, rowId: string, fileName: string): string {
  return owner.teamId ? `teams/${owner.teamId}/packets/${rowId}/${safeFileName(fileName)}` : `brokerage/${owner.brokerageId}/packets/${rowId}/${safeFileName(fileName)}`
}

/** PURE: a registered packet path — `brokerage/{id}/packets/{rowId}/{file}.pdf` or `teams/{id}/packets/{rowId}/{file}.pdf`; null for anything else. */
export function parseTenantPacketPath(path: string | null | undefined): { kind: "brokerage" | "team"; ownerId: string; rowId: string } | null {
  if (!path || typeof path !== "string") return null
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) return null
  const parts = path.split("/")
  if (parts.length !== 5 || parts[2] !== "packets" || !parts[4].toLowerCase().endsWith(".pdf")) return null
  const kind = parts[0] === "brokerage" ? "brokerage" : parts[0] === "teams" ? "team" : null
  if (!kind || !UUID.test(parts[1]) || !UUID.test(parts[3])) return null
  return { kind, ownerId: parts[1], rowId: parts[3] }
}

const todayIso = (now: Date = new Date()) => now.toISOString().slice(0, 10)

/** PURE: may THIS actor see THIS packet row right now? The reason names the rule that refused. */
function packetVisibleTo(row: Pick<TenantPacketRow, "brokerage_id" | "team_id" | "is_active" | "license_expires_at" | "location_id" | "scope_user_id">, actor: PacketActor, today: string): { visible: boolean; reason: string | null } {
  if (row.brokerage_id !== actor.brokerageId) return { visible: false, reason: "the packet belongs to another brokerage" }
  if (!row.is_active) return { visible: false, reason: "the packet was retired" }
  if (row.license_expires_at && row.license_expires_at < today) return { visible: false, reason: `the packet's license expired on ${row.license_expires_at}` }
  if (row.team_id && row.team_id !== actor.teamId && !actor.oversight) return { visible: false, reason: "the packet is shared with another team" }
  // wave 156 (156C): an OFFICE packet reaches that office's seats; an agent-authorized supplemental form reaches its own agent only.
  if (row.location_id && row.location_id !== (actor.locationId ?? null) && !actor.oversight) return { visible: false, reason: "the packet is shared with another office" }
  if (row.scope_user_id && row.scope_user_id !== actor.userId && !actor.oversight) return { visible: false, reason: "the packet is another agent's own supplemental form" }
  return { visible: true, reason: null }
}

/** PURE: may this actor share (or retire) a packet with the whole brokerage (teamId null) or with one team? (An office packet and an
 *  agent's own supplemental form — wave 156, 156C — are decided by mayManagePacketOwner below.) */
export function mayManagePacketScope(actor: PacketActor, teamId: string | null): boolean {
  if (!teamId) return actor.oversight
  return actor.oversight || actor.ledTeamId === teamId
}

/** PURE (wave 156, 156C): authority over a row's FULL owner — brokerage or office (the oversight class), team (its lead or
 *  oversight), or an agent's own supplemental form (that agent, or oversight). */
export function mayManagePacketOwner(actor: PacketActor, owner: { teamId: string | null; locationId?: string | null; scopeUserId?: string | null }): boolean {
  if (owner.scopeUserId) return owner.scopeUserId === actor.userId || actor.oversight
  if (owner.locationId) return actor.oversight
  return mayManagePacketScope(actor, owner.teamId)
}

/** PURE: is this packet offered for this deal? A listing packet is not offered to an offer; transaction / disclosure / custom go to both. */
function packetOffered(row: Pick<TenantPacketRow, "state" | "packet_type">, q: { stateCode?: string | null; purpose?: "listing" | "offer" | null }): boolean {
  if (q.stateCode && row.state && row.state.toUpperCase() !== q.stateCode.toUpperCase()) return false
  if (q.purpose && row.packet_type !== q.purpose && !["transaction", "disclosure", "custom"].includes(row.packet_type)) return false
  return true
}

// ── WHO IS ASKING ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the packet actor from a SESSION user id (never a body value). The team is the canonical one, and it must belong to the
 * user's brokerage — a team in another tenant is dropped, never trusted. A refused read is an error (fail closed).
 */
export async function resolvePacketActor(svc: Svc, userId: string): Promise<{ ok: true; actor: PacketActor } | { ok: false; error: string }> {
  if (!userId || !UUID.test(userId)) return { ok: false, error: "no signed-in user" }
  const { data: me, error: meErr } = await svc.from("users").select("brokerage_id, user_type, status, deleted_at, platform_role, location_id").eq("id", userId).maybeSingle()
  if (meErr) return { ok: false, error: `your account could not be read: ${meErr.message}` }
  const brokerageId = (me as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  if (!brokerageId) return { ok: false, error: "your account is not attached to a brokerage" }
  // AN ACTIVE STAFF SEAT ONLY (wave 145, 145A): a contact / vendor seat of the brokerage, a suspended or removed account is refused.
  const seatRefusal = formLibrarySeatRefusal(me as Parameters<typeof formLibrarySeatRefusal>[0])
  if (seatRefusal) return { ok: false, error: seatRefusal }
  // …and an agent deactivated IN THIS BROKERAGE (lib/agents/agent-deactivation.ts sets agents.is_active=false; users stays) is
  // revoked. No agents row = no agent record to revoke (3 of 6 live agent users have none) — the users row decided above.
  const { data: agentRows, error: agErr } = await svc.from("agents").select("is_active").eq("user_id", userId).eq("brokerage_id", brokerageId)
  if (agErr) return { ok: false, error: `your agent record could not be read: ${agErr.message}` }
  const agentList = (agentRows ?? []) as Array<{ is_active?: boolean | null }>
  if (agentList.length > 0 && !agentList.some((a) => a.is_active !== false)) return { ok: false, error: "your agent seat in this brokerage is deactivated — form packets are closed to it" }
  const userType = ((me as { user_type?: string | null } | null)?.user_type ?? null)
  const led = await resolveLedTeamId(svc, userId)
  if (!led.ok) return { ok: false, error: led.error }
  const team = await resolveUserTeam(svc, userId)
  let teamId = team.teamId
  let ledTeamId = led.teamId
  const teamIds = [...new Set([teamId, ledTeamId].filter((t): t is string => !!t))]
  if (teamIds.length > 0) {
    // A DELETED team is a membership that ended (m854's SQL twin requires teams.deleted_at IS NULL for a member's read).
    const { data: teams, error: tErr } = await svc.from("teams").select("id, brokerage_id").in("id", teamIds).eq("brokerage_id", brokerageId).is("deleted_at", null)
    if (tErr) return { ok: false, error: `your team could not be verified: ${tErr.message}` }
    const mine = new Set(((teams ?? []) as Array<{ id: string }>).map((t) => t.id))
    if (teamId && !mine.has(teamId)) teamId = null
    if (ledTeamId && !mine.has(ledTeamId)) ledTeamId = null
  }
  // WAVE 154 (lane 154K — ledger 145A-SO-06 / 146I-OL-05, the SQL ↔ code twin): public.is_brokerage_admin() (m602) honours
  // a user_role_assignments grant PINNED to the caller's brokerage; this resolver read users.user_type only, so an agent
  // granted `admin` was oversight in SQL and not here. The ONE grant reader (lib/auth/role-grants.ts withTenantRoleGrants)
  // now answers too — pinned to THIS brokerage, narrowed by the same oversight class. An unreadable grant list is said and
  // the seat alone decides (never widens).
  const { withTenantRoleGrants } = await import("@/lib/auth/role-grants")
  const granted = await withTenantRoleGrants(svc, { userId, grantedRoles: null as readonly string[] | null }, brokerageId)
  if (granted.note) console.warn(`[tenant-form-packets] ${granted.note}`)
  let oversight = PACKET_OVERSIGHT_USER_TYPES.has(String(userType ?? "")) || (granted.actor.grantedRoles ?? []).some((r) => PACKET_OVERSIGHT_USER_TYPES.has(r))
  // wave 156 (156C, round 2) — TIER PARITY, the existing owner rule (lib/auth/require-caller.ts requireTenantAdminOrSoloOwner): a
  // solo-tier subscriber IS their own broker, so a solo agent manages their own library and bundles. A refused tier read never widens.
  if (!oversight) {
    const { data: b, error: bErr } = await svc.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle()
    if (bErr) console.warn(`[tenant-form-packets] plan tier unreadable — the seat alone decides: ${bErr.message}`)
    else if ((b as { plan_tier?: string | null } | null)?.plan_tier === "solo_agent") oversight = true
  }
  // wave 156 (156C): the office is trusted only when it is a location of THIS brokerage (a cross-tenant id is dropped, never trusted).
  let locationId = ((me as { location_id?: string | null } | null)?.location_id ?? null)
  if (locationId) {
    const { data: loc, error: locErr } = await svc.from("locations").select("id").eq("id", locationId).eq("brokerage_id", brokerageId).maybeSingle()
    if (locErr) return { ok: false, error: `your office could not be verified: ${locErr.message}` }
    if (!loc) locationId = null
  }
  return { ok: true, actor: { userId, brokerageId, userType, teamId, ledTeamId, oversight, locationId } }
}

// ── READS ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TenantPacketView {
  /** The library row, or null for a loose file in the owner's folder (uploaded before the library recorded paths). */
  packetId: string | null
  name: string
  /** The object path the wizard hands to the fill action. */
  path: string
  scope: "brokerage" | "team"
  /** Where it came from: the brokerage's / team's own upload, the platform catalogue (added by the brokerage), or a loose file. */
  origin: "library" | "platform_catalogue" | "file"
  formCode: string | null
  state: string | null
  licenseNote: string | null
  /** wave 156 (156C): the full owner — an office packet and an agent's own supplemental form read as their own source. */
  owner?: "brokerage" | "office" | "team" | "agent"
}

/**
 * The packets THIS actor may use for this deal: the brokerage's and their own team's library (every team's for the oversight
 * class), plus loose files in those owners' folders. Never another tenant's, never another team's. A refused read is an error.
 */
export async function listFormPacketsForActor(
  svc: Svc,
  actor: PacketActor,
  q: { stateCode?: string | null; purpose?: "listing" | "offer" | null; now?: Date } = {},
): Promise<{ ok: true; packets: TenantPacketView[] } | { ok: false; error: string }> {
  const today = todayIso(q.now)
  const { data, error } = await svc.from("brokerage_form_library").select(PACKET_COLUMNS).eq("brokerage_id", actor.brokerageId).eq("is_active", true)
  if (error) return { ok: false, error: `your brokerage's form library could not be read: ${error.message}` }
  const packets: TenantPacketView[] = []
  const seen = new Set<string>()
  for (const row of (data ?? []) as TenantPacketRow[]) {
    if (!row.storage_path) continue // a legacy row reached only by its expiring pdf_url — its file is listed below as a loose file
    if (!packetVisibleTo(row, actor, today).visible || !packetOffered(row, q)) continue
    seen.add(row.storage_path)
    packets.push({
      packetId: row.id, name: row.name, path: row.storage_path, scope: row.team_id ? "team" : "brokerage",
      origin: row.source_platform_packet_id ? "platform_catalogue" : "library", formCode: row.form_code, state: row.state, licenseNote: row.license_note, owner: packetOwnerKind(row),
    })
  }
  // Loose files directly in the owners' folders (the layout the wizard listed before the library recorded paths).
  const folders: Array<{ prefix: string; scope: "brokerage" | "team" }> = [{ prefix: `brokerage/${actor.brokerageId}`, scope: "brokerage" }]
  if (actor.teamId) folders.push({ prefix: `teams/${actor.teamId}`, scope: "team" })
  for (const f of folders) {
    const { data: objs, error: listErr } = await svc.storage.from(FORM_PACKET_BUCKET).list(f.prefix, { limit: 100 })
    if (listErr) return { ok: false, error: `the ${f.scope} folder could not be listed: ${listErr.message}` }
    for (const o of (objs ?? []) as Array<{ name: string; id?: string | null }>) {
      if (!/\.(pdf|docx)$/i.test(o.name)) continue
      const path = `${f.prefix}/${o.name}`
      if (seen.has(path)) continue
      seen.add(path)
      packets.push({ packetId: null, name: o.name, path, scope: f.scope, origin: "file", formCode: null, state: null, licenseNote: null })
    }
  }
  return { ok: true, packets }
}

/**
 * The scope check's registry half: for these registered-packet paths, which may THIS actor fill right now? A path is admitted only
 * when it is EXACTLY the row's stored path and the row is visible to the actor (brokerage, active, in license, membership). A
 * refused read refuses every path (fail closed). Called by lib/forms/form-path-scope.ts.
 */
export async function usableTenantPacketPaths(svc: Svc, actor: PacketActor, paths: string[], now: Date = new Date()): Promise<{ ok: true; usable: Set<string> } | { ok: false; error: string }> {
  const ids = [...new Set(paths.map((p) => parseTenantPacketPath(p)?.rowId).filter((x): x is string => !!x))]
  if (ids.length === 0) return { ok: true, usable: new Set() }
  const { data, error } = await svc.from("brokerage_form_library").select(PACKET_COLUMNS).in("id", ids).eq("brokerage_id", actor.brokerageId)
  if (error) return { ok: false, error: `could not verify the form packet: ${error.message}` }
  const today = todayIso(now)
  const usable = new Set<string>()
  for (const row of (data ?? []) as TenantPacketRow[]) {
    if (row.storage_path && packetVisibleTo(row, actor, today).visible) usable.add(row.storage_path)
  }
  return { ok: true, usable }
}

/**
 * THE ONE MINTING DOOR FOR A REGISTERED PACKET MASTER (wave 145, lane 145A). A short-lived signed link, minted per view, only when
 * the row is the actor's brokerage's, its stored path is EXACTLY a well-formed tenant packet path under the row's own owner, and:
 *   · purpose "use"    — the row is visible to the actor right now (active, in license, brokerage-wide or their own team — the fill
 *                        rule; the SQL twin is m854's registered-packet arm of brokerage_forms_path_readable);
 *   · purpose "manage" — the actor has authority over the row's scope (mayManagePacketScope — the oversight class, or the team's lead
 *                        for a team packet), retired / expired rows included so a manager can review before reactivating.
 * Nothing is persisted; a refused signer is a refusal with its reason, never a public fallback. Replaces the 10-year URL the upload
 * route used to write into brokerage_form_library.pdf_url.
 */
export async function issueTenantPacketUrl(
  svc: Svc,
  actor: PacketActor,
  row: Pick<TenantPacketRow, "id" | "brokerage_id" | "team_id" | "is_active" | "license_expires_at" | "storage_path">,
  purpose: "use" | "manage",
  now: Date = new Date(),
): Promise<{ ok: true; url: string; ttlSeconds: number } | { ok: false; reason: string }> {
  if (row.brokerage_id !== actor.brokerageId) return { ok: false, reason: "the packet belongs to another brokerage" }
  const parsed = parseTenantPacketPath(row.storage_path)
  const ownerOk = !!parsed && parsed.rowId === row.id && (row.team_id ? parsed.kind === "team" && parsed.ownerId === row.team_id : parsed.kind === "brokerage" && parsed.ownerId === row.brokerage_id)
  if (!ownerOk) return { ok: false, reason: "the packet has no registered master under its owner's folder" }
  if (purpose === "use") {
    const v = packetVisibleTo(row, actor, todayIso(now))
    if (!v.visible) return { ok: false, reason: v.reason ?? "the packet is not shared with you" }
  } else if (!mayManagePacketScope(actor, row.team_id)) {
    return { ok: false, reason: "you do not manage this packet's scope" }
  }
  const { data, error } = await svc.storage.from(FORM_PACKET_BUCKET).createSignedUrl(row.storage_path as string, FORM_PACKET_PREVIEW_TTL_SECONDS)
  if (error || !data?.signedUrl) return { ok: false, reason: `no link could be signed: ${error?.message ?? "no url"}` }
  return { ok: true, url: data.signedUrl, ttlSeconds: FORM_PACKET_PREVIEW_TTL_SECONDS }
}

/**
 * The library as its MANAGERS see it (the brokerage's library page): every row the actor's memberships reach — retired ones too, so
 * they can be reactivated — and the teams the actor may share a packet with. A refused read is an error.
 */
export async function listLibraryForActor(svc: Svc, actor: PacketActor): Promise<
  { ok: true; forms: Array<TenantPacketRow & { pdf_url: string | null; field_schema: string[] | null; created_at: string | null; updated_at: string | null }>; shareTeams: Array<{ id: string; name: string }> } | { ok: false; error: string }
> {
  const { data, error } = await svc.from("brokerage_form_library")
    .select(`${PACKET_COLUMNS}, pdf_url, field_schema, created_at, updated_at`)
    .eq("brokerage_id", actor.brokerageId)
    .order("state", { ascending: true }).order("packet_type", { ascending: true }).order("name", { ascending: true })
  if (error) return { ok: false, error: `your brokerage's form library could not be read: ${error.message}` }
  const forms = ((data ?? []) as Array<TenantPacketRow & { pdf_url: string | null; field_schema: string[] | null; created_at: string | null; updated_at: string | null }>)
    .filter((r) => !r.team_id || r.team_id === actor.teamId || actor.oversight)
  let shareTeams: Array<{ id: string; name: string }> = []
  if (actor.oversight || actor.ledTeamId) {
    let q = svc.from("teams").select("id, name").eq("brokerage_id", actor.brokerageId).is("deleted_at", null)
    if (!actor.oversight) q = q.eq("id", actor.ledTeamId as string)
    const { data: teams, error: tErr } = await q
    if (tErr) return { ok: false, error: `your teams could not be read: ${tErr.message}` }
    shareTeams = ((teams ?? []) as Array<{ id: string; name: string | null }>).map((t) => ({ id: t.id, name: t.name ?? "Team" }))
  }
  return { ok: true, forms, shareTeams }
}

// ── WRITES (the gate — a signed-in session — lives in the route; these take the RESOLVED actor) ────────────────────────────────────

export interface RegisterTenantPacketInput {
  /** null = share with the whole brokerage; a team id = share with that team only. */
  teamId?: string | null
  name: string
  state: string
  packetType: string
  formCode?: string | null
  description?: string | null
  /** Under what license the brokerage / team holds this form (association membership, a forms-provider agreement, its own form). */
  licenseNote?: string | null
  licenseExpiresAt?: string | null
  fieldSchema?: string[] | null
  /** The packet's PDF. null = a field-schema-only library entry (the AI form-fill engine's mapping, no master to fill). */
  fileName: string | null
  bytes: Uint8Array | null
  /** wave 156 (156C): share with ONE office (locations.id of this brokerage) — the oversight class's act. */
  locationId?: string | null
  /** wave 156 (156C): an agent's OWN supplemental form (only that agent sees it) — must be the actor (or oversight acting for them). */
  scopeUserId?: string | null
  /** wave 156 (156C): provenance, jurisdiction, revision, checklist / signer / field mapping — validated by lib/forms/form-directory-intake.ts. */
  provenance?: PacketProvenance | null
  /** A new REVISION of an existing row (lib/forms/form-directory-intake.ts reviseLibraryForm) carries the next version number. */
  version?: number
}

/** wave 156 (156C, m1005): what every added form records beyond its name — where it came from, under what right, for what. */
export interface PacketProvenance {
  sourceKind: string
  rightsBasis: string
  purpose: string
  county?: string | null
  effectiveOn?: string | null
  revisionDate?: string | null
  checklistKeys?: string[] | null
  signerRoles?: string[] | null
  fieldMapping?: Record<string, string> | null
  providerName?: string | null
  providerFormId?: string | null
  providerFormVersion?: string | null
}

/** PURE (wave 156, 156C): the owner kind of a row. */
function packetOwnerKind(row: Pick<TenantPacketRow, "team_id" | "location_id" | "scope_user_id">): "brokerage" | "office" | "team" | "agent" {
  return row.scope_user_id ? "agent" : row.team_id ? "team" : row.location_id ? "office" : "brokerage"
}

/** PURE: the master's fingerprint — sha256 hex of the stored bytes (provenance; a duplicate upload of the same revision is refused). */
export async function packetChecksum(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto")
  return createHash("sha256").update(bytes).digest("hex")
}

const isPdf = (b: Uint8Array) => b.length > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 // %PDF

/** The validation both writers share. */
function validatePacketMeta(input: { name: string; state: string; packetType: string; licenseExpiresAt?: string | null }): string | null {
  if (input.name.trim().length < 3) return "Give the packet a name (at least 3 characters)."
  if (!/^[A-Z]{2}$/.test(input.state.trim().toUpperCase())) return "Choose the state the packet is for (two-letter code)."
  if (!(FORM_PACKET_TYPES as readonly string[]).includes(input.packetType)) return `"${input.packetType}" is not a packet type (${FORM_PACKET_TYPES.join(", ")}).`
  if (input.licenseExpiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.licenseExpiresAt)) return "The license expiry must be a date (YYYY-MM-DD)."
  return null
}

/** Is `teamId` a live team of the actor's brokerage? A refused read is a refusal. */
async function teamInBrokerage(svc: Svc, actor: PacketActor, teamId: string): Promise<string | null> {
  if (!UUID.test(teamId)) return "That is not a team id."
  const { data, error } = await svc.from("teams").select("id").eq("id", teamId).eq("brokerage_id", actor.brokerageId).is("deleted_at", null).maybeSingle()
  if (error) return `The team could not be verified: ${error.message}`
  if (!data) return "That team is not in your brokerage."
  return null
}

/**
 * Store a packet in the OWNER's own folder and register it in the brokerage's library, shared with the brokerage or one team.
 * Refused, by name: a sharer without the authority for that scope, a team outside the brokerage, a file that is not a PDF.
 * When the registry insert is refused the stored object is REMOVED and the removal counted (no orphan master).
 */
export async function registerTenantFormPacket(svc: Svc, actor: PacketActor, input: RegisterTenantPacketInput): Promise<{ ok: true; packet: TenantPacketRow } | { ok: false; error: string }> {
  const teamId = input.teamId || null
  const locationId = input.locationId || null
  const scopeUserId = input.scopeUserId || null
  const bad = validatePacketMeta(input)
  if (bad) return { ok: false, error: bad }
  if ([teamId, locationId, scopeUserId].filter(Boolean).length > 1) return { ok: false, error: "A packet is shared with ONE owner — the brokerage, one office, one team, or one agent." }
  if (scopeUserId && scopeUserId !== actor.userId && !actor.oversight) return { ok: false, error: "You can add a supplemental form for yourself only." }
  if (!mayManagePacketOwner(actor, { teamId, locationId, scopeUserId })) {
    return { ok: false, error: locationId ? "Only a brokerage admin can share a packet with an office." : teamId ? "Only that team's lead or a brokerage admin can share a packet with the team." : "Only a brokerage admin can share a packet with the whole brokerage — a team lead shares with their own team." }
  }
  if (teamId) { const t = await teamInBrokerage(svc, actor, teamId); if (t) return { ok: false, error: t } }
  if (locationId) {
    if (!UUID.test(locationId)) return { ok: false, error: "That is not an office id." }
    const { data: loc, error: locErr } = await svc.from("locations").select("id").eq("id", locationId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (locErr) return { ok: false, error: `The office could not be verified: ${locErr.message}` }
    if (!loc) return { ok: false, error: "That office is not in your brokerage." }
  }
  const id = crypto.randomUUID()
  let fieldCount = 0
  let path: string | null = null
  let checksum: string | null = null
  if (input.bytes) {
    if (!isPdf(input.bytes)) return { ok: false, error: "The file is not a PDF." }
    if (input.bytes.length > FORM_PACKET_MAX_BYTES) return { ok: false, error: `The PDF is larger than ${FORM_PACKET_MAX_BYTES / (1024 * 1024)} MB.` }
    try { fieldCount = (await listPdfFields(input.bytes)).length } catch (e) { return { ok: false, error: `The PDF could not be read: ${e instanceof Error ? e.message : "unreadable"}` } }
    checksum = await packetChecksum(input.bytes)
    // The storage layout (m853 CHECK) knows brokerage/ and teams/ owners; an office or agent form lives under the brokerage's prefix
    // and its row's location_id / scope_user_id narrow who may see it.
    path = packetPathFor({ brokerageId: actor.brokerageId, teamId }, id, input.fileName ?? "packet.pdf")
    const { error: upErr } = await svc.storage.from(FORM_PACKET_BUCKET).upload(path, Buffer.from(input.bytes), { contentType: "application/pdf", upsert: false })
    if (upErr) return { ok: false, error: `The packet could not be stored: ${upErr.message}` }
  }
  const pv = input.provenance ?? null
  const { data, error } = await svc.from("brokerage_form_library").insert({
    id, brokerage_id: actor.brokerageId, team_id: teamId, name: input.name.trim(), description: input.description?.trim() || null,
    state: input.state.trim().toUpperCase(), packet_type: input.packetType, form_code: input.formCode?.trim() || null,
    storage_path: path, pdf_url: null, field_schema: input.fieldSchema ?? null, field_count: fieldCount, version: input.version ?? 1, is_active: true,
    license_note: input.licenseNote?.trim() || null, license_expires_at: input.licenseExpiresAt || null, uploaded_by: actor.userId,
    location_id: locationId, scope_user_id: scopeUserId, checksum_sha256: checksum,
    source_kind: pv?.sourceKind ?? (scopeUserId ? "agent_upload" : "brokerage_upload"), rights_basis: pv?.rightsBasis ?? null, purpose: pv?.purpose ?? null,
    county: pv?.county ?? null, effective_on: pv?.effectiveOn ?? null, revision_date: pv?.revisionDate ?? null, checklist_keys: pv?.checklistKeys ?? null,
    signer_roles: pv?.signerRoles ?? null, field_mapping: pv?.fieldMapping ?? null, provider_name: pv?.providerName ?? null,
    provider_form_id: pv?.providerFormId ?? null, provider_form_version: pv?.providerFormVersion ?? null,
  }).select(PACKET_COLUMNS)
  if (error || !data || data.length === 0) {
    const { data: removed } = path ? await svc.storage.from(FORM_PACKET_BUCKET).remove([path]) : { data: [] }
    return { ok: false, error: `The packet was not registered (${error?.message ?? "no row returned"}); ${removed?.length ?? 0} stored file(s) removed.` }
  }
  return { ok: true, packet: (data as TenantPacketRow[])[0] }
}

export interface TenantPacketPatch {
  name?: string
  description?: string | null
  state?: string
  packet_type?: string
  form_code?: string | null
  field_schema?: string[] | null
  is_active?: boolean
  license_note?: string | null
  license_expires_at?: string | null
}

/**
 * Edit a packet's library record (never its owner — re-sharing with another scope is a new upload, so a team packet can never be
 * widened to the whole brokerage by an edit). Tenant-pinned, authority-checked for the row's scope, and counted.
 */
export async function updateTenantFormPacket(svc: Svc, actor: PacketActor, packetId: string, patch: TenantPacketPatch): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!UUID.test(packetId)) return { ok: false, error: "That is not a packet id." }
  const { data: row, error: readErr } = await svc.from("brokerage_form_library").select("id, team_id, name, state, packet_type").eq("id", packetId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (readErr) return { ok: false, error: `The packet could not be read: ${readErr.message}` }
  if (!row) return { ok: false, error: "That packet is not in your brokerage." }
  const current = row as { team_id: string | null; name: string; state: string; packet_type: string }
  if (!mayManagePacketScope(actor, current.team_id)) return { ok: false, error: "You cannot change a packet shared by another team." }
  const next = { name: patch.name ?? current.name, state: patch.state ?? current.state, packetType: patch.packet_type ?? current.packet_type, licenseExpiresAt: patch.license_expires_at ?? null }
  const bad = validatePacketMeta(next)
  if (bad) return { ok: false, error: bad }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.name !== undefined) updates.name = patch.name.trim()
  if (patch.description !== undefined) updates.description = patch.description?.trim() || null
  if (patch.state !== undefined) updates.state = patch.state.trim().toUpperCase()
  if (patch.packet_type !== undefined) updates.packet_type = patch.packet_type
  if (patch.form_code !== undefined) updates.form_code = patch.form_code?.trim() || null
  if (patch.field_schema !== undefined) updates.field_schema = patch.field_schema
  if (patch.is_active !== undefined) updates.is_active = patch.is_active === true
  if (patch.license_note !== undefined) updates.license_note = patch.license_note?.trim() || null
  if (patch.license_expires_at !== undefined) updates.license_expires_at = patch.license_expires_at || null
  const { data, error } = await svc.from("brokerage_form_library").update(updates).eq("id", packetId).eq("brokerage_id", actor.brokerageId).select("id")
  if (error) return { ok: false, error: `The packet was not updated: ${error.message}` }
  if (!data || data.length !== 1) return { ok: false, error: "The packet was not updated — it matched no row in your brokerage." }
  return { ok: true }
}

/** Retire a packet: agents stop being offered it and the fill action refuses it immediately. Tenant-pinned and counted. */
export async function retireTenantFormPacket(svc: Svc, actor: PacketActor, packetId: string, opts: { replacedById?: string | null } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!UUID.test(packetId)) return { ok: false, error: "That is not a packet id." }
  const { data: row, error: readErr } = await svc.from("brokerage_form_library").select("id, team_id, is_active, location_id, scope_user_id").eq("id", packetId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (readErr) return { ok: false, error: `The packet could not be read: ${readErr.message}` }
  if (!row) return { ok: false, error: "That packet is not in your brokerage." }
  const r = row as { team_id: string | null; location_id?: string | null; scope_user_id?: string | null }
  if (!mayManagePacketOwner(actor, { teamId: r.team_id, locationId: r.location_id ?? null, scopeUserId: r.scope_user_id ?? null })) return { ok: false, error: "You cannot retire a packet shared by another team, office or agent." }
  if (opts.replacedById && (!UUID.test(opts.replacedById) || opts.replacedById === packetId)) return { ok: false, error: "The replacement must be another packet of your brokerage." }
  const now = new Date().toISOString()
  const { data, error } = await svc.from("brokerage_form_library").update({ is_active: false, updated_at: now, retired_at: now, ...(opts.replacedById ? { replaced_by_id: opts.replacedById } : {}) })
    .eq("id", packetId).eq("brokerage_id", actor.brokerageId).eq("is_active", true).select("id")
  if (error) return { ok: false, error: `The packet was not retired: ${error.message}` }
  if (!data || data.length !== 1) return { ok: false, error: "The packet was not retired — it is already retired." }
  return { ok: true }
}

/** The insert half of adding a platform-catalogue packet (lib/forms/platform-form-packets.ts addPlatformPacketToLibrary): a copy in the owner's folder + a library row. */
export async function registerCopiedPacket(
  svc: Svc,
  actor: PacketActor,
  input: { teamId: string | null; sourcePlatformPacketId: string; sourcePath: string; fileName: string; name: string; state: string; packetType: string; formCode: string | null; description: string | null; fieldCount: number; version: number; licenseNote: string | null; licenseExpiresAt: string | null },
): Promise<{ ok: true; packet: TenantPacketRow; existing: boolean } | { ok: false; error: string }> {
  const bad = validatePacketMeta(input)
  if (bad) return { ok: false, error: bad }
  if (!mayManagePacketScope(actor, input.teamId)) return { ok: false, error: input.teamId ? "Only that team's lead or a brokerage admin can add a packet to the team's library." : "Only a brokerage admin can add a packet to the brokerage's library." }
  if (input.teamId) { const t = await teamInBrokerage(svc, actor, input.teamId); if (t) return { ok: false, error: t } }
  // IDEMPOTENT: the same catalogue packet already in this library (same scope) is returned, not copied twice.
  let q = svc.from("brokerage_form_library").select(PACKET_COLUMNS).eq("brokerage_id", actor.brokerageId).eq("source_platform_packet_id", input.sourcePlatformPacketId).eq("is_active", true)
  q = input.teamId ? q.eq("team_id", input.teamId) : q.is("team_id", null)
  const { data: have, error: haveErr } = await q
  if (haveErr) return { ok: false, error: `Your library could not be read: ${haveErr.message}` }
  if (have && have.length > 0) return { ok: true, packet: (have as TenantPacketRow[])[0], existing: true }

  const id = crypto.randomUUID()
  const path = packetPathFor({ brokerageId: actor.brokerageId, teamId: input.teamId }, id, input.fileName)
  const { error: cpErr } = await svc.storage.from(FORM_PACKET_BUCKET).copy(input.sourcePath, path)
  if (cpErr) return { ok: false, error: `The packet could not be copied into your library: ${cpErr.message}` }
  const { data, error } = await svc.from("brokerage_form_library").insert({
    id, brokerage_id: actor.brokerageId, team_id: input.teamId, name: input.name, description: input.description, state: input.state.trim().toUpperCase(),
    packet_type: input.packetType, form_code: input.formCode, storage_path: path, pdf_url: null, field_schema: null, field_count: input.fieldCount,
    version: input.version, is_active: true, license_note: input.licenseNote, license_expires_at: input.licenseExpiresAt,
    source_platform_packet_id: input.sourcePlatformPacketId, uploaded_by: actor.userId,
  }).select(PACKET_COLUMNS)
  if (error || !data || data.length === 0) {
    const { data: removed } = await svc.storage.from(FORM_PACKET_BUCKET).remove([path])
    return { ok: false, error: `The packet was not added (${error?.message ?? "no row returned"}); ${removed?.length ?? 0} copied file(s) removed.` }
  }
  return { ok: true, packet: (data as TenantPacketRow[])[0], existing: false }
}

// ── WAVE 156 (lane 156C): THE TENANT HALF OF THE ONE FORM PICKER ────────────────────────────────────────────────────────────────────

/**
 * Every ACTIVE library row this actor may use, as directory rows — including the ones with no master of their own (a provider-form
 * REFERENCE, or a named state requirement not yet configured), which the fill list (listFormPacketsForActor) leaves out because there
 * is nothing to fill. lib/forms/provider-form-directory.ts mergeFormDirectory joins these with the provider's library so an adopted
 * provider form is listed ONCE. A refused read is an error (fail closed).
 */
export async function listDirectoryRowsForActor(
  svc: Svc,
  actor: PacketActor,
  q: { stateCode?: string | null; now?: Date } = {},
): Promise<{ ok: true; rows: Array<{ packetId: string; name: string; path: string | null; scope: "brokerage" | "office" | "team" | "agent"; providerName: string | null; providerFormId: string | null; state: string | null; formCode: string | null; status: "ready" | "not_configured"; canManage: boolean; version: number | null }> } | { ok: false; error: string }> {
  const today = todayIso(q.now)
  const { data, error } = await svc.from("brokerage_form_library").select(PACKET_COLUMNS).eq("brokerage_id", actor.brokerageId).eq("is_active", true)
  if (error) return { ok: false, error: `your brokerage's form library could not be read: ${error.message}` }
  const rows = []
  for (const row of (data ?? []) as TenantPacketRow[]) {
    if (!packetVisibleTo(row, actor, today).visible) continue
    if (q.stateCode && row.state && row.state.toUpperCase() !== q.stateCode.toUpperCase()) continue
    rows.push({
      packetId: row.id, name: row.name, path: row.storage_path, scope: packetOwnerKind(row), providerName: row.provider_name ?? null,
      providerFormId: row.provider_form_id ?? null, state: row.state, formCode: row.form_code,
      status: (row.storage_path || row.provider_form_id ? "ready" : "not_configured") as "ready" | "not_configured", canManage: mayManagePacketOwner(actor, { teamId: row.team_id, locationId: row.location_id ?? null, scopeUserId: row.scope_user_id ?? null }), version: row.version ?? null,
    })
  }
  return { ok: true, rows }
}
