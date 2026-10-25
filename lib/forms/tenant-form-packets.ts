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
 *   PARTIAL     the registry was BROKERAGE-only (no team column, no licence record, the stored PDF reached only by an expiring
 *               signed `pdf_url`), so a team could not share a packet with its own agents without sharing it with the whole
 *               brokerage, and the licence a form is held under was nowhere.
 *   DUPLICATED  wave 143's `platform_form_packets` (m807) made the PLATFORM a packet owner handing packets straight to every
 *               tenant's agents. Converged here: the platform registry stays as a clearly labelled CATALOGUE (genuinely
 *               platform-provided, licence-recorded) that a brokerage ADDS to its own library — a copy into the tenant's own
 *               bucket prefix, a `brokerage_form_library` row carrying `source_platform_packet_id` and the licence — and agents
 *               only ever see the brokerage's / team's library (lib/forms/platform-form-packets.ts addPlatformPacketToLibrary).
 *   FOUND       the `brokerage-forms` bucket's storage policies admitted ANY signed-in user to read, overwrite and delete ANY
 *               object in it — every tenant's library and every filled offer (a buyer's name, price and terms). m847 scopes them
 *               to the owner layout above. Measured live 2026-10-25: 0 objects, 0 library rows, 0 platform packets.
 *
 * THE RULES (each one is code below, and a check in scripts/closing-compliance-guard.ts section F)
 *   · A packet lives at `brokerage/{brokerageId}/packets/{rowId}/{file}.pdf` (shared with the whole brokerage) or
 *     `teams/{teamId}/packets/{rowId}/{file}.pdf` (shared with that team only). The row's path must sit under its owner (m847 CHECK).
 *   · An agent SEES a packet only when it is their brokerage's, active, in licence, and either brokerage-wide or their OWN team's
 *     (canonical membership). The brokerage's oversight class (the tenant admin roster minus team_lead — "teams see only their
 *     own board", CLAUDE.md §4) sees every team's packets in their brokerage. Another tenant's packet is never visible.
 *   · Sharing with the whole brokerage is the oversight class's act; sharing with a team is that team's lead's (or oversight's).
 *   · Branding is allowed: nothing here inspects, strips or rewrites a packet's artwork. Licensing is RECORDED (`license_note`,
 *     `license_expires_at`), and an expired licence stops the packet being offered or filled.
 *   · Fail closed: a refused read is an error, never "no packets"; an unmatched update is a refusal, not a success.
 *
 * Not server-only: every read is behind an injected client, so a plain tsx guard drives it on an in-memory client.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
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
}

const PACKET_COLUMNS = "id, brokerage_id, team_id, name, state, packet_type, form_code, description, storage_path, field_count, version, is_active, license_note, license_expires_at, source_platform_packet_id, uploaded_by"

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
function packetVisibleTo(row: Pick<TenantPacketRow, "brokerage_id" | "team_id" | "is_active" | "license_expires_at">, actor: PacketActor, today: string): { visible: boolean; reason: string | null } {
  if (row.brokerage_id !== actor.brokerageId) return { visible: false, reason: "the packet belongs to another brokerage" }
  if (!row.is_active) return { visible: false, reason: "the packet was retired" }
  if (row.license_expires_at && row.license_expires_at < today) return { visible: false, reason: `the packet's licence expired on ${row.license_expires_at}` }
  if (row.team_id && row.team_id !== actor.teamId && !actor.oversight) return { visible: false, reason: "the packet is shared with another team" }
  return { visible: true, reason: null }
}

