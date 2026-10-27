// lib/marketing/listing-public-address.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE COMING SOON CREATIVE DOOR'S ADDRESS RULE (wave 145, lane 145B — owner ruling 1, 2026-10-27).
//
// Owner: "You can advertise a coming soon only if you don't disclose the street address, unless otherwise."
//
// ONE place every PUBLIC Coming Soon creative asks what address it may print, and ONE scrubber for the text it
// produces. The decision itself is lib/compliance/coming-soon-policy.ts comingSoonStreetAddressDecision (seller's
// signed authorization from the executed listing agreement AND the brokerage's compliance-attested MLS rule); this
// module loads its two inputs (tenant-pinned, fail closed) and applies it to creative:
//
//   resolveComingSoonCreativeAddress   → { decision, addressLine, publicLocation } — the line creative may print: the
//                                        full street address ONLY when the decision discloses it, else "City, ST".
//   guardComingSoonCreativeText        → scrubs (mode "redact": AI copy) or refuses (mode "refuse": a person's reviewed
//                                        copy, so they see why) any occurrence of the listing's street address.
//
// The FULL address stays where it is (listings.address) — agents, the transaction record and compliance read it
// unchanged. Only PUBLIC Coming Soon creative is filtered here; fair-housing review of that copy remains the existing
// pre-publication gate's job (lib/kernel/marketing/real-estate-compliance-gate.ts), and the final humanisation phase is
// lane 145G's lib/marketing/humanize-final.ts (contract C4) — this module adds neither.
//
// BLIND SPOTS (published): a street number written out in words ("One Twenty-Three Main"), an address inside an IMAGE
// or a video FRAME (photos, composition props, QR destinations) and a street name WITHOUT its house number are not
// detected here — a street name alone is not the street address. Detection anchors on the listing's own house number
// followed by its own street-name token, so another property's address in the copy is left alone.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  comingSoonStreetAddressDecision,
  loadComingSoonPolicy,
  type ComingSoonAddressDecision,
  type SellerAddressAuthorization,
} from "@/lib/compliance/coming-soon-policy"
import { governingListingAgreementTerms } from "@/lib/listings/listing-agreement-terms"

type Svc = SupabaseClient<any, any, any>

export interface ListingAddressParts {
  address: string | null
  city: string | null
  state: string | null
  zip?: string | null
}

/** PURE — what public Coming Soon creative names instead of the street address: "City, ST" (never the ZIP+street).
 * Doors receive it as resolveComingSoonCreativeAddress(...).publicLocation. */
function publicComingSoonLocation(l: ListingAddressParts): string {
  const city = (l.city ?? "").trim()
  const st = (l.state ?? "").trim().toUpperCase()
  if (city && st) return `${city}, ${st}`
  return city || st || "this area"
}

const DIRECTIONALS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"])
const SUFFIXES = [
  "street", "st", "avenue", "ave", "av", "road", "rd", "drive", "dr", "lane", "ln", "court", "ct", "boulevard", "blvd", "way", "wy",
  "place", "pl", "terrace", "ter", "terr", "circle", "cir", "parkway", "pkwy", "highway", "hwy", "trail", "trl", "loop", "lp",
  "run", "path", "square", "sq", "cove", "cv", "point", "pt", "pike", "alley", "aly", "row", "crossing", "xing", "plaza", "plz", "ridge", "rdg",
]
const UNIT = /\s*(?:,\s*)?(?:#|apt\.?|apartment|unit|suite|ste\.?|bldg\.?|building|lot)\s*[\w-]+/i

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** PURE — the street line of an address ("123 N Main St, Tampa, FL" → { number "123", nameTokens ["main"] }), or null. */
function streetLineParts(address: string | null | undefined): { line: string; number: string; nameTokens: string[] } | null {
  const line = String(address ?? "").split(",")[0].replace(UNIT, "").replace(/\s+/g, " ").trim()
  const m = /^(\d+[a-z]?(?:-\d+)?)\s+(.+)$/i.exec(line)
  if (!m) return null
  const words = m[2].toLowerCase().replace(/[.]/g, "").split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length - 1 && DIRECTIONALS.has(words[i])) i++
  let end = words.length
  if (end - i > 1 && SUFFIXES.includes(words[end - 1])) end--
  while (end - i > 1 && DIRECTIONALS.has(words[end - 1])) end--
  const nameTokens = words.slice(i, end)
  return nameTokens.length ? { line, number: m[1], nameTokens } : null
}

/** PURE — the matcher for THIS listing's street address: its house number, an optional directional, ALL of its
 *  street-name tokens ("45 Old Mill" — so "45 Old Town Rd" is another street), an optional suffix / trailing
 *  directional and an optional unit. Case-insensitive; null when the listing has no street line. */
function streetMatcher(address: string | null | undefined): RegExp | null {
  const p = streetLineParts(address)
  if (!p) return null
  const sep = "[\\s.,]+"
  const dir = `(?:(?:${[...DIRECTIONALS].map(esc).join("|")})\\.?${sep})?`
  const name = p.nameTokens.map(esc).join(sep)
  const suffix = `(?:${sep}(?:${SUFFIXES.map(esc).join("|")})\\b\\.?)?`
  const trailingDir = `(?:${sep}(?:${[...DIRECTIONALS].map(esc).join("|")})\\b\\.?)?`
  const unit = `(?:${UNIT.source})?`
  return new RegExp(`(?<![\\w$,.-])${esc(p.number)}${sep}${dir}${name}\\b${suffix}${trailingDir}${unit}`, "gi")
}

