// lib/enrichment/online-audience-store.ts
//
// THE WRITER, THE READERS AND THE RUNG OF A CONTACT'S VERSIUM ONLINE-AUDIENCE IDENTIFIERS (wave 144, lane 144E).
//
// OWNER (wave 144, ruling 10): "`online_audience_append` is NOT targeting: it matches contacts' online profiles (if any) and
// appends matched online contact identifiers (hashed/alternate IDs per the real schema) to the platform record; downstream ad
// targeting is a separate governed action; appended ad-tech identifiers are never fed to email/SMS as permissioned addresses."
//
// THE SHAPE OF THE FIX (CLAUDE.md §1 — 143D left the product with no client, no writer and no reader):
//   · the CLIENT  — lib/external/versium-client.ts appendVersiumOnlineAudience (the documented response, hash-shaped values
//                   only; plaintext dropped and counted);
//   · the LEG     — lib/ai-isa/property-lookup-rail.ts runVersiumOnlineAudienceLeg (capability online_audience_match:
//                   routeCapability, budget pre-flight, ledger booking);
//   · the WRITER  — persistOnlineAudienceIdentifiers below: the identifiers land on the contact as a PROFILE BLOCK,
//                   `enrichment_profile.online_audience`, with provenance in THE one shape (field_provenance.online_audience);
//   · the RUNG    — appendOnlineAudienceForContact below, called by the contact enrichment pass
//                   (lib/enrichment/contact-enrichment-core.ts enrichContactRecord) — REQUIRED GAP ONLY;
//   · the READERS — onlineAudienceMatchKeysFor (the hashed match keys a governed ad-audience sync may add — the shape
//                   lib/ads/connectors/pii.ts HashedMatchKey already uses), onlineAudienceSummary (counts only, for a person).
//
// REQUIRED GAP (the dedup rule's "required gap → cost gate → append"): the call is made ONLY when the tenant runs at least one
// governed customer-list audience — a facebook_custom_audiences row with a consent basis, not a look-alike, approved / synced /
// pending review — on a platform Versium serves, and ONLY for those platforms' sections; and only when the contact's block is
// absent or older than ONLINE_AUDIENCE_FRESH_DAYS. A tenant that advertises nowhere pays nothing.
//
// THE FIREWALL (research ≠ activation; ad-tech IDs are never an address):
//   · nothing stored here is an e-mail address or a phone number — every value is a hash or a mobile ad ID, re-validated on
//     READ through versium-client.ts isOnlineAudienceIdentifier (a tampered plaintext value in the blob is dropped);
//   · no column of the contact is written — only the jsonb block — so no channel resolver (email / SMS / voice) that reads
//     contacts.email / phone / phone_secondary can ever see one;
//   · scripts/versium-capability-matrix-guard.ts section J asserts, over stripped source with a positive control, that no
//     channel / dispatch module imports this file.
//
// SAFE TO WRITE: tenant-anchored read-modify-write (id AND brokerage_id on the read and on the update); the UPDATE is
// `.select()`ed and COUNTED (an UPDATE that matches nothing also resolves — CLAUDE.md §3); every `{ error }` is read.
// Known blind spot (published): like online-presence-store.ts beside it, not an atomic JSON merge.

import type { SupabaseClient } from "@supabase/supabase-js"
import { fieldProvenanceOf, withFieldProvenance, type FieldProvenance } from "@/lib/lead-pipeline/enrichment-column-map"
import {
  isOnlineAudienceIdentifier, VERSIUM_ONLINE_AUDIENCE_SERVICES,
  type OnlineAudienceIdKind, type VersiumOnlineAudienceIdentifiers, type VersiumOnlineAudienceService,
} from "@/lib/external/versium-client"
import { hasUsableIdentifier } from "@/lib/enrichment/identifier-guard"
import { PROVIDER_FRESHNESS_DAYS } from "@/lib/enrichment/provider-dedup"

/** The profile key — one spelling, written only here (carried by provider-dedup.ts CARRIED_PROFILE_BLOCKS). */
export const ONLINE_AUDIENCE_KEY = "online_audience"

