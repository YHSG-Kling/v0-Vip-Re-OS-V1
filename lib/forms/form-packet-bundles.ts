/**
 * lib/forms/form-packet-bundles.ts — PACKET BUNDLES: ORDERED, REQUIRED/OPTIONAL, PER STATE AND OFFICE (wave 156, lane 156C, m1006).
 *
 * Owner (wave 156): packet bundles (listing, buyer representation, outside offer, counter, price change, inspection addendum, closing
 * packet …) with editable ordered items and required/optional markers. Individual users can add authorized custom supplemental forms
 * but cannot delete required brokerage/legal forms. State or county policy can add required items; there is no universal all-state
 * list. A current required form unavailable under the tenant's license shows `not configured / request access / add licensed file`
 * with a recoverable route — it never pretends to exist.
 *
 * WHAT WAS TRUE BEFORE: a "package" existed only as the state registry's NAMES (lib/state-forms/registry.ts) matched by token overlap
 * to library file names (lib/forms/state-package-match.ts). A brokerage could not say "our TX listing packet is these six forms in
 * this order, these four required", an office could not differ from the brokerage, and nothing told the agent which required form the
 * brokerage simply does not hold a license for.
 *
 * THE RULES (code below; checks in scripts/wave156-c-forms-directory-guard.ts):
 *   · A bundle is owned like a packet: brokerage-wide or one office (oversight class) or one team (its lead or oversight).
 *   · A deal resolves to EXACTLY ONE bundle — the most specific one that applies to the actor (team › office › brokerage) for the
 *     deal's state and kind. Two bundles' items are never mixed; a bundle of another state or office never applies.
 *   · Items carry their requirement source. `state_policy` / `county_policy` items cannot be removed through this door by anyone (they
 *     are the law of the jurisdiction as the brokerage recorded it); a brokerage/office/team required item is removed only by that
 *     owner's manager; a user's supplemental item is optional, belongs to that user, and is removed by that user or a manager.
 *   · A county_policy item applies only to a deal in that county.
 *   · Every item resolves to a status: ready (a live master or an adopted provider form), replaced (a retired master whose replacement
 *     is used — the retired PDF is never handed out), retired (no replacement), license_expired, not_configured.
 *
 * Writes use the service client AFTER the route's session gate, tenant-pinned and COUNTED (CLAUDE.md §3).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { mayManagePacketOwner, type PacketActor, type TenantPacketRow } from "./tenant-form-packets"
import { libraryFormStatus } from "./form-directory-intake"

type Svc = SupabaseClient<any, any, any>

/** MIRRORS m1006 form_packet_bundles_bundle_kind_check. */
export const PACKET_BUNDLE_KINDS = ["listing", "buyer_representation", "offer", "outside_offer", "counter_offer", "price_change", "inspection_addendum", "closing", "custom"] as const
export type PacketBundleKind = (typeof PACKET_BUNDLE_KINDS)[number]
/** MIRRORS m1006 form_packet_bundle_items_requirement_source_check. */
export const BUNDLE_REQUIREMENT_SOURCES = ["brokerage", "office", "team", "state_policy", "county_policy", "user_supplemental"] as const
export type BundleRequirementSource = (typeof BUNDLE_REQUIREMENT_SOURCES)[number]
/** Requirement sources NO ONE removes through this door — the jurisdiction's own rule as recorded. */
export const LEGAL_REQUIREMENT_SOURCES: ReadonlySet<BundleRequirementSource> = new Set(["state_policy", "county_policy"])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface BundleRow {
  id: string; brokerage_id: string; team_id: string | null; location_id: string | null; state: string; county: string | null
  bundle_kind: string; name: string; is_active: boolean; created_by: string | null
}
export interface BundleItemRow {
  id: string; brokerage_id: string; bundle_id: string; position: number; library_form_id: string | null; provider_name: string | null
  provider_form_id: string | null; required_name: string; is_required: boolean; requirement_source: string; county: string | null
  added_by: string | null; removed_at: string | null
}

const bundleOwner = (b: Pick<BundleRow, "team_id" | "location_id">) => ({ teamId: b.team_id, locationId: b.location_id, scopeUserId: null })