/** PURE: may this actor share (or retire) a packet with the whole brokerage (teamId null) or with one team? */
export function mayManagePacketScope(actor: PacketActor, teamId: string | null): boolean {
  if (!teamId) return actor.oversight
  return actor.oversight || actor.ledTeamId === teamId
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
  const { data: me, error: meErr } = await svc.from("users").select("brokerage_id, user_type").eq("id", userId).maybeSingle()
  if (meErr) return { ok: false, error: `your account could not be read: ${meErr.message}` }
  const brokerageId = (me as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  if (!brokerageId) return { ok: false, error: "your account is not attached to a brokerage" }
  const userType = ((me as { user_type?: string | null } | null)?.user_type ?? null)
  const led = await resolveLedTeamId(svc, userId)
  if (!led.ok) return { ok: false, error: led.error }
  const team = await resolveUserTeam(svc, userId)
  let teamId = team.teamId
  let ledTeamId = led.teamId
  const teamIds = [...new Set([teamId, ledTeamId].filter((t): t is string => !!t))]
  if (teamIds.length > 0) {
    const { data: teams, error: tErr } = await svc.from("teams").select("id, brokerage_id").in("id", teamIds).eq("brokerage_id", brokerageId)
    if (tErr) return { ok: false, error: `your team could not be verified: ${tErr.message}` }
    const mine = new Set(((teams ?? []) as Array<{ id: string }>).map((t) => t.id))
    if (teamId && !mine.has(teamId)) teamId = null
    if (ledTeamId && !mine.has(ledTeamId)) ledTeamId = null
  }
  return { ok: true, actor: { userId, brokerageId, userType, teamId, ledTeamId, oversight: PACKET_OVERSIGHT_USER_TYPES.has(String(userType ?? "")) } }
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
      origin: row.source_platform_packet_id ? "platform_catalogue" : "library", formCode: row.form_code, state: row.state, licenseNote: row.license_note,
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
 * when it is EXACTLY the row's stored path and the row is visible to the actor (brokerage, active, in licence, membership). A
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
  /** Under what licence the brokerage / team holds this form (association membership, a forms-provider agreement, its own form). */
  licenseNote?: string | null
  licenseExpiresAt?: string | null
  fieldSchema?: string[] | null
  /** The packet's PDF. null = a field-schema-only library entry (the AI form-fill engine's mapping, no master to fill). */
  fileName: string | null
  bytes: Uint8Array | null
}

const isPdf = (b: Uint8Array) => b.length > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 // %PDF

/** The validation both writers share. */
function validatePacketMeta(input: { name: string; state: string; packetType: string; licenseExpiresAt?: string | null }): string | null {
  if (input.name.trim().length < 3) return "Give the packet a name (at least 3 characters)."
  if (!/^[A-Z]{2}$/.test(input.state.trim().toUpperCase())) return "Choose the state the packet is for (two-letter code)."
  if (!(FORM_PACKET_TYPES as readonly string[]).includes(input.packetType)) return `"${input.packetType}" is not a packet type (${FORM_PACKET_TYPES.join(", ")}).`
  if (input.licenseExpiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.licenseExpiresAt)) return "The licence expiry must be a date (YYYY-MM-DD)."
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
  const bad = validatePacketMeta(input)
  if (bad) return { ok: false, error: bad }
  if (!mayManagePacketScope(actor, teamId)) {
    return { ok: false, error: teamId ? "Only that team's lead or a brokerage admin can share a packet with the team." : "Only a brokerage admin can share a packet with the whole brokerage — a team lead shares with their own team." }
  }
  if (teamId) { const t = await teamInBrokerage(svc, actor, teamId); if (t) return { ok: false, error: t } }
  const id = crypto.randomUUID()
  let fieldCount = 0
  let path: string | null = null
  if (input.bytes) {
    if (!isPdf(input.bytes)) return { ok: false, error: "The file is not a PDF." }
    if (input.bytes.length > FORM_PACKET_MAX_BYTES) return { ok: false, error: `The PDF is larger than ${FORM_PACKET_MAX_BYTES / (1024 * 1024)} MB.` }
    try { fieldCount = (await listPdfFields(input.bytes)).length } catch (e) { return { ok: false, error: `The PDF could not be read: ${e instanceof Error ? e.message : "unreadable"}` } }
    path = packetPathFor({ brokerageId: actor.brokerageId, teamId }, id, input.fileName ?? "packet.pdf")
    const { error: upErr } = await svc.storage.from(FORM_PACKET_BUCKET).upload(path, Buffer.from(input.bytes), { contentType: "application/pdf", upsert: false })
    if (upErr) return { ok: false, error: `The packet could not be stored: ${upErr.message}` }
  }
  const { data, error } = await svc.from("brokerage_form_library").insert({
    id, brokerage_id: actor.brokerageId, team_id: teamId, name: input.name.trim(), description: input.description?.trim() || null,
    state: input.state.trim().toUpperCase(), packet_type: input.packetType, form_code: input.formCode?.trim() || null,
    storage_path: path, pdf_url: null, field_schema: input.fieldSchema ?? null, field_count: fieldCount, version: 1, is_active: true,
    license_note: input.licenseNote?.trim() || null, license_expires_at: input.licenseExpiresAt || null, uploaded_by: actor.userId,
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
export async function retireTenantFormPacket(svc: Svc, actor: PacketActor, packetId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!UUID.test(packetId)) return { ok: false, error: "That is not a packet id." }
  const { data: row, error: readErr } = await svc.from("brokerage_form_library").select("id, team_id, is_active").eq("id", packetId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (readErr) return { ok: false, error: `The packet could not be read: ${readErr.message}` }
  if (!row) return { ok: false, error: "That packet is not in your brokerage." }
  if (!mayManagePacketScope(actor, (row as { team_id: string | null }).team_id)) return { ok: false, error: "You cannot retire a packet shared by another team." }
  const { data, error } = await svc.from("brokerage_form_library").update({ is_active: false, updated_at: new Date().toISOString() })
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
