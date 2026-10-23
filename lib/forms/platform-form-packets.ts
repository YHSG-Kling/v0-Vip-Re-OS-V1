/**
 * lib/forms/platform-form-packets.ts — LICENSED FORM PACKETS HELD IN PLATFORM MEDIA.
 *
 * Closes wave 142's pending hook "142B SOURCE (a)": a licensed form PACKET from PLATFORM Media rendered
 * INSIDE VIPAgents — fillable, with verified-data prefill, autosave / resume, PDF persistence, versions
 * and download — on the existing pdf-lib / forms survivors.
 *
 * WHAT ALREADY EXISTED, AND IS REUSED UNCHANGED
 *   · the fill engine: lib/forms/pdf-form-fill.ts + lib/forms/prefill-property-into-pdf.ts, driven by
 *     app/actions/buyer-offer/prefill-storage-form.ts (verified property facts → party names → the agent's
 *     typed values, legal description from the record / RentCast or the form is INCOMPLETE and the send
 *     refuses). It reads a form from the private `brokerage-forms` bucket after ONE scope check,
 *     lib/forms/form-path-scope.ts:checkFormPathsInScope.
 *   · autosave / resume: lib/kernel/forms.ts saveFormDraft / loadFormDraft (the wizard's draft).
 *   · the PDF persisted + versioned: every fill writes a NEW object `filled/{offerId|userId}/{name}-{stamp}.pdf`
 *     (never overwritten — each fill is a version) and the wizard downloads from its signed URL.
 *
 * WHAT WAS MISSING — and is this file: packets were BROKERAGE-scoped only (`brokerage_form_library`, the
 * `brokerage/…`, `teams/…`, `agents/…` prefixes). Nothing let the PLATFORM hold one licensed packet for
 * every subscriber. This adds the platform as one more OWNER in the same bucket and the same scope check:
 *
 *       platform/{packetId}/{file}.pdf      listed by the registry table `platform_form_packets` (m807)
 *
 * The wizard sees these as ordinary "My Forms" entries with scope `platform` (the wizard's source
 * vocabulary stays `my_forms | legal_forms_provider` — one spelling per idea, CLAUDE.md §6).
 *
 * THE RULES (each is a CHECK in m807 AND a test in scripts/closing-compliance-guard.ts section F)
 *   · A packet reaches a tenant ONLY when status = 'approved' by a named platform human, with a recorded
 *     LICENSE basis, a licence not past its expiry, and at least one fillable form field. A scanned
 *     (field-less) PDF cannot be approved: "fillable" is verified from the file, not claimed.
 *   · The scope check admits `platform/{id}/…` only when the registry row is usable RIGHT NOW (approved,
 *     in licence, the path equal to the row's storage_path) — a retired or expired packet stops being
 *     fillable the moment it changes, even for a wizard that already listed it. It FAILS CLOSED: a refused
 *     registry read refuses the path.
 *   · A tenant NEVER gets the blank master except as a short-lived signed URL for preview, never a public
 *     URL; what they fill is their own `filled/…` copy.
 *   · Human approval: nothing publishes to tenants on upload. Draft → approved is an explicit act by
 *     superadmin (app/actions/superadmin/platform-form-packets.ts), recorded with approver and time.
 *
 * NOT DECIDED HERE (owner questions, listed in the lane notes): which packets the platform may hold under
 * which association licence; whether use is metered per fill; entitlement by plan.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { listPdfFields } from "./pdf-form-fill"

type Svc = SupabaseClient<any, any, any>

/** The ONE bucket forms live in. Platform packets are a prefix of it, not a new bucket. */
export const PLATFORM_PACKET_BUCKET = "brokerage-forms"
export const PLATFORM_PACKET_ROOT = "platform"
/** Largest PDF a packet may be. */
export const PLATFORM_PACKET_MAX_BYTES = 25 * 1024 * 1024
/** How long a tenant's preview link for a blank master lives. */
export const PLATFORM_PACKET_PREVIEW_TTL_SECONDS = 15 * 60

/** MIRRORS brokerage_form_library.packet_type (scripts/check-vocabularies.ts) — one vocabulary for "what kind of packet". */
export const PLATFORM_PACKET_TYPES = ["listing", "offer", "transaction", "disclosure", "custom"] as const
export type PlatformPacketType = (typeof PLATFORM_PACKET_TYPES)[number]

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
 * PURE. May this packet be handed to a tenant for THIS question, right now?
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

// ── TENANT READ ──────────────────────────────────────────────────────────────

export interface PlatformPacketView {
  packetId: string
  name: string
  formCode: string | null
  state: string | null
  packetType: PlatformPacketType
  version: number
  /** The `platform/{id}/{file}` path the wizard hands to the fill action. */
  path: string
  description: string | null
}

/** The approved packets a tenant may use for this question. A refused read is an error, never "no packets". */
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
    packets.push({ packetId: row.id, name: row.name, formCode: row.form_code, state: row.state, packetType: row.packet_type, version: row.version, path: row.storage_path, description: row.description })
  }
  return { ok: true, packets }
}

/**
 * The scope check's registry half: for these `platform/…` paths, which are usable NOW? A refused read
 * REFUSES every path (fail closed). Called by lib/forms/form-path-scope.ts.
 */
export async function usablePlatformPaths(svc: Svc, paths: string[], now: Date = new Date()): Promise<{ ok: true; usable: Set<string> } | { ok: false; error: string }> {
  const ids = paths.map((p) => parsePlatformPacketPath(p)?.packetId).filter((x): x is string => !!x)
  if (ids.length === 0) return { ok: true, usable: new Set() }
  const { data, error } = await svc.from("platform_form_packets").select(PACKET_COLUMNS).in("id", ids)
  if (error) return { ok: false, error: `could not verify the platform packet: ${error.message}` }
  const today = todayIso(now)
  const usable = new Set<string>()
  for (const row of (data ?? []) as PlatformPacketRow[]) {
    // A path is admitted only if it is EXACTLY the registered object and the row is usable now. The state of
    // the deal is a listing filter (what is OFFERED); the fill itself works on any approved, in-licence packet.
    if (packetUsable({ ...row, state: null }, { today }).usable) usable.add(row.storage_path)
  }
  return { ok: true, usable }
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