/** How long an append answers the gap. The vendor says the identifiers "may include historical contact points" and are
 *  re-linked over time, so a stale block is re-asked — an OPERATIONAL window (owner-tunable), not a legal rule. One spelling:
 *  provider-dedup.ts PROVIDER_FRESHNESS_DAYS. */
const ONLINE_AUDIENCE_FRESH_DAYS = PROVIDER_FRESHNESS_DAYS.versium_online_audience

/** facebook_custom_audiences.target_platform (live CHECK: facebook | google | instagram | linkedin | tiktok) → the Versium
 *  response section that carries that platform's match keys (Instagram audiences live under the Meta credential). */
const PLATFORM_SERVICE: Readonly<Record<string, VersiumOnlineAudienceService>> = Object.freeze({
  facebook: "facebook", instagram: "facebook", google: "google", linkedin: "linkedin", tiktok: "tiktok",
})

/** The audience statuses that mean "this tenant runs (or is about to run) this governed audience" (live CHECK vocabulary). */
const LIVE_AUDIENCE_STATUSES = ["approved", "synced", "pending_review"] as const

interface StoredBlock {
  provider: "versium"
  captured_at: string
  matched: boolean
  services_asked: VersiumOnlineAudienceService[]
  identifiers: VersiumOnlineAudienceIdentifiers["services"]
  identifier_count: number
  query_id: string | null
  dropped: { plaintext: number; malformed: number; unknownService: number }
}

/** PURE — the stored identifiers, re-validated (a non-hash value in a tampered blob is dropped). Null when absent/malformed. */
function onlineAudienceIdentifiersFromProfile(profile: Record<string, unknown> | null | undefined): { identifiers: VersiumOnlineAudienceIdentifiers["services"]; identifierCount: number; matched: boolean; capturedAt: string | null; servicesAsked: VersiumOnlineAudienceService[] } | null {
  const raw = profile && typeof profile === "object" ? (profile as Record<string, unknown>)[ONLINE_AUDIENCE_KEY] : null
  if (!raw || typeof raw !== "object") return null
  const b = raw as Record<string, unknown>
  const services: VersiumOnlineAudienceIdentifiers["services"] = {}
  let identifierCount = 0
  const ids = b.identifiers && typeof b.identifiers === "object" ? (b.identifiers as Record<string, unknown>) : {}
  for (const [svc, kinds] of Object.entries(ids)) {
    if (!(VERSIUM_ONLINE_AUDIENCE_SERVICES as readonly string[]).includes(svc) || !kinds || typeof kinds !== "object") continue
    for (const [kind, values] of Object.entries(kinds as Record<string, unknown>)) {
      if (!Array.isArray(values)) continue
      const kept = values.filter((v): v is string => isOnlineAudienceIdentifier(v)).map((v) => v.trim().toLowerCase())
      if (kept.length === 0) continue
      ;((services[svc as VersiumOnlineAudienceService] ??= {}) as Record<string, string[]>)[kind] = [...new Set(kept)]
      identifierCount += new Set(kept).size
    }
  }
  const capturedAt = typeof b.captured_at === "string" ? b.captured_at : null
  const asked = Array.isArray(b.services_asked) ? (b.services_asked as unknown[]).filter((s): s is VersiumOnlineAudienceService => (VERSIUM_ONLINE_AUDIENCE_SERVICES as readonly string[]).includes(String(s))) : []
  if (!capturedAt) return null
  return { identifiers: services, identifierCount, matched: identifierCount > 0, capturedAt, servicesAsked: asked }
}

/** The ad platforms a governed audience may target (facebook_custom_audiences.target_platform, live CHECK). */
const TARGET_PLATFORMS = ["facebook", "instagram", "google", "linkedin", "tiktok"] as const

/** PURE — COUNTS ONLY (never a hash): what a person-facing surface or a research reader may see — how many identifiers were
 *  appended, from which sections, and how many SHA-256 match keys each ad platform's governed sync would gain. */
