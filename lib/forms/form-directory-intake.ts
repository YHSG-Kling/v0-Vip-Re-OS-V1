/**
 * lib/forms/form-directory-intake.ts — ADDING A FORM TO THE LIBRARY, THREE WAYS, ONE WRITER (wave 156, lane 156C).
 *
 * Owner (wave 156): "the form packet tool should list all possible forms/packets or have the capability for the user or manager to
 * add more." Owned by the Compliance Manager (registry key `compliance_officer`) with the forms kernel — there is no Forms Manager.
 *
 * THE SURVIVOR IS EXTENDED, NOT DUPLICATED: every row is written by lib/forms/tenant-form-packets.ts registerTenantFormPacket (the ONE
 * packet writer, the ONE bucket `brokerage-forms`, the m853 owner layout). This module only VALIDATES what the owner asked every added
 * form to carry and chooses which of the three doors applies:
 *   · upload            — a PDF the brokerage / office / team / agent holds the right to use, stored in the tenant's OWN folder.
 *   · state_preconfigured — a form the state's package names (lib/state-forms/registry.ts — per state, never a universal list). The
 *                         platform has NO bytes for it, so the row is a NAMED REQUIREMENT with no master: it reads `not configured`
 *                         until a licensed file is uploaded or a provider form is linked — it never pretends the form exists.
 *   · provider_form     — a form in the tenant's connected provider's AUTHORIZED library, found by id (every page walked). The row is
 *                         a REFERENCE: provider_name + provider_form_id, storage_path NULL — provider-owned PDF bytes are never
 *                         copied into storage the tenant has no right to use (m1005 CHECK holds the database to the same rule).
 *
 * EVERY ADDED FORM CARRIES (m1005): source kind, rights basis, purpose, jurisdiction (state + county), effective / revision date,
 * checklist mapping, intended signer roles, field mapping, checksum (upload), owner scope, version, and on retirement its replacement.
 *
 * AUTHORITY (CLAUDE.md §4 — permission follows seat + tenant ownership as the code already defines it): the actor is resolved from
 * the SESSION by resolvePacketActor (an ACTIVE tenant staff seat — a contact or vendor seat is refused there). Brokerage-wide and
 * office forms are the oversight class's; a team's form is its lead's (or oversight's); any active staff seat may add a SUPPLEMENTAL
 * form for THEMSELVES only (packet type custom / disclosure) — never a brokerage master, never someone else's.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { SignerRole } from "./esign-anchors"
import {
  FORM_PACKET_BUCKET, FORM_PACKET_TYPES, mayManagePacketOwner, registerTenantFormPacket, retireTenantFormPacket, packetChecksum, usableTenantPacketPaths,
  type PacketActor, type PacketProvenance, type TenantPacketRow,
} from "./tenant-form-packets"
import { findProviderFormById, type ProviderRefusal } from "./provider-form-directory"
import type { ITransactionProvider } from "@/lib/integrations/providers/transaction-provider.interface"

type Svc = SupabaseClient<any, any, any>

/** MIRRORS m1005 brokerage_form_library_source_kind_check. */
export const FORM_LIBRARY_SOURCE_KINDS = ["brokerage_upload", "agent_upload", "state_preconfigured", "connected_provider", "platform_catalogue"] as const
/** MIRRORS m1005 brokerage_form_library_rights_basis_check — the right under which the tenant may use the form. */
export const FORM_RIGHTS_BASES = ["own_form", "association_membership", "provider_license", "state_mandated_public", "platform_catalogue_license"] as const
/** MIRRORS m1005 brokerage_form_library_purpose_check — what the form is FOR (a finer word than packet_type). */
export const FORM_PURPOSES = ["listing", "buyer_representation", "offer", "counter_offer", "addendum", "price_change", "inspection", "disclosure", "agency", "compliance", "closing", "other"] as const
/** The intended signer roles — the e-sign anchor vocabulary (lib/forms/esign-anchors.ts SignerRole), never a second spelling. */
export const FORM_SIGNER_ROLES = ["buyer", "co_buyer", "seller", "co_seller", "agent", "listing_agent"] as const satisfies readonly SignerRole[]
/** Packet types an individual agent may add for themselves (supplemental only). */
export const SUPPLEMENTAL_PACKET_TYPES = ["custom", "disclosure"] as const

