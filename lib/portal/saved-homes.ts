/**
 * lib/portal/saved-homes.ts — WHERE A SAVED HOME CAME FROM, WHICH PHOTO IT MAY SHOW, AND SAVING ONE FROM A LINK
 * (wave 150, lane 150W — owner rulings 2026-11-06 on RentCast listing display, saved-home origins and photo sources).
 *
 * THE SURVIVOR IS `saved_properties` (live 2026-11-06: `property_interests` holds search CRITERIA, not homes — never a
 * second table). A saved home carries its ORIGIN, read from the survivor column `saved_properties.source` (one
 * vocabulary, CLAUDE.md §6 — no second "origin" column that could disagree with it):
 *
 *   idx_mls          ← source 'idx' | 'mls'          the tenant's own IDX/MLS feed
 *   rentcast_listing ← source 'rentcast'             a RentCast /listings/sale row: listing id in external_property_id,
 *                                                     mls_number + mls_name (m991) shown as the source — facts only
 *   buyer_url        ← source 'buyer_url' (m991)     the buyer pasted the property's link: kept as `source_url`,
 *                                                     resolved to an address + facts through the property rail
 *   tenant_listing   ← listing_id set / 'brokerage_listing'   one of the tenant's own listings
 *   manual           ← anything else (staff-entered)
 *
 * PHOTOS (owner R9): exactly two lawful sources — the tenant's own IDX/MLS feed and the photos the tenant user uploads
 * and owns (the `listings.photos` / listing-media survivor, lane 150XY's upload path). RentCast's /listings/sale schema
 * carries NO photo field, a pasted link is someone else's page, and a manual row has no licence — none of them is EVER
 * a photo source. `licensedPhotoFor` is the one gate every portal surface reads a saved-home photo through.
 *
 * SAVING FROM A LINK never fetches the page (that would be scraping someone else's site): the address is read from the
 * link's own words (the portals put it in the path), then the property FACTS come through the capability rail
 * (lookupPropertyForConversation — cache → tenant IDX → RentCast → public records; customer audience, so no valuation
 * rides back). A link we cannot read is still saved, honestly, with "address unknown" — the agent takes a look.
 */
import { createHash } from "node:crypto"
import type { PropertyLookupAddress, PropertyLookupResult, PropertyLookupRequest } from "@/lib/ai-isa/property-lookup-rail"
// The origin vocabulary, the engine-side photo rule and the URL predicate live with the search engine (wave 150 integrator move —
// the engine is on every page graph; this read model is not). Re-exported here so the portal keeps ONE import root for them.
import { SAVED_HOME_ORIGINS, SOURCE_FOR_ORIGIN, savedHomeOrigin, licensedResultPhotoUrl, isHttpUrl as isHttp, type SavedHomeOrigin } from "@/lib/buyer-search/search-engine"
export { SAVED_HOME_ORIGINS, SOURCE_FOR_ORIGIN, savedHomeOrigin, licensedResultPhotoUrl }
export type { SavedHomeOrigin }

/** PURE. The line a buyer reads under a saved home: where it came from, in plain words. */
export function savedHomeSourceLine(row: { source?: string | null; listing_id?: string | null; mls_name?: string | null; source_url?: string | null }, brokerageName?: string | null): string {
  const origin = savedHomeOrigin(row)
  const mls = (row.mls_name ?? "").trim()
  switch (origin) {
    case "idx_mls": return mls ? `Listed on ${mls}, through your agent's MLS feed` : "From your agent's MLS feed"
    case "rentcast_listing": return mls ? `Listed on ${mls} · facts via RentCast — your agent confirms it's available` : "Listing facts via RentCast — your agent confirms it's available"
    case "buyer_url": return `You saved this from ${hostOf(row.source_url) ?? "a link"} — your agent will take a look`
    case "tenant_listing": return brokerageName ? `One of ${brokerageName}'s own listings` : "One of your agent's own listings"
    default: return "Added by your agent"
  }
}

function hostOf(url: string | null | undefined): string | null {
  try { return url ? new URL(url).hostname.replace(/^www\./, "") : null } catch { return null }
}