/** PURE: does this bundle APPLY to this actor (their office / team, or brokerage-wide)? Oversight does not widen applicability — a
 *  deal uses the bundle of the seat working it. */
export function bundleAppliesTo(b: Pick<BundleRow, "brokerage_id" | "team_id" | "location_id" | "is_active">, actor: PacketActor): boolean {
  if (b.brokerage_id !== actor.brokerageId || !b.is_active) return false
  if (b.team_id && b.team_id !== actor.teamId) return false
  if (b.location_id && b.location_id !== (actor.locationId ?? null)) return false
  return true
}

/** PURE: specificity — team 3, office 2, brokerage 1. */
const specificity = (b: Pick<BundleRow, "team_id" | "location_id">) => (b.team_id ? 3 : b.location_id ? 2 : 1)

export async function createPacketBundle(
  svc: Svc, actor: PacketActor,
  input: { kind: string; name: string; state: string; county?: string | null; teamId?: string | null; locationId?: string | null },
): Promise<{ ok: true; bundle: BundleRow } | { ok: false; error: string }> {
  if (!(PACKET_BUNDLE_KINDS as readonly string[]).includes(input.kind)) return { ok: false, error: `"${input.kind}" is not a bundle kind (${PACKET_BUNDLE_KINDS.join(", ")}).` }
  if (input.name.trim().length < 3) return { ok: false, error: "Name the bundle (at least 3 characters)." }
  const state = input.state.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(state)) return { ok: false, error: "Choose the state the bundle is for (two-letter code)." }
  const owner = { teamId: input.teamId || null, locationId: input.locationId || null, scopeUserId: null }
  if (owner.teamId && owner.locationId) return { ok: false, error: "A bundle belongs to the brokerage, one office or one team." }
  if (!mayManagePacketOwner(actor, owner)) return { ok: false, error: "Only the brokerage's admins (or a team's lead, for their team) can create a packet bundle." }
  if (owner.locationId) {
    const { data, error } = await svc.from("locations").select("id").eq("id", owner.locationId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (error) return { ok: false, error: `The office could not be verified: ${error.message}` }
    if (!data) return { ok: false, error: "That office is not in your brokerage." }
  }
  if (owner.teamId) {
    const { data, error } = await svc.from("teams").select("id").eq("id", owner.teamId).eq("brokerage_id", actor.brokerageId).is("deleted_at", null).maybeSingle()
    if (error) return { ok: false, error: `The team could not be verified: ${error.message}` }
    if (!data) return { ok: false, error: "That team is not in your brokerage." }
  }
  const { data, error } = await svc.from("form_packet_bundles").insert({
    brokerage_id: actor.brokerageId, team_id: owner.teamId, location_id: owner.locationId, state, county: input.county?.trim() || null,
    bundle_kind: input.kind, name: input.name.trim(), is_active: true, created_by: actor.userId,
  }).select("*")
  if (error || !data || data.length !== 1) return { ok: false, error: `The bundle was not created: ${error?.message ?? "no row returned"}` }
  return { ok: true, bundle: (data as BundleRow[])[0] }
}

async function readBundle(svc: Svc, actor: PacketActor, bundleId: string): Promise<{ ok: true; bundle: BundleRow } | { ok: false; error: string }> {
  if (!UUID.test(bundleId)) return { ok: false, error: "That is not a bundle id." }
  const { data, error } = await svc.from("form_packet_bundles").select("*").eq("id", bundleId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `The bundle could not be read: ${error.message}` }
  if (!data) return { ok: false, error: "That bundle is not in your brokerage." }
  return { ok: true, bundle: data as BundleRow }
}

async function activeItems(svc: Svc, actor: PacketActor, bundleId: string): Promise<{ ok: true; items: BundleItemRow[] } | { ok: false; error: string }> {
  const { data, error } = await svc.from("form_packet_bundle_items").select("*").eq("bundle_id", bundleId).eq("brokerage_id", actor.brokerageId).is("removed_at", null)
  if (error) return { ok: false, error: `The bundle's items could not be read: ${error.message}` }
  return { ok: true, items: ((data ?? []) as BundleItemRow[]).sort((a, b) => a.position - b.position) }
}

