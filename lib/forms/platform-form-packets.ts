/**
 * lib/forms/platform-form-packets.ts — THE PLATFORM-PROVIDED FORM CATALOGUE (a source brokerages add FROM — never an owner of
 * what agents fill).
 *
 * WAVE 144 (lane 144C) — OWNERSHIP CONVERGED. Owner ruling 3, verbatim essentials: "Form packets are NOT platform-owned. The
 * brokerage or team uploads approved form packets … into THEIR OWN tenant/team bucket and shares them with their agents as
 * templates … Do not move ownership to the platform because packets render inside VIPAgents." Wave 143 built this file as a
 * platform OWNER that handed packets straight to every tenant's agents (a `platform/{id}/…` path the wizard filled directly).
 * That door is closed:
 *   · the registry (m807 `platform_form_packets`) and its licence / approval record are KEPT, unchanged, as a clearly labelled
 *     CATALOGUE of genuinely platform-provided packets — no m807 row is dropped or rewritten;
 *   · an agent never sees or fills a `platform/…` path any more (lib/forms/form-path-scope.ts refuses it for a tenant actor);
 *   · a BROKERAGE (or a team lead, for their team) ADDS a catalogue packet to its OWN library — addPlatformPacketToLibrary below
 *     copies the master into the tenant's own folder and writes a `brokerage_form_library` row carrying
 *     `source_platform_packet_id` and the licence it came under — and its agents see it there, through their memberships, like
 *     any packet the brokerage uploaded itself (lib/forms/tenant-form-packets.ts).
 * READERS RE-POINTED, NOT REMOVED: `listPlatformPacketsForTenant` is now read by the TENANT's library page
 * (app/api/admin/transaction-forms/route.ts — what a brokerage admin may add), not by the agent's wizard; `usablePlatformPaths` now
 * guards the COPY (only a master usable right now is added to a library), not a tenant fill. The survivor for "may this agent fill
 * this packet" is lib/forms/tenant-form-packets.ts:usableTenantPacketPaths.
 *
 * THE CATALOGUE RULES (each is a CHECK in m807 AND a test in scripts/closing-compliance-guard.ts section F)
 *   · A packet is offered to a brokerage ONLY when status = 'approved' by a named platform human, with a recorded LICENSE basis,
 *     a licence not past its expiry, and at least one fillable form field. A scanned (field-less) PDF cannot be approved.
 *   · The blank master is previewed only through a short-lived signed URL, never a public URL.
 *   · Human approval: nothing reaches a brokerage on upload. Draft → approved is an explicit act by superadmin
 *     (app/actions/superadmin/platform-form-packets.ts), recorded with approver and time.
 *
 * NOT DECIDED HERE (owner questions, in the lane notes): which packets the platform may hold under which association licence;
 * whether a licence revoked upstream must retire the brokerages' copies (today a copy carries the licence expiry it was added
 * under, and stops being offered when it passes).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { listPdfFields } from "./pdf-form-fill"
import { FORM_PACKET_BUCKET, FORM_PACKET_TYPES, registerCopiedPacket, type FormPacketType, type PacketActor, type TenantPacketRow } from "./tenant-form-packets"

type Svc = SupabaseClient<any, any, any>

/** The ONE bucket forms live in. Catalogue masters are a prefix of it, not a new bucket. */
// ONE spelling of the bucket (§6, wave 145 lane 145A): the catalogue lives in the tenant bucket under platform/, so its constant IS
// the tenant constant (lib/forms/tenant-form-packets.ts FORM_PACKET_BUCKET) — kept as an export for its importers, never a 2nd literal.
export const PLATFORM_PACKET_BUCKET = FORM_PACKET_BUCKET
export const PLATFORM_PACKET_ROOT = "platform"
/** Largest PDF a packet may be. */
export const PLATFORM_PACKET_MAX_BYTES = 25 * 1024 * 1024
/** How long a brokerage admin's preview link for a catalogue master lives. */
export const PLATFORM_PACKET_PREVIEW_TTL_SECONDS = 15 * 60

/** THE SAME vocabulary as brokerage_form_library.packet_type — imported, never restated (one vocabulary for "what kind of packet"). */
export const PLATFORM_PACKET_TYPES = FORM_PACKET_TYPES
export type PlatformPacketType = FormPacketType