export function onlineAudienceSummary(profile: Record<string, unknown> | null | undefined): { matched: boolean; identifierCount: number; platforms: VersiumOnlineAudienceService[]; matchKeysByPlatform: Record<(typeof TARGET_PLATFORMS)[number], number>; capturedAt: string | null } | null {
  const s = onlineAudienceIdentifiersFromProfile(profile)
  if (!s) return null
  const matchKeysByPlatform = Object.fromEntries(TARGET_PLATFORMS.map((p) => [p, onlineAudienceMatchKeysFor(profile, p).length])) as Record<(typeof TARGET_PLATFORMS)[number], number>
  return { matched: s.matched, identifierCount: s.identifierCount, platforms: Object.keys(s.identifiers) as VersiumOnlineAudienceService[], matchKeysByPlatform, capturedAt: s.capturedAt }
}

/**
 * PURE — THE DOWNSTREAM READER'S DOOR: the appended identifiers for ONE ad platform as hashed match keys in the shape
 * lib/ads/connectors/pii.ts HashedMatchKey uses ({ email_sha256?, phone_sha256? }), ready to sit BESIDE the keys a governed
 * sync hashes from the contact's own e-mail/phone. Only SHA-256 e-mail / phone keys (the shape every connector accepts); the
 * caller is the targeting act — consent basis, fair-housing refusal and persona basis are ITS gates (lib/kernel/ads.ts).
 * Its production reader is the governed sync, lib/kernel/ads.ts syncAudience (custom / Customer-Match branch, wired at
 * integration from lane 144E's Outside-lane 1): it ADDS match keys for contacts already admitted by those gates — match rate,
 * never audience membership. It also feeds onlineAudienceSummary's per-platform key counts.
 */
export function onlineAudienceMatchKeysFor(profile: Record<string, unknown> | null | undefined, targetPlatform: string): Array<{ email_sha256?: string; phone_sha256?: string }> {
  const s = onlineAudienceIdentifiersFromProfile(profile)
  const service = PLATFORM_SERVICE[targetPlatform]
  if (!s || !service) return []
  const block = s.identifiers[service] ?? {}
  const sha = (k: OnlineAudienceIdKind) => (block[k] ?? []).filter((v) => /^[a-f0-9]{64}$/.test(v))
  const keys: Array<{ email_sha256?: string; phone_sha256?: string }> = []
  for (const e of sha("email_sha256")) keys.push({ email_sha256: e })
  for (const p of sha("phone_sha256")) keys.push({ phone_sha256: p })
  return keys
}

/** PURE — is the stored block FRESH for these services (asked within the window, covering every needed section)? */
function onlineAudienceIsFresh(profile: Record<string, unknown> | null | undefined, needed: readonly VersiumOnlineAudienceService[], now: Date = new Date()): boolean {
  const s = onlineAudienceIdentifiersFromProfile(profile)
  if (!s?.capturedAt) return false
  const age = now.getTime() - new Date(s.capturedAt).getTime()
  if (!Number.isFinite(age) || age < 0 || age > ONLINE_AUDIENCE_FRESH_DAYS * 86_400_000) return false
  // An append asked with NO service filter returned every section — it covers any need.
  return s.servicesAsked.length === 0 || needed.every((n) => s.servicesAsked.includes(n))
}

/**
 * THE REQUIRED-GAP READ — the Versium sections this tenant's GOVERNED customer-list audiences use. A refused read is an
 * ERROR (fail closed: the rung does not spend when it cannot tell whether the spend is needed), never "no audiences".
 */