/**
 * Add an item. The bundle's MANAGER adds required or optional items (owner / state / county policy sources). Any active seat the
 * bundle applies to may add an OPTIONAL supplemental item that points at a form THEY may use — never a required one. A library form of
 * another state or another brokerage is refused (bundles never mix jurisdictions).
 */
export async function addBundleItem(
  svc: Svc, actor: PacketActor, bundleId: string,
  input: { libraryFormId?: string | null; providerName?: string | null; providerFormId?: string | null; requiredName: string; isRequired: boolean; requirementSource: string; county?: string | null },
): Promise<{ ok: true; item: BundleItemRow } | { ok: false; error: string }> {
  const b = await readBundle(svc, actor, bundleId)
  if (!b.ok) return b
  const bundle = b.bundle
  if (!bundle.is_active) return { ok: false, error: "That bundle is retired." }
  if (!(BUNDLE_REQUIREMENT_SOURCES as readonly string[]).includes(input.requirementSource)) return { ok: false, error: `"${input.requirementSource}" is not a requirement source.` }
  const manager = mayManagePacketOwner(actor, bundleOwner(bundle))
  if (!manager) {
    if (!bundleAppliesTo(bundle, actor)) return { ok: false, error: "That bundle is not yours to add to." }
    if (input.isRequired || input.requirementSource !== "user_supplemental") return { ok: false, error: "You can add an optional supplemental form to this packet; required forms are set by the brokerage." }
  } else if (input.requirementSource === "user_supplemental" && input.isRequired) {
    return { ok: false, error: "A supplemental form is optional by definition." }
  }
  if (input.requirementSource === "county_policy" && !(input.county ?? "").trim()) return { ok: false, error: "A county requirement names its county." }
  if (input.requiredName.trim().length < 3) return { ok: false, error: "Name the form this item requires." }
  if (input.libraryFormId) {
    if (!UUID.test(input.libraryFormId)) return { ok: false, error: "That is not a library form id." }
    const { data: f, error: fErr } = await svc.from("brokerage_form_library").select("id, brokerage_id, state, is_active, team_id, location_id, scope_user_id").eq("id", input.libraryFormId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (fErr) return { ok: false, error: `The library form could not be read: ${fErr.message}` }
    if (!f) return { ok: false, error: "That form is not in your brokerage's library." }
    const form = f as Pick<TenantPacketRow, "state" | "is_active" | "team_id" | "location_id" | "scope_user_id">
    if (String(form.state).toUpperCase() !== bundle.state) return { ok: false, error: `That form is for ${form.state}; this bundle is for ${bundle.state} — bundles never mix states.` }
    if (!form.is_active) return { ok: false, error: "That form is retired — add its replacement." }
    if (!manager && form.scope_user_id && form.scope_user_id !== actor.userId) return { ok: false, error: "That supplemental form belongs to another agent." }
    if (!manager && form.team_id && form.team_id !== actor.teamId) return { ok: false, error: "That form is shared with another team." }
    if (!manager && form.location_id && form.location_id !== (actor.locationId ?? null)) return { ok: false, error: "That form is shared with another office." }
  }
  const cur = await activeItems(svc, actor, bundleId)
  if (!cur.ok) return cur
  const position = cur.items.reduce((m, i) => Math.max(m, i.position), -1) + 1
  const { data, error } = await svc.from("form_packet_bundle_items").insert({
    brokerage_id: actor.brokerageId, bundle_id: bundleId, position, library_form_id: input.libraryFormId ?? null,
    provider_name: input.providerFormId ? (input.providerName ?? null) : null, provider_form_id: input.providerFormId ?? null,
    required_name: input.requiredName.trim(), is_required: input.isRequired === true, requirement_source: input.requirementSource,
    county: input.county?.trim() || null, added_by: actor.userId, removed_at: null,
  }).select("*")
  if (error || !data || data.length !== 1) return { ok: false, error: `The item was not added: ${error?.message ?? "no row returned"}` }
  return { ok: true, item: (data as BundleItemRow[])[0] }
}

/** Remove an item (soft — removed_at). Jurisdiction-policy items: never here. Required owner items: that owner's manager only.
 *  Supplemental: its author or a manager. Tenant-pinned, counted. */
export async function removeBundleItem(svc: Svc, actor: PacketActor, itemId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!UUID.test(itemId)) return { ok: false, error: "That is not an item id." }
  const { data, error } = await svc.from("form_packet_bundle_items").select("*").eq("id", itemId).eq("brokerage_id", actor.brokerageId).is("removed_at", null).maybeSingle()
  if (error) return { ok: false, error: `The item could not be read: ${error.message}` }
  if (!data) return { ok: false, error: "That item is not in your brokerage's bundles." }
  const item = data as BundleItemRow
  const b = await readBundle(svc, actor, item.bundle_id)
  if (!b.ok) return b
  const manager = mayManagePacketOwner(actor, bundleOwner(b.bundle))
  if (LEGAL_REQUIREMENT_SOURCES.has(item.requirement_source as BundleRequirementSource)) return { ok: false, error: `"${item.required_name}" is required by ${item.requirement_source === "county_policy" ? "county" : "state"} policy and cannot be removed from the packet.` }
  if (item.is_required && !manager) return { ok: false, error: `"${item.required_name}" is a required brokerage form — it cannot be removed from the packet.` }
  if (!item.is_required && !manager && item.added_by !== actor.userId) return { ok: false, error: "That supplemental form was added by someone else." }
  const { data: upd, error: uErr } = await svc.from("form_packet_bundle_items").update({ removed_at: new Date().toISOString() }).eq("id", itemId).eq("brokerage_id", actor.brokerageId).is("removed_at", null).select("id")
  if (uErr) return { ok: false, error: `The item was not removed: ${uErr.message}` }
  if (!upd || upd.length !== 1) return { ok: false, error: "The item was not removed — it matched no live item." }
  return { ok: true }
}