// ─── PHOTOS — THE ONE GATE ────────────────────────────────────────────────────────────────────────

export type LicensedPhotoSource = "tenant_listing_media"

export interface LicensedPhoto { url: string; source: LicensedPhotoSource; attribution: string }

/**
 * The shape this lane CONSUMES from `listings.photos` (jsonb array) — EXACTLY what lane 150XY's owner-upload path writes
 * (lane150XY-notes `## Outside-lane`): `{ url, caption, order, source: "owner_upload", media_id, uploaded_by,
 * ownership_attested_at, attestation_version }`. `"idx_mls"` is reserved for an IDX ingest that ever stores media.
 * A LEGACY entry (a plain string, or an object with no `source`) is UNKNOWN provenance and is NEVER shown as owned —
 * nobody attested it (150XY: no back-fill).
 */
interface ListingPhotoEntry {
  url?: string | null
  caption?: string | null
  order?: number | null
  source?: string | null
  media_id?: string | null
  uploaded_by?: string | null
  ownership_attested_at?: string | null
  attestation_version?: string | null
}


/** PURE. Every `media_id` an owner-upload entry names — what an approval-gated surface checks against
 *  `listing_media.is_approved` (150XY's display rule). */
export function ownerUploadMediaIds(photos: unknown): string[] {
  return (Array.isArray(photos) ? photos : [])
    .filter((e): e is ListingPhotoEntry => !!e && typeof e === "object" && (e as ListingPhotoEntry).source === "owner_upload")
    .map((e) => e.media_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
}

/**
 * PURE. The first lawful photo (gallery order) of a tenant listing's own media, or null. On an approval-gated surface
 * pass `approvedMediaIds` (the `listing_media` ids with is_approved = true): an owner upload not in it is not shown —
 * so an unreadable approval list shows NO owner photo (fail closed), never an unapproved one.
 */
function ownListingPhoto(photos: unknown, approvedMediaIds?: ReadonlySet<string>): string | null {
  const list = (Array.isArray(photos) ? photos : [])
    .filter((p): p is ListingPhotoEntry => !!p && typeof p === "object" && !Array.isArray(p))
    .slice()
    .sort((a, b) => (typeof a.order === "number" ? a.order : 1e9) - (typeof b.order === "number" ? b.order : 1e9))
  for (const e of list) {
    if (!isHttp(e.url)) continue
    if (e.source === "owner_upload" && e.ownership_attested_at && e.media_id && e.uploaded_by) {
      if (approvedMediaIds && !approvedMediaIds.has(e.media_id)) continue
      return e.url
    }
    if (e.source === "idx_mls") return e.url
  }
  return null
}

/**
 * PURE. THE photo a saved home may show — null for every origin that is not a lawful photo source.
 * · tenant_listing → the listing's attested owner uploads (or a stored IDX entry) from `listings.photos`; the
 *   saved row's own `primary_photo_url` copy is unknown provenance and is never read.
 * · idx_mls → null HERE: IDX photos are rendered from the feed at display time and never copied onto a saved row
 *   (lib/buyer-search/external-match.ts "NEVER store external photos"); the live search result shows them.
 * · rentcast_listing / buyer_url / manual → null, whatever URL the row happens to hold.
 */
export function licensedPhotoFor(
  // A whole saved row may be passed; only its origin columns are read (never a URL it happens to hold).
  row: { source?: string | null; listing_id?: string | null; [column: string]: unknown },
  listingPhotos?: unknown,
  approvedMediaIds?: ReadonlySet<string>,
): LicensedPhoto | null {
  if (savedHomeOrigin(row) !== "tenant_listing") return null
  const url = ownListingPhoto(listingPhotos, approvedMediaIds)
  return url ? { url, source: "tenant_listing_media", attribution: "Photo from the listing's own media" } : null
}

// ─── A HOME FROM A PASTED LINK ────────────────────────────────────────────────────────────────────

const STREET_SUFFIX = new Set(["st", "street", "ave", "avenue", "rd", "road", "dr", "drive", "ln", "lane", "ct", "court", "blvd", "boulevard", "way", "pl", "place", "cir", "circle", "trl", "trail", "pkwy", "parkway", "hwy", "highway", "ter", "terrace", "loop", "run", "pass", "path", "sq", "square", "xing", "crossing", "cv", "cove", "pt", "point", "row", "aly", "alley", "bnd", "bend", "holw", "hollow", "rdg", "ridge", "vw", "view", "grv", "grove", "mnr", "manor", "pike", "spur", "walk"])
const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "))
const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()

export interface ParsedPropertyLink {
  /** The link, normalised (https, no fragment, no tracking query) — what `source_url` stores. */
  url: string
  host: string
  /** The address the link's own words carry, or null when they carry none we can read (never guessed). */
  address: PropertyLookupAddress | null
  /** Idempotency key for the save: one row per (buyer, link). */
  key: string
}

/**
 * PURE. Read a property link the buyer pasted. Refuses anything that is not an http(s) URL. Reads the address from
 * the path words only ("…/1234-Main-St-Austin-TX-78701/…", "…/1234-Main-St_Austin_TX_78701_M…", "…/TX/Austin/1234-
 * Main-St-78701/home/…"): a street number, a street ending in a known suffix, then the city, a US state and a ZIP.
 * Anything else → address null (the save still happens; the agent looks).
 */
export function parsePropertyLink(input: string): ParsedPropertyLink | { error: string } {
  const rawIn = String(input ?? "").trim()
  if (!rawIn || rawIn.length > 2048) return { error: "Paste the full link to the home (it starts with https://)." }
  let u: URL
  try { u = new URL(rawIn) } catch { return { error: "That doesn't look like a link — paste the whole address bar from the listing page." } }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "Only web links (https://…) can be saved." }
  if (u.username || u.password) return { error: "That link carries a sign-in — paste the plain listing link instead." }
  u.hash = ""
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref|src)/i.test(k)) u.searchParams.delete(k)
  u.protocol = "https:"
  const url = u.toString()
  const host = u.hostname.replace(/^www\./, "").toLowerCase()
  const key = `url:${createHash("sha256").update(url.toLowerCase()).digest("hex").slice(0, 32)}`
  return { url, host, address: addressFromPath(u.pathname), key }
}