async function onlineAudienceServicesInUse(
  supabase: SupabaseClient<any, any, any>,
  brokerageId: string,
): Promise<{ services: VersiumOnlineAudienceService[]; error?: string }> {
  const { data, error } = await supabase
    .from("facebook_custom_audiences")
    .select("target_platform, audience_type, consent_basis, lookalike_seed_audience_id, status")
    .eq("brokerage_id", brokerageId)
    .in("status", LIVE_AUDIENCE_STATUSES as unknown as string[])
  if (error) return { services: [], error: error.message }
  const services = new Set<VersiumOnlineAudienceService>()
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    // A look-alike seeds from an already-synced audience — it uploads no CRM contact, so it needs no match key.
    if (r.audience_type === "lookalike" || r.lookalike_seed_audience_id) continue
    // No consent basis → the governed sync refuses it (lib/kernel/ads.ts syncAudience) → no match key is needed for it.
    if (typeof r.consent_basis !== "string" || !r.consent_basis.trim()) continue
    const svc = PLATFORM_SERVICE[String(r.target_platform ?? "")]
    if (svc) services.add(svc)
  }
  return { services: [...services].sort() }
}

/** THE WRITER — lands one append on ONE contact of ONE tenant (a no-match is stored too, so the window applies). Never throws. */
async function persistOnlineAudienceIdentifiers(
  supabase: SupabaseClient<any, any, any>,
  target: { contactId: string; brokerageId: string },
  append: { identifiers: VersiumOnlineAudienceIdentifiers | null; queryId: string | null; dropped: StoredBlock["dropped"]; servicesAsked: readonly VersiumOnlineAudienceService[] },
  provenance: FieldProvenance | null,
  opts: { now?: Date } = {},
): Promise<{ ok: boolean; wrote: boolean; error?: string }> {
  if (!target.contactId || !target.brokerageId) return { ok: false, wrote: false, error: "contactId and brokerageId are both required" }
  const { data: row, error: readError } = await supabase
    .from("contacts")
    .select("enrichment_profile")
    .eq("id", target.contactId)
    .eq("brokerage_id", target.brokerageId)
    .maybeSingle()
  if (readError) return { ok: false, wrote: false, error: readError.message }
  if (!row) return { ok: false, wrote: false, error: "contact not found in this tenant" }
  const prior = (((row as { enrichment_profile?: Record<string, unknown> | null }).enrichment_profile) ?? {}) as Record<string, unknown>
  // Only hash-shaped values reach the block (the adapter already guarantees it; asserted again at the door), and only the
  // sections that were ASKED (data minimisation: a vendor answer wider than the request never widens what is stored).
  const services: StoredBlock["identifiers"] = {}
  let identifierCount = 0
  for (const [svc, kinds] of Object.entries(append.identifiers?.services ?? {})) {
    if (append.servicesAsked.length > 0 && !append.servicesAsked.includes(svc as VersiumOnlineAudienceService)) continue
    for (const [kind, values] of Object.entries(kinds ?? {})) {
      const kept = [...new Set((values ?? []).filter((v) => isOnlineAudienceIdentifier(v)).map((v) => v.toLowerCase()))]
      if (kept.length === 0) continue
      ;((services[svc as VersiumOnlineAudienceService] ??= {}) as Record<string, string[]>)[kind] = kept
      identifierCount += kept.length
    }
  }
  const block: StoredBlock = {
    provider: "versium", captured_at: (opts.now ?? new Date()).toISOString(), matched: identifierCount > 0,
    services_asked: [...append.servicesAsked], identifiers: services, identifier_count: identifierCount,
    query_id: append.queryId, dropped: append.dropped,
  }
  const next = withFieldProvenance(
    { ...prior, [ONLINE_AUDIENCE_KEY]: block },
    fieldProvenanceOf(prior),
    provenance && identifierCount > 0 ? { [ONLINE_AUDIENCE_KEY]: provenance } : null,
  )
  const { data: written, error: writeError } = await supabase
    .from("contacts")
    .update({ enrichment_profile: next })
    .eq("id", target.contactId)
    .eq("brokerage_id", target.brokerageId)
    .select("id")
  if (writeError) return { ok: false, wrote: false, error: writeError.message }
  if (!written || written.length === 0) return { ok: false, wrote: false, error: "online-audience write matched no row" }
  return { ok: true, wrote: true }
}

export interface OnlineAudienceRungResult {
  ok: boolean
  asked: boolean
  wrote: boolean
  identifierCount: number
  cost: number
  skipped?: "not_found" | "fresh" | "no_governed_audience" | "no_identifier" | string
  error?: string
}