/** Reorder (manager only): `orderedIds` must be exactly the bundle's live items. Each update is counted. */
export async function reorderBundleItems(svc: Svc, actor: PacketActor, bundleId: string, orderedIds: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const b = await readBundle(svc, actor, bundleId)
  if (!b.ok) return b
  if (!mayManagePacketOwner(actor, bundleOwner(b.bundle))) return { ok: false, error: "Only the bundle's manager can reorder it." }
  const cur = await activeItems(svc, actor, bundleId)
  if (!cur.ok) return cur
  const live = new Set(cur.items.map((i) => i.id))
  if (orderedIds.length !== live.size || new Set(orderedIds).size !== live.size || orderedIds.some((id) => !live.has(id))) return { ok: false, error: "The new order must list every item in the bundle exactly once." }
  for (let i = 0; i < orderedIds.length; i++) {
    const { data, error } = await svc.from("form_packet_bundle_items").update({ position: i }).eq("id", orderedIds[i]).eq("bundle_id", bundleId).eq("brokerage_id", actor.brokerageId).select("id")
    if (error || !data || data.length !== 1) return { ok: false, error: `The order was not saved at item ${i + 1}: ${error?.message ?? "matched no item"}` }
  }
  return { ok: true }
}

export interface ResolvedPacketItem {
  itemId: string
  position: number
  name: string
  required: boolean
  source: string
  status: "ready" | "replaced" | "retired" | "license_expired" | "not_configured"
  /** The library row actually used (the REPLACEMENT when the original is retired), or null. */
  packetId: string | null
  /** The tenant master path to fill (never a retired row's path), or null. */
  path: string | null
  providerName: string | null
  providerFormId: string | null
  /** For a form not configured: what the seat can do, and where. */
  actions: Array<"request_access" | "add_licensed_file" | "link_provider_form">
  recoverHref: string | null
}

export interface ResolvedDealPacket {
  bundle: Pick<BundleRow, "id" | "name" | "state" | "bundle_kind" | "team_id" | "location_id"> | null
  items: ResolvedPacketItem[]
  /** Required items that are not usable — the packet is not complete until these are configured. */
  missingRequired: number
}

/**
 * The deal's packet: ONE bundle (the most specific that applies to the actor for this state and kind), its live items in order, the
 * county items only for that county, the actor's OWN supplemental items only, each resolved to a usable master or a named gap.
 */