/** PURE — every occurrence of the listing's street address in `text` (the matched spans), or []. Doors reach it through
 *  guardComingSoonCreativeText (refuse mode names the spans). */
function findStreetAddressDisclosures(text: string | null | undefined, l: ListingAddressParts): string[] {
  const re = streetMatcher(l.address)
  if (!re || !text) return []
  return [...String(text).matchAll(re)].map((m) => m[0])
}

/** PURE — `text` with every occurrence of the listing's street address replaced (default: the public location). Doors
 *  reach it through guardComingSoonCreativeText (redact mode). */
function redactStreetAddress(text: string, l: ListingAddressParts, replacement?: string): { text: string; redactions: number } {
  const re = streetMatcher(l.address)
  if (!re || !text) return { text, redactions: 0 }
  let n = 0
  const out = text.replace(re, () => { n++; return replacement ?? publicComingSoonLocation(l) })
  return { text: out, redactions: n }
}

export interface ComingSoonCreativeAddress {
  decision: ComingSoonAddressDecision
  /** The ONLY address line public Coming Soon creative may print: the full address when disclosed, else the public location. */
  addressLine: string
  publicLocation: string
}

/**
 * Resolve what this listing's PUBLIC Coming Soon creative may print. The caller has ALREADY gated the listing to the
 * session's tenant (the row it passes came through that gate); the two reads here are tenant-pinned by the row's own
 * brokerage. `policyClient` reads brokerage_settings (its SELECT policy admits brokerage admins only, so agent doors
 * pass the service client after their gate — the readiness checker's documented pattern); `termsClient` reads the
 * executed listing agreement. FAIL CLOSED: an unreadable policy or agreement withholds the street address.
 */
export async function resolveComingSoonCreativeAddress(input: {
  policyClient: Svc
  termsClient: Svc
  listing: ListingAddressParts & { id: string; brokerage_id: string }
  mlsSlug?: string | null
}): Promise<ComingSoonCreativeAddress> {
  const { listing } = input
  const publicLocation = publicComingSoonLocation(listing)
  let policy: Awaited<ReturnType<typeof loadComingSoonPolicy>>
  try {
    policy = await loadComingSoonPolicy(input.policyClient, listing.brokerage_id)
  } catch (err) {
    policy = { ok: false, error: `the coming-soon policy could not be read: ${(err as Error)?.message ?? err}` }
  }
  let seller: SellerAddressAuthorization = "unreadable"
  try {
    const terms = await governingListingAgreementTerms(input.termsClient, { brokerageId: listing.brokerage_id, listingId: listing.id })
    seller = !terms.ok ? "unreadable"
      : terms.comingSoonStreetAddressAuthorized === true ? "authorized"
      : terms.comingSoonStreetAddressAuthorized === false ? "declined" : "not_recorded"
  } catch {
    seller = "unreadable"
  }
  const decision = comingSoonStreetAddressDecision(policy.ok ? policy.policy : null, { mlsSlug: input.mlsSlug ?? null, stateCode: listing.state }, seller)
  if (!policy.ok) decision.withheldBecause.unshift(policy.error)
  const fullLine = [listing.address, listing.city, listing.state].map((s) => (s ?? "").trim()).filter(Boolean).join(", ")
  return { decision, addressLine: decision.disclose && fullLine ? fullLine : publicLocation, publicLocation }
}

export interface CreativeGuardResult {
  ok: boolean
  /** The text as it may go out (redacted in "redact" mode; unchanged when refused). */
  text: string
  redactions: number
  /** Why the text may not go out as written (refuse mode), or what was removed (redact mode). */
  findings: string[]
}

/**
 * PURE — apply the decision to a piece of public Coming Soon copy. When the street address may be disclosed the text
 * passes untouched. Otherwise: "redact" replaces each occurrence with the public location (AI-drafted copy), "refuse"
 * leaves the text alone and refuses it (a person's reviewed copy — they are told what to change, nothing is rewritten
 * behind their back).
 */
export function guardComingSoonCreativeText(text: string | null | undefined, l: ListingAddressParts, resolved: ComingSoonCreativeAddress, mode: "redact" | "refuse"): CreativeGuardResult {
  const body = String(text ?? "")
  if (resolved.decision.disclose || !body) return { ok: true, text: body, redactions: 0, findings: [] }
  const hits = findStreetAddressDisclosures(body, l)
  if (!hits.length) return { ok: true, text: body, redactions: 0, findings: [] }
  const why = resolved.decision.withheldBecause[0] ?? "the street address is withheld from Coming Soon advertising"
  if (mode === "refuse") {
    return { ok: false, text: body, redactions: 0, findings: [`Coming Soon copy names the street address (${hits.map((h) => `"${h.trim()}"`).join(", ")}) — ${why}. Use "${resolved.publicLocation}" instead.`] }
  }
  const r = redactStreetAddress(body, l, resolved.publicLocation)
  return { ok: true, text: r.text, redactions: r.redactions, findings: [`street address removed ${r.redactions}× — ${why}`] }
}