/**
 * THE RUNG — one contact, required gap only: governed audiences in use → the block is absent / stale / missing a needed
 * section → the contact carries an identity Versium can match → the leg (route, budget, booking) → the writer. Never throws;
 * every refusal is named. Injectable seams so the guard runs it over the in-memory database with zero network.
 */
export async function appendOnlineAudienceForContact(
  supabase: SupabaseClient<any, any, any>,
  target: { contactId: string; brokerageId: string },
  deps: {
    leg?: typeof import("@/lib/ai-isa/property-lookup-rail").runVersiumOnlineAudienceLeg
    legDeps?: Parameters<typeof import("@/lib/ai-isa/property-lookup-rail").runVersiumOnlineAudienceLeg>[1]
    now?: Date
    systemSource?: string
  } = {},
): Promise<OnlineAudienceRungResult> {
  const base: OnlineAudienceRungResult = { ok: true, asked: false, wrote: false, identifierCount: 0, cost: 0 }
  try {
    const now = deps.now ?? new Date()
    const { data: c, error: readError } = await supabase
      .from("contacts")
      .select("id, brokerage_id, first_name, last_name, email, phone, address, city, state, zip_code, mailing_address, mailing_city, mailing_state, mailing_zip, enrichment_profile")
      .eq("id", target.contactId)
      .eq("brokerage_id", target.brokerageId)
      .maybeSingle()
    if (readError) return { ...base, ok: false, error: readError.message }
    if (!c) return { ...base, skipped: "not_found" }
    const inUse = await onlineAudienceServicesInUse(supabase, target.brokerageId)
    if (inUse.error) return { ...base, ok: false, error: `governed-audience read refused: ${inUse.error}` }
    if (inUse.services.length === 0) return { ...base, skipped: "no_governed_audience" }
    const contact = c as Record<string, any>
    if (onlineAudienceIsFresh(contact.enrichment_profile, inUse.services, now)) return { ...base, skipped: "fresh" }
    if (!hasUsableIdentifier(contact)) return { ...base, skipped: "no_identifier" }
    const leg = deps.leg ?? (await import("@/lib/ai-isa/property-lookup-rail")).runVersiumOnlineAudienceLeg
    const r = await leg({
      brokerageId: target.brokerageId,
      // One postal identity, never a street from one address and a ZIP from another: the record's own address when it has
      // one, else its mailing address.
      identity: {
        firstName: contact.first_name ?? null, lastName: contact.last_name ?? null, email: contact.email ?? null, phone: contact.phone ?? null,
        ...(contact.address
          ? { address: contact.address, city: contact.city ?? null, state: contact.state ?? null, zip: contact.zip_code ?? null }
          : { address: contact.mailing_address ?? null, city: contact.mailing_city ?? contact.city ?? null, state: contact.mailing_state ?? contact.state ?? null, zip: contact.mailing_zip ?? contact.zip_code ?? null }),
      },
      services: inUse.services,
      systemSource: deps.systemSource ?? "contact_enrichment",
      metadata: { contactId: target.contactId, trigger: "governed_audience_gap" },
      attribution: { contactId: target.contactId },
    }, deps.legDeps)
    if (r.skipped && r.cost === 0) {
      // Refused before or by the vendor (budget, unconfigured, provider failing, a 4xx/5xx) — a refused call bills nothing and
      // answers nothing, so nothing is stored and the next pass re-asks. A FREE no-match has skipped=null and IS stored below.
      return { ...base, skipped: r.skipped }
    }
    const w = await persistOnlineAudienceIdentifiers(supabase, target, { identifiers: r.identifiers, queryId: r.queryId, dropped: r.dropped, servicesAsked: inUse.services }, r.provenance, { now })
    return { ok: w.ok, asked: true, wrote: w.wrote, identifierCount: r.identifiers?.identifierCount ?? 0, cost: r.cost, ...(r.skipped ? { skipped: r.skipped } : {}), ...(w.error ? { error: w.error } : {}) }
  } catch (e) {
    return { ...base, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