function addressFromPath(pathname: string): PropertyLookupAddress | null {
  const segments = decodeURIComponent(pathname).split("/").filter(Boolean)
  // Redfin-style: /TX/Austin/1234-Main-St-78701/home/123
  for (let i = 0; i + 2 < segments.length; i++) {
    if (STATES.has(segments[i].toUpperCase()) && segments[i].length === 2) {
      const tokens = segments[i + 2].split(/[-_]+/).filter(Boolean)
      const zip = /^\d{5}$/.test(tokens[tokens.length - 1] ?? "") ? tokens.pop()! : null
      const street = streetFrom(tokens, "none")
      if (street && street.rest.length === 0) return { street: street.line, city: segments[i + 1].split(/[-_]+/).map(title).join(" "), state: segments[i].toUpperCase(), zip }
    }
  }
  // Zillow / Realtor.com / Trulia / Homes.com style: one segment holding "<street> <city> <ST> <zip>"
  for (const seg of segments) {
    const tokens = seg.split(/[-_]+/).filter(Boolean)
    for (let z = tokens.length - 1; z >= 2; z--) {
      if (!/^\d{5}$/.test(tokens[z]) || !STATES.has(tokens[z - 1].toUpperCase()) || tokens[z - 1].length !== 2) continue
      const street = streetFrom(tokens.slice(0, z - 1), "city")
      if (street && street.rest.length > 0) return { street: street.line, city: street.rest.map(title).join(" "), state: tokens[z - 1].toUpperCase(), zip: tokens[z] }
    }
  }
  return null
}

/**
 * The street ("1234 Main St") from tokens that start with a number and run to a street suffix; the rest is the city.
 * `after: "city"` — a city must follow, so the LAST suffix that still leaves one wins ("77 Ranch Rd" + "Copperas Cove",
 * not "77 Ranch Rd Copperas Cove": Cove is a suffix too); `after: "none"` — the street fills the segment (last suffix).
 */