export async function resolveDealPacket(
  svc: Svc, actor: PacketActor,
  q: { kind: PacketBundleKind; state: string; county?: string | null; now?: Date },
): Promise<{ ok: true; packet: ResolvedDealPacket } | { ok: false; error: string }> {
  const state = q.state.trim().toUpperCase()
  const { data, error } = await svc.from("form_packet_bundles").select("*").eq("brokerage_id", actor.brokerageId).eq("state", state).eq("bundle_kind", q.kind).eq("is_active", true)
  if (error) return { ok: false, error: `Your packet bundles could not be read: ${error.message}` }
  const candidates = ((data ?? []) as BundleRow[]).filter((b) => b.state === state && bundleAppliesTo(b, actor))
  if (candidates.length === 0) return { ok: true, packet: { bundle: null, items: [], missingRequired: 0 } }
  const bundle = [...candidates].sort((a, b) => specificity(b) - specificity(a))[0]
  const cur = await activeItems(svc, actor, bundle.id)
  if (!cur.ok) return cur
  const county = (q.county ?? "").trim().toLowerCase()
  const items = cur.items.filter((i) =>
    (i.requirement_source !== "county_policy" || (!!county && (i.county ?? "").toLowerCase() === county))
    && (i.requirement_source !== "user_supplemental" || i.added_by === actor.userId))
  const formIds = [...new Set(items.map((i) => i.library_form_id).filter((x): x is string => !!x))]
  const forms = new Map<string, TenantPacketRow>()
  if (formIds.length > 0) {
    const { data: rows, error: fErr } = await svc.from("brokerage_form_library").select("*").eq("brokerage_id", actor.brokerageId).in("id", formIds)
    if (fErr) return { ok: false, error: `The bundle's forms could not be read: ${fErr.message}` }
    for (const r of (rows ?? []) as TenantPacketRow[]) forms.set(r.id, r)
    // Follow retired → replacement (one hop per pass, bounded) so a retired PDF is never the one handed out.
    for (let hop = 0; hop < 5; hop++) {
      const want = [...forms.values()].filter((r) => !r.is_active && r.replaced_by_id && !forms.has(r.replaced_by_id)).map((r) => r.replaced_by_id as string)
      if (want.length === 0) break
      const { data: rep, error: rErr } = await svc.from("brokerage_form_library").select("*").eq("brokerage_id", actor.brokerageId).in("id", want)
      if (rErr) return { ok: false, error: `A replacement form could not be read: ${rErr.message}` }
      for (const r of (rep ?? []) as TenantPacketRow[]) forms.set(r.id, r)
    }
  }
  const today = (q.now ?? new Date()).toISOString().slice(0, 10)
  const resolved: ResolvedPacketItem[] = items.map((i) => {
    const base = { itemId: i.id, position: i.position, name: i.required_name, required: i.is_required, source: i.requirement_source, providerName: i.provider_name, providerFormId: i.provider_form_id }
    if (i.provider_form_id) return { ...base, status: "ready", packetId: null, path: null, actions: [], recoverHref: null }
    let row = i.library_form_id ? forms.get(i.library_form_id) ?? null : null
    let replaced = false
    for (let hop = 0; row && !row.is_active && row.replaced_by_id && hop < 5; hop++) { row = forms.get(row.replaced_by_id) ?? null; replaced = true }
    const status = row ? libraryFormStatus(row, today) : "not_configured"
    if (row && status === "ready") {
      return { ...base, status: replaced ? "replaced" : "ready", packetId: row.id, path: row.storage_path, providerName: row.provider_name ?? base.providerName, providerFormId: row.provider_form_id ?? null, actions: [], recoverHref: null }
    }
    return {
      ...base, status: status === "ready" ? "not_configured" : status, packetId: row?.id ?? null, path: null,
      actions: ["request_access", "add_licensed_file", "link_provider_form"], recoverHref: "/dashboard/admin/transaction-forms",
    }
  })
  return {
    ok: true,
    packet: {
      bundle: { id: bundle.id, name: bundle.name, state: bundle.state, bundle_kind: bundle.bundle_kind, team_id: bundle.team_id, location_id: bundle.location_id },
      items: resolved,
      missingRequired: resolved.filter((r) => r.required && (r.status === "not_configured" || r.status === "retired" || r.status === "license_expired")).length,
    },
  }
}