/** MIRRORS the m807 CHECK. */
export const PLATFORM_PACKET_STATUSES = ["draft", "approved", "retired"] as const
export type PlatformPacketStatus = (typeof PLATFORM_PACKET_STATUSES)[number]

export interface PlatformPacketRow {
  id: string
  name: string
  state: string | null
  packet_type: PlatformPacketType
  form_code: string | null
  description: string | null
  storage_path: string
  file_name: string
  field_count: number
  status: PlatformPacketStatus
  version: number
  license_note: string | null
  license_expires_at: string | null
  approved_by: string | null
  approved_at: string | null
}

const PACKET_COLUMNS = "id, name, state, packet_type, form_code, description, storage_path, file_name, file_size_bytes, field_count, status, version, license_note, license_expires_at, approved_by, approved_at"

// ── PURE ─────────────────────────────────────────────────────────────────────

/** `platform/{packetId}/{safe file name}.pdf`. The id is the registry row's, so a path can never name a packet that is not registered. */
function platformPacketPath(packetId: string, fileName: string): string {
  const safe = fileName.replace(/^.*[\\/]/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "packet.pdf"
  return `${PLATFORM_PACKET_ROOT}/${packetId}/${safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`}`
}

/** The packet id of a `platform/{id}/{file}` path; null for anything else (traversal, wrong root, empty file). */
export function parsePlatformPacketPath(path: string | null | undefined): { packetId: string } | null {
  if (!path || typeof path !== "string") return null
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) return null
  const [root, id, ...rest] = path.split("/")
  if (root !== PLATFORM_PACKET_ROOT || !id || rest.length !== 1 || !rest[0].toLowerCase().endsWith(".pdf")) return null
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
  return { packetId: id }
}

export interface PacketQuestion {
  /** USPS code of the deal's state, or null when unknown. */
  stateCode?: string | null
  /** The wizard's purpose. */
  purpose?: "listing" | "offer" | null
  /** Injected "today" (YYYY-MM-DD) so the rule is testable. */
  today: string
}

/**
 * PURE. May this catalogue packet be offered to a brokerage for THIS question (or added to its library), right now?
 * Unapproved, retired, out of licence, or not fillable → never. A packet pinned to a state is offered only
 * for that state; an unknown deal state sees only the state-neutral packets (never "all states").
 */
function packetUsable(row: Pick<PlatformPacketRow, "status" | "state" | "packet_type" | "field_count" | "license_note" | "license_expires_at" | "approved_by">, q: PacketQuestion): { usable: boolean; reason: string | null } {
  if (row.status !== "approved") return { usable: false, reason: `the packet is ${row.status}, not approved` }
  if (!row.approved_by) return { usable: false, reason: "no platform approver is recorded" }
  if (!row.license_note || row.license_note.trim().length < 20) return { usable: false, reason: "no licence basis is recorded" }
  if (row.license_expires_at && row.license_expires_at < q.today) return { usable: false, reason: `the licence expired on ${row.license_expires_at}` }
  if (!(row.field_count > 0)) return { usable: false, reason: "the PDF has no fillable fields" }
  if (row.state && (!q.stateCode || row.state.toUpperCase() !== q.stateCode.toUpperCase())) return { usable: false, reason: `the packet is for ${row.state}` }
  if (q.purpose && row.packet_type !== q.purpose && row.packet_type !== "transaction" && row.packet_type !== "disclosure" && row.packet_type !== "custom") {
    return { usable: false, reason: `the packet is for ${row.packet_type} forms` }
  }
  return { usable: true, reason: null }
}

const todayIso = (now: Date = new Date()) => now.toISOString().slice(0, 10)

// ── THE CATALOGUE READ (a brokerage admin choosing what to add to their OWN library) ───────────────────────────────────────────

export interface PlatformPacketView {
  packetId: string
  name: string
  formCode: string | null
  state: string | null
  packetType: PlatformPacketType
  version: number
  /** The `platform/{id}/{file}` master — previewed by a signed link; copied into the brokerage's folder when added. */
  path: string
  description: string | null
  licenseNote: string | null
  licenseExpiresAt: string | null
}

/**
 * The approved, in-licence catalogue packets offered to a TENANT for this question — read by the tenant's library page (what a
 * brokerage admin may add to its own library), never by an agent's wizard. A refused read is an error, never "no packets".
 */
export async function listPlatformPacketsForTenant(
  svc: Svc,
  q: Omit<PacketQuestion, "today"> & { now?: Date },
): Promise<{ ok: true; packets: PlatformPacketView[] } | { ok: false; error: string }> {
  const { data, error } = await svc.from("platform_form_packets").select(PACKET_COLUMNS).eq("status", "approved").order("name", { ascending: true })
  if (error) return { ok: false, error: `platform packets could not be read: ${error.message}` }
  const today = todayIso(q.now)
  const packets: PlatformPacketView[] = []
  for (const row of (data ?? []) as PlatformPacketRow[]) {
    if (!packetUsable(row, { stateCode: q.stateCode, purpose: q.purpose, today }).usable) continue
    packets.push({ packetId: row.id, name: row.name, formCode: row.form_code, state: row.state, packetType: row.packet_type, version: row.version, path: row.storage_path, description: row.description, licenseNote: row.license_note, licenseExpiresAt: row.license_expires_at })
  }
  return { ok: true, packets }
}

/**
 * The registry's admission for these `platform/…` paths: which are usable NOW (exactly the registered object, approved, in licence,
 * fillable)? A refused read REFUSES every path (fail closed). Wave 144: it guards the COPY into a brokerage's library
 * (addPlatformPacketToLibrary) — a tenant no longer fills a `platform/…` path (lib/forms/form-path-scope.ts refuses it).
 */
export async function usablePlatformPaths(svc: Svc, paths: string[], now: Date = new Date()): Promise<{ ok: true; usable: Set<string> } | { ok: false; error: string }> {
  const ids = paths.map((p) => parsePlatformPacketPath(p)?.packetId).filter((x): x is string => !!x)
  if (ids.length === 0) return { ok: true, usable: new Set() }
  const { data, error } = await svc.from("platform_form_packets").select(PACKET_COLUMNS).in("id", ids)
  if (error) return { ok: false, error: `could not verify the platform packet: ${error.message}` }
  const today = todayIso(now)
  const usable = new Set<string>()
  for (const row of (data ?? []) as PlatformPacketRow[]) {
    // A path is admitted only if it is EXACTLY the registered object and the row is usable now; the deal's state is a listing filter.
    if (paths.includes(row.storage_path) && packetUsable({ ...row, state: null }, { today }).usable) usable.add(row.storage_path)
  }
  return { ok: true, usable }
}

/**
 * ADD a catalogue packet to a brokerage's (or one team's) OWN library: the master is COPIED into the owner's folder and registered
 * in brokerage_form_library with `source_platform_packet_id` and the licence it was approved under. From then on it is the
 * brokerage's packet — offered to its agents through their memberships, retired by the brokerage, not by the platform.
 * Refused, by name: a packet that is not usable right now (draft, retired, out of licence, not fillable), an actor without the
 * authority for that scope, a state-neutral packet with no state chosen. Idempotent per (brokerage, scope, packet).
 */
export async function addPlatformPacketToLibrary(
  svc: Svc,
  actor: PacketActor,
  input: { packetId: string; teamId?: string | null; state?: string | null; now?: Date },
): Promise<{ ok: true; packet: TenantPacketRow; existing: boolean } | { ok: false; error: string }> {
  if (!parsePlatformPacketPath(`${PLATFORM_PACKET_ROOT}/${input.packetId}/x.pdf`)) return { ok: false, error: "That is not a catalogue packet id." }
  const { data: row, error } = await svc.from("platform_form_packets").select(PACKET_COLUMNS).eq("id", input.packetId).maybeSingle()
  if (error) return { ok: false, error: `The catalogue packet could not be read: ${error.message}` }
  if (!row) return { ok: false, error: "No such catalogue packet." }
  const packet = row as PlatformPacketRow
  // ONLY A MASTER USABLE RIGHT NOW IS COPIED — the registry's own admission (exactly the registered object; approved, in licence,
  // fillable), the same rule that once admitted a tenant fill and now admits the copy.
  const gate = await usablePlatformPaths(svc, [packet.storage_path], input.now)
  if (!gate.ok) return { ok: false, error: gate.error }
  if (!gate.usable.has(packet.storage_path)) {
    return { ok: false, error: `That catalogue packet cannot be added: ${packetUsable({ ...packet, state: null }, { today: todayIso(input.now) }).reason ?? "it is not usable right now"}.` }
  }
  const state = (packet.state ?? input.state ?? "").trim().toUpperCase()
  if (!state) return { ok: false, error: "This catalogue packet is state-neutral — choose the state your brokerage will use it for." }
  if (packet.state && input.state && input.state.trim().toUpperCase() !== packet.state) return { ok: false, error: `This catalogue packet is for ${packet.state}.` }
  return registerCopiedPacket(svc, actor, {
    teamId: input.teamId || null, sourcePlatformPacketId: packet.id, sourcePath: packet.storage_path, fileName: packet.file_name,
    name: packet.name, state, packetType: packet.packet_type, formCode: packet.form_code, description: packet.description,
    fieldCount: packet.field_count, version: packet.version, licenseNote: packet.license_note, licenseExpiresAt: packet.license_expires_at,
  })
}

// ── STAFF WRITES (the gate — requireSuperadmin — lives in the server action; these take the verified actor) ──

export interface RegisterPacketInput {
  actorUserId: string
  name: string
  state?: string | null
  packetType: string
  formCode?: string | null
  description?: string | null
  fileName: string
  bytes: Uint8Array
}

const isPdf = (b: Uint8Array) => b.length > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 // %PDF

/** Is the PDF a FILLABLE form? Verified from the file: the count of AcroForm fields. */
async function fillableFieldCount(bytes: Uint8Array): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  try {
    return { ok: true, count: (await listPdfFields(bytes)).length }
  } catch (e) {
    return { ok: false, error: `the PDF could not be read: ${e instanceof Error ? e.message : "unreadable"}` }
  }
}

/** Upload the master to the private bucket and register it as a DRAFT. Nothing is visible to tenants yet. */
export async function registerPlatformPacket(svc: Svc, input: RegisterPacketInput): Promise<{ ok: true; packet: PlatformPacketRow } | { ok: false; error: string }> {
  const name = input.name.trim()
  if (name.length < 3) return { ok: false, error: "Give the packet a name (at least 3 characters)." }
  if (!(PLATFORM_PACKET_TYPES as readonly string[]).includes(input.packetType)) return { ok: false, error: `"${input.packetType}" is not a packet type (${PLATFORM_PACKET_TYPES.join(", ")}).` }
  const state = input.state ? input.state.trim().toUpperCase() : null
  if (state && !/^[A-Z]{2}$/.test(state)) return { ok: false, error: "State must be a two-letter code, or empty for a state-neutral packet." }
  if (!isPdf(input.bytes)) return { ok: false, error: "The file is not a PDF." }
  if (input.bytes.length > PLATFORM_PACKET_MAX_BYTES) return { ok: false, error: `The PDF is larger than ${PLATFORM_PACKET_MAX_BYTES / (1024 * 1024)} MB.` }
  const fields = await fillableFieldCount(input.bytes)
  if (!fields.ok) return fields
  if (fields.count === 0) return { ok: false, error: "This PDF has no fillable form fields. A flat or scanned PDF cannot be a fillable packet — upload the licensed fillable version." }

  const id = crypto.randomUUID()
  const path = platformPacketPath(id, input.fileName)
  const { error: upErr } = await svc.storage.from(PLATFORM_PACKET_BUCKET).upload(path, Buffer.from(input.bytes), { contentType: "application/pdf", upsert: false })
  if (upErr) return { ok: false, error: `The packet could not be stored: ${upErr.message}` }

  const { data, error } = await svc.from("platform_form_packets").insert({
    id, name, state, packet_type: input.packetType, form_code: input.formCode?.trim() || null, description: input.description?.trim() || null,
    storage_path: path, file_name: path.split("/").pop(), file_size_bytes: input.bytes.length, field_count: fields.count, status: "draft", version: 1, created_by: input.actorUserId,
  }).select(PACKET_COLUMNS)
  if (error || !data || data.length === 0) {
    // The row did not land: the object must not stay behind unregistered. COUNT what the remove deleted.
    const { data: removed } = await svc.storage.from(PLATFORM_PACKET_BUCKET).remove([path])
    return { ok: false, error: `The packet was not registered (${error?.message ?? "no row returned"}); ${removed?.length ?? 0} stored file(s) removed.` }
  }
  return { ok: true, packet: (data as PlatformPacketRow[])[0] }
}

export interface ApprovePacketInput { actorUserId: string; packetId: string; licenseNote: string; licenseExpiresAt?: string | null }

/**
 * A named platform human approves a DRAFT for every subscriber. The licence basis is REQUIRED (the platform
 * must be able to say under what agreement it holds and redistributes this form). Approving a newer packet
 * for the same state + type + form code RETIRES the older approved one (one current version per form).
 */
export async function approvePlatformPacket(svc: Svc, input: ApprovePacketInput): Promise<{ ok: true; retiredOlder: number } | { ok: false; error: string }> {
  const note = input.licenseNote.trim()
  if (note.length < 20) return { ok: false, error: "Record the licence basis (at least 20 characters): who licensed this form to the platform, under what agreement, and what it permits." }
  if (input.licenseExpiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.licenseExpiresAt)) return { ok: false, error: "The licence expiry must be a date (YYYY-MM-DD)." }
  const { data: row, error: readErr } = await svc.from("platform_form_packets").select(PACKET_COLUMNS).eq("id", input.packetId).maybeSingle()
  if (readErr) return { ok: false, error: `The packet could not be read: ${readErr.message}` }
  if (!row) return { ok: false, error: "No such packet." }
  const packet = row as PlatformPacketRow
  if (packet.status !== "draft") return { ok: false, error: `Only a draft can be approved (this one is ${packet.status}).` }
  if (!(packet.field_count > 0)) return { ok: false, error: "This packet has no fillable fields and cannot be approved." }

  const now = new Date().toISOString()
  const { data: updated, error: upErr } = await svc.from("platform_form_packets")
    .update({ status: "approved", license_note: note, license_expires_at: input.licenseExpiresAt || null, approved_by: input.actorUserId, approved_at: now, updated_at: now })
    .eq("id", packet.id).eq("status", "draft").select("id")
  if (upErr) return { ok: false, error: `The approval was refused: ${upErr.message}` }
  if (!updated || updated.length !== 1) return { ok: false, error: "The packet was not approved — it is no longer a draft." }

  let retiredOlder = 0
  if (packet.form_code) {
    let q = svc.from("platform_form_packets").select("id").eq("status", "approved").eq("form_code", packet.form_code).eq("packet_type", packet.packet_type).neq("id", packet.id)
    q = packet.state ? q.eq("state", packet.state) : q.is("state", null)
    const { data: older, error: olderErr } = await q
    if (olderErr) return { ok: false, error: `Approved, but the older version could not be looked up to retire it: ${olderErr.message}` }
    for (const o of (older ?? []) as Array<{ id: string }>) {
      const r = await retirePlatformPacket(svc, { actorUserId: input.actorUserId, packetId: o.id, reason: `superseded by ${packet.id}` })
      if (r.ok) retiredOlder++
    }
  }
  return { ok: true, retiredOlder }
}

/** Retire a packet: tenants stop being offered it, and the scope check refuses it, immediately. */
export async function retirePlatformPacket(svc: Svc, input: { actorUserId: string; packetId: string; reason: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const reason = input.reason.trim()
  if (reason.length < 3) return { ok: false, error: "Give a reason for retiring the packet." }
  const now = new Date().toISOString()
  const { data, error } = await svc.from("platform_form_packets")
    .update({ status: "retired", retired_at: now, retired_reason: reason.slice(0, 500), updated_at: now })
    .eq("id", input.packetId).neq("status", "retired").select("id")
  if (error) return { ok: false, error: `The packet was not retired: ${error.message}` }
  if (!data || data.length !== 1) return { ok: false, error: "The packet was not retired — it does not exist or is already retired." }
  return { ok: true }
}