function streetFrom(tokens: string[], after: "city" | "none"): { line: string; rest: string[] } | null {
  if (!tokens.length || !/^\d+[a-z]?$/i.test(tokens[0])) return null
  let end = -1
  for (let i = 1; i < tokens.length; i++) {
    if (!STREET_SUFFIX.has(tokens[i].toLowerCase())) continue
    if (after === "city" && i >= tokens.length - 1) continue
    end = i
  }
  if (end < 1) return null
  // A trailing unit ("Apt 4", "Unit 2B") stays with the street.
  let stop = end
  if (/^(apt|unit|ste|suite)$/i.test(tokens[end + 1] ?? "") && tokens[end + 2]) stop = end + 2
  const line = tokens.slice(0, stop + 1).map((t, i) => (i === 0 ? t : /^(apt|unit|ste|suite)$/i.test(t) ? title(t) : /^\d/.test(t) ? t.toUpperCase() : title(t))).join(" ")
  return { line, rest: tokens.slice(stop + 1) }
}

// ─── THE WRITERS (service client injected; tenant from the gate, never a body) ────────────────────

type Db = { from: (t: string) => any }

export interface SaveCtx { brokerageId: string; contactId: string; ownerUserId: string }

export interface SaveOutcome { ok: true; savedId: string; created: boolean; resolved: boolean; notes: string[] }
export type SaveResult = SaveOutcome | { ok: false; error: string }

/** The facts lookup the link save uses — the capability rail by default, injectable for proofs. */
export type FactsLookup = (req: PropertyLookupRequest) => Promise<PropertyLookupResult>

async function railLookup(req: PropertyLookupRequest): Promise<PropertyLookupResult> {
  const { lookupPropertyForConversation } = await import("@/lib/ai-isa/property-lookup-rail")
  return lookupPropertyForConversation(req)
}

/** Public listing facts only (customer audience — no valuation, no tax basis). */
function factsColumns(f: NonNullable<PropertyLookupResult["facts"]>): Record<string, unknown> {
  const status = (f.listingStatus ?? "").toLowerCase()
  return {
    property_address: f.address ?? null, city: f.city ?? null, state: f.state ?? null,
    bedrooms: f.beds ?? null, bathrooms: f.baths ?? null, sqft: f.sqft ?? null, property_type: f.propertyType ?? null,
    // The asking price is shown only while the home is reported ACTIVE; a stale price on a sold home misleads.
    list_price: status === "active" && typeof f.listPrice === "number" ? f.listPrice : null,
    ...(f.mlsNumber ? { mls_number: f.mlsNumber } : {}),
  }
}

async function findExisting(db: Db, ctx: SaveCtx, source: string, externalId: string): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await db.from("saved_properties").select("id")
    .eq("brokerage_id", ctx.brokerageId).eq("contact_id", ctx.contactId)
    .eq("source", source).eq("external_property_id", externalId).limit(1)
  if (error) return { id: null, error: error.message }
  const row = (Array.isArray(data) ? data[0] : data) as { id?: string } | null
  return { id: row?.id ?? null, error: null }
}

/**
 * Save a home from a link the buyer pasted (origin buyer_url). Idempotent per (buyer, link). The address comes from the
 * link's words; the facts from the rail (customer audience). Nothing is fetched from the linked site.
 */