const DATE = /^\d{4}-\d{2}-\d{2}$/
const KEY = /^[a-z0-9][a-z0-9_.:-]{1,79}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface FormOwner { teamId?: string | null; locationId?: string | null; scopeUserId?: string | null }

export interface AddFormInput {
  mode: "upload" | "state_preconfigured" | "provider_form"
  owner: FormOwner
  name: string
  state: string
  packetType: string
  formCode?: string | null
  description?: string | null
  licenseNote?: string | null
  licenseExpiresAt?: string | null
  rightsBasis: string
  purpose: string
  county?: string | null
  effectiveOn: string
  revisionDate?: string | null
  checklistKeys: string[]
  signerRoles: string[]
  fieldMapping?: Record<string, string> | null
  /** upload only */
  fileName?: string | null
  bytes?: Uint8Array | null
  /** provider_form only */
  providerFormId?: string | null
}

/** PURE: the provenance rules. Returns the refusal sentence, or null. */
export function validateFormProvenance(input: AddFormInput, now: Date = new Date()): string | null {
  if (!(FORM_RIGHTS_BASES as readonly string[]).includes(input.rightsBasis)) return `Say under what right the brokerage may use this form (${FORM_RIGHTS_BASES.join(", ")}).`
  if (input.mode === "upload" && input.rightsBasis === "platform_catalogue_license") return "A platform-catalogue form is added from the catalogue, not uploaded."
  if (input.mode === "provider_form" && input.rightsBasis !== "provider_license") return "A provider-library form is used under the provider license."
  if (input.mode === "state_preconfigured" && input.rightsBasis === "platform_catalogue_license") return "A state form is held under your own right (association membership, own form or public state form)."
  if ((input.rightsBasis === "association_membership" || input.rightsBasis === "provider_license") && input.mode === "upload" && !(input.licenseNote ?? "").trim()) return "Record the license this form is held under (association membership number or provider agreement)."
  if (!(FORM_PURPOSES as readonly string[]).includes(input.purpose)) return `"${input.purpose}" is not a form purpose (${FORM_PURPOSES.join(", ")}).`
  if (!DATE.test(input.effectiveOn ?? "")) return "Give the date the form takes effect (YYYY-MM-DD)."
  if (input.revisionDate && !DATE.test(input.revisionDate)) return "The revision date must be a date (YYYY-MM-DD)."
  if (input.revisionDate && input.revisionDate > now.toISOString().slice(0, 10)) return "The revision date cannot be in the future — use the effective date for a form that starts later."
  if (input.county != null && input.county !== "" && !/^[A-Za-z .'-]{2,60}$/.test(input.county)) return "The county must be a county name."
  if (!Array.isArray(input.checklistKeys) || input.checklistKeys.some((k) => !KEY.test(k))) return "Checklist mapping keys are short lowercase codes (letters, digits, _ . : -)."
  const sharedOwner = !input.owner.scopeUserId
  if (sharedOwner && input.checklistKeys.length === 0) return "Map the form to at least one checklist item so compliance review can find it."
  if (!Array.isArray(input.signerRoles) || input.signerRoles.some((r) => !(FORM_SIGNER_ROLES as readonly string[]).includes(r))) return `Intended signers must be from: ${FORM_SIGNER_ROLES.join(", ")}.`
  if (input.fieldMapping) {
    for (const [field, key] of Object.entries(input.fieldMapping)) {
      if (!field.trim() || field.length > 200) return "A mapped field name is empty or too long."
      if (!KEY.test(String(key))) return `Field "${field}" maps to "${key}", which is not a data key.`
    }
  }
  if (input.owner.scopeUserId && !(SUPPLEMENTAL_PACKET_TYPES as readonly string[]).includes(input.packetType)) return "An individual agent may add a supplemental (custom or disclosure) form only — brokerage masters are added by the brokerage."
  if (!(FORM_PACKET_TYPES as readonly string[]).includes(input.packetType)) return `"${input.packetType}" is not a packet type.`
  return null
}

/** PURE: the required-form names a state's package defines for a purpose — from the state registry, never a universal list. */
export async function statePackageFormNames(state: string, kind: "offer" | "listing"): Promise<string[] | null> {
  const { STATE_FORMS } = await import("@/lib/state-forms/registry")
  const set = STATE_FORMS[state.trim().toUpperCase() as keyof typeof STATE_FORMS]
  if (!set) return null
  const b = set[kind]
  return [...b.required, ...b.addenda, b.brokerageRepresentation].filter(Boolean)
}

export type AddFormResult =
  | { ok: true; packet: TenantPacketRow; existing: boolean; status: "ready" | "not_configured" }
  | { ok: false; error: string; refusal?: ProviderRefusal }

/**
 * Add a form to the tenant library by one of the three doors. The actor is the SESSION's resolved packet actor; the provider (for
 * provider_form) is the tenant's connected provider resolved by the route — injected so a counted stub drives the proof.
 */
export async function addFormToLibrary(
  svc: Svc,
  actor: PacketActor,
  input: AddFormInput,
  deps: { provider?: Pick<ITransactionProvider, "listForms"> | null; providerName?: string | null; now?: Date } = {},
): Promise<AddFormResult> {
  const owner = { teamId: input.owner.teamId || null, locationId: input.owner.locationId || null, scopeUserId: input.owner.scopeUserId || null }
  const bad = validateFormProvenance({ ...input, owner }, deps.now)
  if (bad) return { ok: false, error: bad }
  if (!mayManagePacketOwner(actor, owner) || (owner.scopeUserId && owner.scopeUserId !== actor.userId && !actor.oversight)) {
    return { ok: false, error: "You do not have authority to add a form for that owner. Agents add supplemental forms for themselves; the brokerage, an office or a team's library is managed by its admins or team lead." }
  }
  const base = {
    teamId: owner.teamId, locationId: owner.locationId, scopeUserId: owner.scopeUserId, name: input.name, state: input.state, packetType: input.packetType,
    formCode: input.formCode ?? null, description: input.description ?? null, licenseNote: input.licenseNote ?? null, licenseExpiresAt: input.licenseExpiresAt ?? null,
  }
  const pv: PacketProvenance = {
    sourceKind: input.mode === "upload" ? (owner.scopeUserId ? "agent_upload" : "brokerage_upload") : input.mode === "state_preconfigured" ? "state_preconfigured" : "connected_provider",
    rightsBasis: input.rightsBasis, purpose: input.purpose, county: input.county || null, effectiveOn: input.effectiveOn, revisionDate: input.revisionDate || null,
    checklistKeys: input.checklistKeys, signerRoles: input.signerRoles, fieldMapping: input.fieldMapping ?? null,
  }

  if (input.mode === "upload") {
    if (!input.bytes || input.bytes.length === 0) return { ok: false, error: "Attach the form's PDF." }
    // A duplicate of a form already in this owner's library (same bytes) is the SAME form, not a second record.
    const sum = await packetChecksum(input.bytes)
    const { data: dup, error: dupErr } = await svc.from("brokerage_form_library").select("id, name").eq("brokerage_id", actor.brokerageId).eq("checksum_sha256", sum).eq("is_active", true)
    if (dupErr) return { ok: false, error: `Your library could not be checked for duplicates: ${dupErr.message}` }
    if ((dup ?? []).length > 0) return { ok: false, error: `This exact file is already in your library as "${(dup as Array<{ name: string }>)[0].name}". Upload a new revision of that form instead.` }
    const r = await registerTenantFormPacket(svc, actor, { ...base, fileName: input.fileName ?? "form.pdf", bytes: input.bytes, provenance: pv })
    return r.ok ? { ok: true, packet: r.packet, existing: false, status: "ready" } : r
  }

  if (input.mode === "state_preconfigured") {
    const kind = input.purpose === "listing" ? "listing" : "offer"
    const names = await statePackageFormNames(input.state, kind)
    if (!names) return { ok: false, error: `"${input.state}" is not a state the registry knows.` }
    if (!names.some((n) => n.toLowerCase() === input.name.trim().toLowerCase())) return { ok: false, error: `"${input.name}" is not in ${input.state.toUpperCase()}'s ${kind} package. Choose one of: ${names.join("; ")}.` }
    const r = await registerTenantFormPacket(svc, actor, { ...base, fileName: null, bytes: null, provenance: pv })
    // No bytes and no provider form: a named requirement that reads `not configured` until a licensed file or provider form is linked.
    return r.ok ? { ok: true, packet: r.packet, existing: false, status: "not_configured" } : r
  }

  // provider_form — a REFERENCE to the provider's authorized form; no bytes are fetched or stored.
  if (!deps.provider || !deps.providerName) return { ok: false, error: "No legal-forms provider is connected.", refusal: { code: "no_provider_selected", message: "No legal-forms provider is selected for you, your team or your brokerage.", recoverHref: "/settings/integrations", retryable: false } }
  const formId = String(input.providerFormId ?? "").trim()
  if (!formId || formId.length > 200) return { ok: false, error: "Give the provider form id." }
  const found = await findProviderFormById(deps.provider, formId)
  if (!found.ok) return { ok: false, error: found.refusal.message, refusal: found.refusal }
  // Idempotent: the same provider form already referenced for this owner is returned, not duplicated.
  let q = svc.from("brokerage_form_library").select("id").eq("brokerage_id", actor.brokerageId).eq("provider_name", deps.providerName).eq("provider_form_id", formId).eq("is_active", true)
  q = owner.teamId ? q.eq("team_id", owner.teamId) : q.is("team_id", null)
  q = owner.locationId ? q.eq("location_id", owner.locationId) : q.is("location_id", null)
  q = owner.scopeUserId ? q.eq("scope_user_id", owner.scopeUserId) : q.is("scope_user_id", null)
  const { data: have, error: haveErr } = await q
  if (haveErr) return { ok: false, error: `Your library could not be read: ${haveErr.message}` }
  if ((have ?? []).length > 0) {
    const { data: row, error: rowErr } = await svc.from("brokerage_form_library").select("*").eq("id", (have as Array<{ id: string }>)[0].id).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (rowErr || !row) return { ok: false, error: `Your library could not be read: ${rowErr?.message ?? "row vanished"}` }
    return { ok: true, packet: row as TenantPacketRow, existing: true, status: "ready" }
  }
  const r = await registerTenantFormPacket(svc, actor, {
    ...base, name: input.name || found.form.name, fileName: null, bytes: null,
    provenance: { ...pv, providerName: deps.providerName, providerFormId: formId, providerFormVersion: found.form.version ?? null },
  })
  return r.ok ? { ok: true, packet: r.packet, existing: false, status: "ready" } : r
}

/**
 * A NEW REVISION of a library form: the new PDF becomes a new row (version + 1, same owner, provenance carried, the new revision
 * date), and the old row is RETIRED with `replaced_by_id` naming it — so a retired PDF is never offered or filled again
 * (usableTenantPacketPaths admits active rows only) and the history stays. An identical file is refused (it is not a revision).
 */
export async function reviseLibraryForm(
  svc: Svc,
  actor: PacketActor,
  packetId: string,
  input: { fileName: string; bytes: Uint8Array; revisionDate: string; effectiveOn: string },
): Promise<{ ok: true; packet: TenantPacketRow; retiredId: string } | { ok: false; error: string }> {
  if (!UUID.test(packetId)) return { ok: false, error: "That is not a packet id." }
  if (!DATE.test(input.revisionDate) || !DATE.test(input.effectiveOn)) return { ok: false, error: "Give the revision date and the effective date (YYYY-MM-DD)." }
  const { data, error } = await svc.from("brokerage_form_library").select("*").eq("id", packetId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `The form could not be read: ${error.message}` }
  if (!data) return { ok: false, error: "That form is not in your brokerage." }
  const cur = data as TenantPacketRow
  if (!cur.is_active) return { ok: false, error: "That form is retired — revise its replacement instead." }
  if (cur.provider_form_id) return { ok: false, error: "A provider-library form is revised by the provider, not uploaded here." }
  const owner = { teamId: cur.team_id, locationId: cur.location_id ?? null, scopeUserId: cur.scope_user_id ?? null }
  if (!mayManagePacketOwner(actor, owner)) return { ok: false, error: "You cannot revise a form you do not manage." }
  if (cur.checksum_sha256 && cur.checksum_sha256 === (await packetChecksum(input.bytes))) return { ok: false, error: "That file is identical to the current version — nothing to revise." }
  const made = await registerTenantFormPacket(svc, actor, {
    ...owner, name: cur.name, state: cur.state, packetType: cur.packet_type, formCode: cur.form_code, description: cur.description,
    licenseNote: cur.license_note, licenseExpiresAt: cur.license_expires_at, fileName: input.fileName, bytes: input.bytes, version: (cur.version ?? 1) + 1,
    provenance: {
      sourceKind: cur.source_kind ?? (owner.scopeUserId ? "agent_upload" : "brokerage_upload"), rightsBasis: cur.rights_basis ?? "own_form", purpose: cur.purpose ?? "other",
      county: cur.county ?? null, effectiveOn: input.effectiveOn, revisionDate: input.revisionDate, checklistKeys: cur.checklist_keys ?? [], signerRoles: cur.signer_roles ?? [], fieldMapping: cur.field_mapping ?? null,
    },
  })
  if (!made.ok) return made
  const retired = await retireTenantFormPacket(svc, actor, packetId, { replacedById: made.packet.id })
  if (!retired.ok) {
    // Never leave two live versions: the new row is retired again and the refusal said.
    await retireTenantFormPacket(svc, actor, made.packet.id)
    return { ok: false, error: `The old version could not be retired (${retired.error}); the new upload was withdrawn.` }
  }
  return { ok: true, packet: made.packet, retiredId: packetId }
}

/** PURE: the status a library row shows in the picker — a row with no master and no provider link is a NAMED requirement only. */
export function libraryFormStatus(row: Pick<TenantPacketRow, "is_active" | "storage_path" | "provider_form_id" | "license_expires_at">, today: string = new Date().toISOString().slice(0, 10)): "ready" | "not_configured" | "retired" | "license_expired" {
  if (!row.is_active) return "retired"
  if (row.license_expires_at && row.license_expires_at < today) return "license_expired"
  if (!row.storage_path && !row.provider_form_id) return "not_configured"
  return "ready"
}

// ── WAVE 156 (156C, round 2): THE LICENSE / VERSION STANDING OF A FORM REFERENCE — the seam lane 156B's representation gate asks ──

export type FormLicenseStanding =
  | { standing: "licensed_current"; packetId: string; version: number | null; providerFormVersion: string | null }
  | { standing: "retired"; packetId: string; replacementPacketId: string | null }
  | { standing: "license_expired"; packetId: string; expiredOn: string }
  | { standing: "unknown"; reason: string }

/**
 * For a TENANT (the caller's session brokerage — never a body value), a STATE, a FORM REFERENCE and optionally the VERSION the
 * paperwork carries: is that form licensed and current in the tenant's directory, retired (with its replacement), license-expired,
 * or unknown to the directory? Reads brokerage_form_library only, tenant-pinned; a refused read is an error, never "unknown".
 *   · ref.packetId — the library row; ref.providerName + ref.providerFormId — an adopted provider form; ref.formCode / ref.name —
 *     matched within the STATE only (case-insensitive), never across states.
 *   · version — the row's integer `version` or the provider's `provider_form_version`. A version that is not the current one is
 *     `retired` with the current row as its replacement (the paperwork used a superseded revision).
 */
export async function formLicenseStanding(
  svc: Svc,
  q: { brokerageId: string; state: string; ref: { packetId?: string | null; providerName?: string | null; providerFormId?: string | null; formCode?: string | null; name?: string | null }; version?: string | number | null; now?: Date },
): Promise<{ ok: true; result: FormLicenseStanding } | { ok: false; error: string }> {
  const state = (q.state ?? "").trim().toUpperCase()
  if (!UUID.test(q.brokerageId ?? "")) return { ok: false, error: "no tenant" }
  const { data, error } = await svc.from("brokerage_form_library")
    .select("id, state, name, form_code, version, is_active, license_expires_at, replaced_by_id, provider_name, provider_form_id, provider_form_version")
    .eq("brokerage_id", q.brokerageId)
  if (error) return { ok: false, error: `the form directory could not be read: ${error.message}` }
  type Row = Pick<TenantPacketRow, "id" | "state" | "name" | "form_code" | "version" | "is_active" | "license_expires_at" | "replaced_by_id" | "provider_name" | "provider_form_id" | "provider_form_version">
  const rows = (data ?? []) as Row[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase()
  const r = q.ref
  let hits: Row[]
  if (r.packetId) hits = rows.filter((x) => x.id === r.packetId)
  else if (r.providerFormId) hits = rows.filter((x) => x.provider_form_id === r.providerFormId && (!r.providerName || lc(x.provider_name) === lc(r.providerName)))
  else if (r.formCode) hits = rows.filter((x) => lc(x.form_code) === lc(r.formCode))
  else if (r.name) hits = rows.filter((x) => lc(x.name) === lc(r.name))
  else return { ok: true, result: { standing: "unknown", reason: "no form reference given" } }
  hits = hits.filter((x) => String(x.state).toUpperCase() === state)
  if (hits.length === 0) return { ok: true, result: { standing: "unknown", reason: `the directory has no such form for ${state || "that state"}` } }
  const finalOf = (row: Row): Row => { let cur = row; for (let i = 0; i < 10 && !cur.is_active && cur.replaced_by_id && byId.has(cur.replaced_by_id); i++) cur = byId.get(cur.replaced_by_id)!; return cur }
  const active = hits.find((x) => x.is_active) ?? null
  const v = q.version == null || q.version === "" ? null : String(q.version)
  const matchesVersion = (x: Row) => v === null || String(x.version ?? "") === v || (x.provider_form_version ?? "") === v
  const named = v === null ? (active ?? hits[0]) : (hits.find(matchesVersion) ?? null)
  if (!named) {
    return { ok: true, result: active ? { standing: "retired", packetId: hits[0].id, replacementPacketId: active.id } : { standing: "unknown", reason: `version ${v} is not in the directory` } }
  }
  if (!named.is_active) {
    const repl = finalOf(named)
    return { ok: true, result: { standing: "retired", packetId: named.id, replacementPacketId: repl.is_active && repl.id !== named.id ? repl.id : (active?.id ?? null) } }
  }
  const today = (q.now ?? new Date()).toISOString().slice(0, 10)
  if (named.license_expires_at && named.license_expires_at < today) return { ok: true, result: { standing: "license_expired", packetId: named.id, expiredOn: named.license_expires_at } }
  return { ok: true, result: { standing: "licensed_current", packetId: named.id, version: named.version ?? null, providerFormVersion: named.provider_form_version ?? null } }
}

// ── WAVE 156 (156C, round 2): A LIBRARY FORM ONTO A DEAL — a WORKING COPY; the packet master is never touched ──────────────────────

export interface StageOnDealDeps {
  /** The deal desk (lib/transactions/role-guard.ts decideDealDesk) — who may work this deal. */
  dealDesk?: (ctx: { userId: string; role: string; brokerageId: string; transactionId: string }) => Promise<{ allowed: boolean; reason?: string }>
  /** Files the working copy as a deal document (the private `documents` bucket + lib/documents/upload-document.ts). */
  file?: (svc: Svc, input: { brokerageId: string; transactionId: string; path: string; bytes: Uint8Array; fileName: string; metadata: Record<string, unknown> }) => Promise<{ ok: true; documentId: string } | { ok: false; error: string }>
}

const defaultFile: NonNullable<StageOnDealDeps["file"]> = async (svc, input) => {
  const { error: upErr } = await svc.storage.from("documents").upload(input.path, input.bytes as never, { contentType: "application/pdf", upsert: false })
  if (upErr && !/exists/i.test(upErr.message)) return { ok: false, error: `the working copy could not be stored: ${upErr.message}` }
  const { issueBucketObjectUrl } = await import("@/lib/storage/document-buckets")
  const issued = await issueBucketObjectUrl(svc as never, { bucket: "documents", objectPath: input.path })
  if (!issued.ok) return { ok: false, error: `the working copy was stored but no link could be issued: ${issued.reason}` }
  const { uploadDocument } = await import("@/lib/documents/upload-document")
  const r = await uploadDocument({ brokerageId: input.brokerageId, storageUrl: issued.url, fileName: input.fileName, documentType: "addendum", transactionId: input.transactionId, metadata: { ...input.metadata, storage_path: input.path } })
  return r.success && r.documentId ? { ok: true, documentId: r.documentId } : { ok: false, error: r.error ?? "the working copy could not be filed" }
}

/**
 * Put a library form (e.g. an addendum) on a DEAL as a working copy the parties will sign. The actor must be a forms seat that may
 * USE the master (active, in license, their scope) AND may work the deal (the deal desk: the coordinator and the brokerage's admins on
 * any deal of the tenant, an agent on their own deal, a lead on their team's). The master's bytes are COPIED into the deal's own
 * document — the master row and object are never written — and the copy records the master id, version and checksum it came from.
 * The next step is the existing addendum door (lib/esign/addendum-signature-request.ts proposeContractAddendumVersion → request).
 */
export async function stageLibraryFormOnDeal(
  svc: Svc,
  actor: PacketActor,
  input: { packetId: string; transactionId: string },
  deps: StageOnDealDeps = {},
): Promise<{ ok: true; documentId: string; sourceChecksum: string } | { ok: false; error: string }> {
  if (!UUID.test(input.packetId) || !UUID.test(input.transactionId)) return { ok: false, error: "Name the library form and the deal." }
  const desk = deps.dealDesk ?? (async (ctx) => { const { decideDealDesk } = await import("@/lib/transactions/role-guard"); const d = await decideDealDesk(ctx); return d.allowed ? { allowed: true } : { allowed: false, reason: d.reason } })
  const decided = await desk({ userId: actor.userId, role: actor.userType ?? "", brokerageId: actor.brokerageId, transactionId: input.transactionId })
  if (!decided.allowed) return { ok: false, error: decided.reason ?? "You cannot work on this deal." }
  const { data: row, error } = await svc.from("brokerage_form_library").select("id, name, storage_path, version, checksum_sha256").eq("id", input.packetId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `The form could not be read: ${error.message}` }
  if (!row?.storage_path) return { ok: false, error: "That form has no master in your library (a provider form is used through the provider's window)." }
  const usable = await usableTenantPacketPaths(svc, actor, [row.storage_path as string])
  if (!usable.ok) return { ok: false, error: usable.error }
  if (!usable.usable.has(row.storage_path as string)) return { ok: false, error: "That form is not available to you (retired, out of license, or shared with another team or office)." }
  const { data: blob, error: dlErr } = await svc.storage.from(FORM_PACKET_BUCKET).download(row.storage_path as string)
  if (dlErr || !blob) return { ok: false, error: `The form could not be opened: ${dlErr?.message ?? "no file"}` }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const sum = await packetChecksum(bytes)
  if (row.checksum_sha256 && row.checksum_sha256 !== sum) return { ok: false, error: "The stored master does not match its recorded checksum — it was not used. Compliance should re-upload it." }
  const safe = String(row.name).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "form"
  const filed = await (deps.file ?? defaultFile)(svc, {
    brokerageId: actor.brokerageId, transactionId: input.transactionId, path: `${actor.brokerageId}/transactions/${input.transactionId}/library-forms/${row.id}-v${row.version ?? 1}-${sum.slice(0, 12)}.pdf`,
    bytes, fileName: `${safe}.pdf`, metadata: { source_library_form_id: row.id, source_library_version: row.version ?? 1, source_checksum_sha256: sum, staged_by: actor.userId },
  })
  if (!filed.ok) return filed
  return { ok: true, documentId: filed.documentId, sourceChecksum: sum }
}