export async function saveHomeFromLink(db: Db, ctx: SaveCtx, link: string, deps: { lookup?: FactsLookup; now?: Date } = {}): Promise<SaveResult> {
  const parsed = parsePropertyLink(link)
  if ("error" in parsed) return { ok: false, error: parsed.error }
  const notes: string[] = []
  const found = await findExisting(db, ctx, SOURCE_FOR_ORIGIN.buyer_url, parsed.key)
  if (found.error) return { ok: false, error: "Your saved homes couldn't be read just now — please try again." }

  let facts: Record<string, unknown> = {}
  let resolved = false
  if (parsed.address) {
    try {
      const r = await (deps.lookup ?? railLookup)({ brokerageId: ctx.brokerageId, purpose: "conversation", audience: "customer", address: parsed.address, contactId: ctx.contactId })
      if (r.found && r.facts) { facts = factsColumns(r.facts); resolved = true }
      else notes.push("I read the address from the link but couldn't find the home's facts yet — your agent will fill them in.")
    } catch {
      notes.push("I read the address from the link but the property lookup didn't answer just now — your agent will fill in the facts.")
    }
    if (!resolved) facts = { property_address: parsed.address.street, city: parsed.address.city ?? null, state: parsed.address.state ?? null }
  } else {
    notes.push(`I couldn't read an address from that ${parsed.host} link, so it's saved as a link — your agent will take a look.`)
  }

  const at = (deps.now ?? new Date()).toISOString()
  if (found.id) {
    const { data, error } = await db.from("saved_properties").update({ ...facts, source_url: parsed.url, dismissed: false, saved_at: at })
      .eq("id", found.id).eq("brokerage_id", ctx.brokerageId).select("id")
    if (error) return { ok: false, error: "That home couldn't be updated just now — please try again." }
    if (!Array.isArray(data) || data.length !== 1) return { ok: false, error: "That saved home couldn't be found any more — please save it again." }
    return { ok: true, savedId: found.id, created: false, resolved, notes }
  }
  const row = {
    brokerage_id: ctx.brokerageId, contact_id: ctx.contactId, user_id: ctx.ownerUserId,
    source: SOURCE_FOR_ORIGIN.buyer_url, external_property_id: parsed.key, source_url: parsed.url,
    primary_photo_url: null, // a pasted link is never a photo source (R9)
    interest_level: "saved", dismissed: false, saved_at: at, ...facts,
  }
  const { data, error } = await db.from("saved_properties").insert(row).select("id").maybeSingle()
  if (error || !data) return { ok: false, error: "That home couldn't be saved just now — please try again." }
  return { ok: true, savedId: (data as { id: string }).id, created: true, resolved, notes }
}

export interface ListingRef {
  /** The RentCast listing id (the engine's `ext_rentcast_<id>` minus the prefix). */
  externalId: string
  mlsNumber?: string | null
  mlsName?: string | null
  address?: string | null
}

/** PURE. A listing reference as the buyer's browser may post it — identifiers only, shape-checked; facts never ride. */
export function cleanListingRef(v: unknown): ListingRef | null {
  const r = (v && typeof v === "object" ? v : null) as Record<string, unknown> | null
  if (!r) return null
  const s = (x: unknown, max: number) => (typeof x === "string" && x.trim() && x.trim().length <= max ? x.trim() : null)
  const externalId = s(r.externalId, 200)
  if (!externalId || !/^[\w.\-:,]+$/.test(externalId)) return null
  const mlsNumber = s(r.mlsNumber, 40)
  return { externalId, mlsNumber: mlsNumber && /^[\w\-]+$/.test(mlsNumber) ? mlsNumber : null, mlsName: s(r.mlsName, 120), address: s(r.address, 240) }
}

/**
 * Stamp a RentCast-listing save (written by the survivor reaction writer, `recordBuyerPropertyAction`) with what makes
 * it a `rentcast_listing` origin: the MLS number and the MLS's name (shown as the source), and the address. Facts are
 * never taken from the browser. Count-checked: the stamp must hit exactly the buyer's one row in this tenant.
 */
export async function stampRentcastListingSave(db: Db, ctx: Pick<SaveCtx, "brokerageId" | "contactId">, ref: ListingRef): Promise<{ ok: boolean; error?: string }> {
  const patch: Record<string, unknown> = {}
  if (ref.mlsNumber) patch.mls_number = ref.mlsNumber
  if (ref.mlsName) patch.mls_name = ref.mlsName
  if (ref.address) patch.property_address = ref.address
  patch.primary_photo_url = null // RentCast is never a photo source (R9)
  const { data, error } = await db.from("saved_properties").update(patch)
    .eq("brokerage_id", ctx.brokerageId).eq("contact_id", ctx.contactId)
    .eq("source", SOURCE_FOR_ORIGIN.rentcast_listing).eq("external_property_id", ref.externalId).select("id")
  if (error) return { ok: false, error: error.message }
  if (!Array.isArray(data) || data.length === 0) return { ok: false, error: "no saved RentCast row matched" }
  return { ok: true }
}
