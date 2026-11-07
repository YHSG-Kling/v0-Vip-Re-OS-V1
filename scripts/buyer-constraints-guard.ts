/**
 * scripts/buyer-constraints-guard.ts — THE BUYER PORTAL'S CONSTRAINTS, ORIGINS AND PHOTO SOURCES (wave 150, lane 150W).
 * `test:buyer-constraints`
 *
 * Owner rulings 2026-11-06 + directive canary 7:
 *   "2-acre minimum + 25-minute commute → only licensed active options with the stated constraints, or a helpful shortage
 *    explanation"; "the portal DISPLAYS RentCast sale listings (facts, with the MLS name shown as the source) and a buyer
 *    may SAVE one — a saved home carries its origin (idx_mls | rentcast_listing | buyer_url)"; "a buyer may also save a
 *    home by pasting the property's URL, stored as source_url"; "photos only from the tenant's IDX/MLS feed or the
 *    tenant user's own uploads — RentCast is never a photo source".
 *
 *   A. CONSTRAINTS (C27) — only a number the buyer said is a hard constraint, in the lot_size_unit vocabulary
 *   B. CANARY 7 — only licensed ACTIVE options that PROVE every stated constraint; misses/unknowns left out and counted
 *   C. SHORTAGE — an empty page explains itself from measured figures; never relaxes the buyer's constraint
 *   D. ORIGIN — saved_properties.source → idx_mls | rentcast_listing | buyer_url | tenant_listing | manual; m991 agrees
 *   E. PHOTOS — the one gate: RentCast / pasted link / manual / a stored IDX copy never show a photo; the tenant
 *      listing's attested + approved owner uploads (150XY's `listings.photos` shape) do; IDX shows live in search only
 *   F. RENTCAST DISPLAY — the MLS name is the source, RentCast the carrier of facts, never "verified active"
 *   G. SAVE FROM A LINK — address from the link's words, facts through the rail (customer audience), idempotent, tenant-stamped
 *   H. SAVE A RENTCAST LISTING — identifiers stamped on the buyer's own row, count-checked; facts never from the browser
 *   I. FAMILY (canary 7, second half) — every origin shares; facts only; the collaborator is never a contact or a lead
 *   J. WIRING (stripped source) — the doors are gated + ledgered; the engine holds constraints; surfaces read the gate
 *
 * POSITIVE CONTROLS: every absence claim is paired with a check that the finder sees the thing when it IS there.
 *
 * BLIND SPOTS (published): memSupabase runs no RLS and no CHECK, so m991's constraints are proven as SQL text only; the
 * capability rail is injected (no RentCast call is made); travel minutes are planted evidence (no Matrix call); the
 * engine's hold is proven on the pure function plus a stripped-source wiring read, not by driving searchPropertiesCore
 * end to end; link parsing knows the path shapes of the large portals — an unknown site saves as a link with "address
 * unknown"; pages are not rendered in a browser.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { extractLifestyleAsks } from "../lib/buyer-search/conversation-criteria"
import { explainCriteriaFit } from "../lib/buyer-search/explanation-generator"
import { LOT_UNITS, describeListingSource, readLotMinimum } from "../lib/buyer-search/explanation-evidence"
import type { HomeLocationEvidence } from "../lib/buyer-search/explanation-evidence"
import { emptyCriteria } from "../lib/buyer-search/conversational-search"
import { statedHardConstraints, answerStatedConstraints, type ConstraintCandidate } from "../lib/buyer-search/explanation-evidence"
import * as homes from "../lib/portal/saved-homes"
import * as share from "../lib/portal/collaborative-share"

const root = process.cwd()
const code = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const BRK = "11111111-1111-4111-8111-111111111111"
const OTHER_BRK = "22222222-2222-4222-8222-222222222222"
const BUYER = "33333333-3333-4333-8333-333333333333"
const AGENT_USER = "55555555-5555-4555-8555-555555555555"
const NOW = new Date("2026-11-06T15:00:00Z")
const CANARY = "We need a 2-acre minimum and a 25-minute commute to Fort Hood."

const travel = (minutes: number | null): HomeLocationEvidence => ({
  home: null, amenities: null, surroundings: null, notes: [],
  travel: [{ target: "Fort Hood", placeLabel: "Fort Hood, TX", to: { lat: 31.13, lon: -97.78 }, profile: "driving", minutes, meters: minutes != null ? minutes * 1300 : null, assumption: "typical weekday traffic", observed_at: NOW.toISOString(), map: null }],
})
const criteria = (s: string) => ({ ...emptyCriteria(), lifestyle: extractLifestyleAsks(s) }) as never
const home = (acres: number | null, extra: Record<string, unknown> = {}) => ({ price: 450000, bedrooms: 3, bathrooms: 2, property_type: "single_family", city: "Killeen", lot_size: acres, lot_size_unit: acres == null ? null : "acres", ...extra }) as never

async function main() {
  console.log("\n A. CONSTRAINTS (C27) — only what the buyer said, in the lot_size_unit vocabulary")
  const asks = extractLifestyleAsks(CANARY)
  const cons = statedHardConstraints(asks)
  check("the canary sentence yields TWO hard constraints: 2 acres and 25 minutes to Fort Hood", cons.length === 2 && cons.some((c) => c.field === "lifestyle:outdoor_space" && c.bar === 2 && c.said === "2 acres") && cons.some((c) => c.field === "lifestyle:commute" && c.bar === 25 && /Fort Hood/.test(c.said)), JSON.stringify({ asks, cons }))
  check("NOTHING INVENTED: 'a big yard and an easy commute' → no hard constraint", statedHardConstraints(extractLifestyleAsks("a big yard and an easy commute to Fort Hood")).length === 0)
  check("POSITIVE CONTROL: the same words with numbers DO yield constraints", statedHardConstraints(extractLifestyleAsks("at least 2 acres and a commute to Fort Hood under 25 minutes")).length === 2)
  const sq = statedHardConstraints(extractLifestyleAsks("a lot of at least 87,120 sq ft"))
  check("a square-feet minimum is held in the buyer's own unit (said back as sq ft, measured as 2 acres)", sq.length === 1 && sq[0].said === "87,120 sq ft" && Math.abs(sq[0].bar - 2) < 1e-9, JSON.stringify(sq))
  const vocab = CHECK_VOCABULARIES.listings?.lot_size_unit ?? []
  check("the buyer's unit vocabulary IS listings.lot_size_unit (derived from the live CHECK cache)", vocab.length > 0 && [...LOT_UNITS].sort().join() === [...vocab].sort().join(), `${LOT_UNITS} vs ${vocab}`)
  check("the retired 'sqft' spelling is read once into 'square_feet'; an invented unit is refused", readLotMinimum({ value: 1000, unit: "sqft", stated_by: "buyer", literal: "1000 sq ft lot", confidence: "high" })?.unit === "square_feet" && readLotMinimum({ value: 1, unit: "hectares", stated_by: "buyer", literal: "x", confidence: "high" }) === null)
  check("an AI-stated minimum is never a constraint", statedHardConstraints([{ kind: "outdoor_space", label: "acreage", direction: "more", target: null, maxMinutes: null, lotMinimum: { value: 2, unit: "acres", stated_by: "ai" as never, literal: "2 acres", confidence: "high" }, evidence: "x" }]).length === 0)

  console.log("\n B. CANARY 7 — only licensed ACTIVE options that prove every stated constraint")
  const crit = criteria(CANARY)
  const cand = (ref: string, origin: ConstraintCandidate["origin"], status: string | null, acres: number | null, minutes: number | null): ConstraintCandidate =>
    ({ ref, label: ref, origin, status, fit: explainCriteriaFit(home(acres), crit, travel(minutes)) })
  const page: ConstraintCandidate[] = [
    cand("A-idx-2.5ac-20min", "idx_mls", "active", 2.5, 20),
    cand("B-rentcast-3ac-31min", "rentcast_listing", "Active", 3, 31),
    cand("C-own-1.4ac-18min", "tenant_listing", "active", 1.4, 18),
    cand("D-rentcast-nostatus-5ac-10min", "rentcast_listing", null, 5, 10),
    cand("E-pasted-link-6ac-5min", "buyer_url", "active", 6, 5),
    cand("F-idx-nolot-15min", "idx_mls", "active", null, 15),
    cand("G-idx-pending-4ac-12min", "idx_mls", "pending", 4, 12),
    cand("H-own-2ac-unmeasured", "tenant_listing", "active", 2, null),
  ]
  const ans = answerStatedConstraints(page, cons)
  check("ONLY the licensed, active home that meets BOTH is offered", ans.options.length === 1 && ans.options[0] === "A-idx-2.5ac-20min", JSON.stringify(ans.options))
  check("a home exactly AT the minimum (2.0 acres) meets it — 'at least' is inclusive", explainCriteriaFit(home(2), crit, travel(25)).matches.filter((m) => m.field.startsWith("lifestyle:")).length === 2)
  // Licensed-active is judged through the public door: with NO constraint every licensed active candidate is an option.
  const offered = (origin: ConstraintCandidate["origin"], status: string | null) => answerStatedConstraints([{ ref: "x", label: "x", origin, status, fit: null }], []).counts.notLicensedActive === 0
  check("a RentCast row with NO reported status is not offered (null is never upgraded to active)", !ans.options.includes("D-rentcast-nostatus-5ac-10min") && !offered("rentcast_listing", null))
  check("a home the buyer pasted from a link (or a manual row) is never offered back as a match", !ans.options.includes("E-pasted-link-6ac-5min") && !offered("buyer_url", "active") && !offered("manual", "active"))
  check("a pending listing is not offered", !ans.options.includes("G-idx-pending-4ac-12min"))
  check("POSITIVE CONTROL: a RentCast row reported Active IS licensed-active (and so are IDX and tenant listings)", offered("rentcast_listing", "Active") && offered("idx_mls", "active") && offered("tenant_listing", "active"))
  check("misses and unknowns are COUNTED, not shown (1 commute miss, 1 lot miss, 1 lot unknown, 1 drive unmeasured)",
    ans.counts.missed["lifestyle:commute"] === 1 && ans.counts.missed["lifestyle:outdoor_space"] === 1 && ans.counts.unknown["lifestyle:outdoor_space"] === 1 && ans.counts.unknown["lifestyle:commute"] === 1 && ans.counts.notLicensedActive === 3, JSON.stringify(ans.counts))
  check("with an option on the page there is no shortage explanation", ans.shortage === null)
  const none = answerStatedConstraints(page, [])
  check("no stated constraint → nothing is held (every licensed active home passes through untouched)", none.shortage === null && none.constraints.length === 0)

  console.log("\n C. SHORTAGE — the empty page explains itself and never relaxes the buyer's ask")
  const short = answerStatedConstraints(page.filter((c) => c.ref !== "A-idx-2.5ac-20min"), cons)
  check("no option → no home is offered", short.options.length === 0)
  const s = short.shortage
  check("the explanation names both must-haves in the buyer's words", !!s && /2 acres/.test(s.headline) && /25 minutes to Fort Hood/.test(s.headline), s?.headline)
  check("it says how many active homes were checked and why each group fell short", !!s && s.lines.some((l) => /checked 4 active homes/.test(l)) && s.lines.some((l) => /short on the drive/.test(l)) && s.lines.some((l) => /short on the land/.test(l)) && s.lines.some((l) => /don't publish a lot size/.test(l)) && s.lines.some((l) => /couldn't measure the drive/.test(l)), JSON.stringify(s?.lines))
  check("the ideas come from MEASURED near-misses (31 minutes; 1.4 acres) and leave the choice to the buyer", !!s && s.ideas.some((i) => /31 minutes/.test(i)) && s.ideas.some((i) => /1\.4 acres/.test(i)) && s.ideas.some((i) => /keep both exactly as they are/.test(i)), JSON.stringify(s?.ideas))
  check("transparency: the source of the answer is said, and unknowns are counted rather than guessed", !!s && /listing data and measured drive times/.test(s.transparency) && /won't loosen/.test(s.transparency))
  const BAD = /\b(dream home|act fast|won't last|hot market|don't miss|perfect home)\b/i
  check("care-first copy: no stock real-estate campaign phrase (R10)", !!s && !BAD.test([s.headline, ...s.lines, ...s.ideas, s.transparency].join(" ")))
  check("POSITIVE CONTROL: the phrase census sees a planted cliché", BAD.test("Your dream home won't last"))
  const empty = answerStatedConstraints([], cons)
  check("an empty search still answers kindly (no active listings to check)", !!empty.shortage && /didn't see any active listings/.test(empty.shortage.lines[0]))

  console.log("\n D. ORIGIN — the survivor `source` column carries it; m991 agrees")
  const o = homes.savedHomeOrigin
  check("idx/mls → idx_mls; rentcast → rentcast_listing; buyer_url → buyer_url", o({ source: "idx" }) === "idx_mls" && o({ source: "mls" }) === "idx_mls" && o({ source: "rentcast" }) === "rentcast_listing" && o({ source: "buyer_url" }) === "buyer_url")
  check("a tenant listing (listing_id / brokerage_listing) → tenant_listing; manual / none → manual", o({ source: null, listing_id: "L1" }) === "tenant_listing" && o({ source: "brokerage_listing" }) === "tenant_listing" && o({ source: "manual" }) === "manual" && o({}) === "manual")
  const m991 = raw("supabase/migrations/m991-saved-home-origin-and-source-url.sql")
  const arr = /saved_properties_source_check[\s\S]*?ARRAY\[([^\]]+)\]/.exec(m991)?.[1] ?? ""
  const m991Sources = [...arr.matchAll(/'([a-z_]+)'::text/g)].map((x) => x[1])
  const live = CHECK_VOCABULARIES.saved_properties?.source ?? []
  check("m991 keeps every live source value and adds buyer_url (the CHECK is widened, never narrowed)", live.length > 0 && live.every((v) => m991Sources.includes(v)) && m991Sources.includes("buyer_url"), `${m991Sources} ⊇ ${live}`)
  check("every m991 source value maps to an origin the owner named or the two existing ones", m991Sources.every((v) => (homes.SAVED_HOME_ORIGINS as readonly string[]).includes(o({ source: v }))) && ["idx_mls", "rentcast_listing", "buyer_url"].every((x) => m991Sources.map((v) => o({ source: v })).includes(x as never)))
  // THE RULE, not the waypoint: line 1 is the lane stamp while the file waits, the APPLIED LIVE stamp once the integrator applied it.
  const STAMP_LINE_1 = /^-- WRITTEN, NOT APPLIED \(wave 150, lane 150W\)|^-- ── APPLIED LIVE /
  check("the migration's line 1 carries a stamp (lane or applied)", STAMP_LINE_1.test(m991))
  check("m991 adds the two columns the code writes (source_url, mls_name) and the link-shape CHECKs", /ADD COLUMN IF NOT EXISTS source_url text/.test(m991) && /ADD COLUMN IF NOT EXISTS mls_name\s+text/.test(m991) && /saved_properties_buyer_url_has_link/.test(m991) && /saved_properties_source_url_shape/.test(m991))
  check("ONE vocabulary: m991 adds no parallel `origin` column", !/ADD COLUMN[^;]*\borigin\b/i.test(stripComments(m991.replace(/^--.*$/gm, ""))))

  console.log("\n E. PHOTOS — the one gate (owner R9)")
  const URL1 = "https://cdn.example.com/p.jpg"
  check("a RentCast listing NEVER shows a photo, even when a URL sits on the row", homes.licensedPhotoFor({ source: "rentcast", primary_photo_url: URL1 }) === null)
  check("a pasted link and a manual row never show a photo", homes.licensedPhotoFor({ source: "buyer_url", primary_photo_url: URL1 }) === null && homes.licensedPhotoFor({ source: "manual", primary_photo_url: URL1 }) === null)
  // 150XY's exact shape (lane150XY-notes `## Outside-lane`): { url, caption, order, source, media_id, uploaded_by,
  // ownership_attested_at, attestation_version }.
  const up = (url: string, order: number, extra: Record<string, unknown> = {}) => ({ url, caption: null, order, source: "owner_upload", media_id: `m-${order}`, uploaded_by: AGENT_USER, ownership_attested_at: NOW.toISOString(), attestation_version: "2026-11-06", ...extra })
  const ownPhotoOf = (photos: unknown, approved?: ReadonlySet<string>) => homes.licensedPhotoFor({ listing_id: "L1" }, photos, approved)?.url ?? null
  check("an IDX save shows NO stored photo (IDX photos render from the feed at display time, never copied onto a row)", homes.licensedPhotoFor({ source: "idx", primary_photo_url: URL1, mls_name: "Central Texas MLS" }) === null)
  const ownPhoto = homes.licensedPhotoFor({ listing_id: "L1", primary_photo_url: URL1 }, [up("https://own/2.jpg", 1), up("https://own/1.jpg", 0)])
  check("POSITIVE CONTROL: the tenant listing's attested owner upload IS shown, first in gallery order", ownPhoto?.url === "https://own/1.jpg" && ownPhoto.source === "tenant_listing_media")
  check("the saved row's own primary_photo_url copy is never read (unknown provenance)", homes.licensedPhotoFor({ listing_id: "L1", primary_photo_url: URL1 }) === null && homes.licensedPhotoFor({ listing_id: "L1", primary_photo_url: URL1 }, []) === null)
  check("LEGACY entries (a plain string, or no `source`) are never shown as owned", ownPhotoOf(["https://own/legacy.jpg"]) === null && ownPhotoOf([{ url: "https://own/legacy.jpg", order: 0 }]) === null)
  check("an owner upload missing its attestation, media_id or uploader is not shown", ownPhotoOf([up("https://own/a.jpg", 0, { ownership_attested_at: null })]) === null && ownPhotoOf([up("https://own/b.jpg", 0, { media_id: null })]) === null && ownPhotoOf([up("https://own/c.jpg", 0, { uploaded_by: null })]) === null)
  check("a photo entry from any other source (e.g. rentcast) inside listings.photos is skipped", ownPhotoOf([{ url: "https://rc/1.jpg", source: "rentcast", order: 0 }]) === null)
  check("APPROVAL-GATED: an upload not in the approved set is skipped; an empty set (unreadable approvals) shows none", ownPhotoOf([up("https://own/1.jpg", 0), up("https://own/2.jpg", 1)], new Set(["m-1"])) === "https://own/2.jpg" && ownPhotoOf([up("https://own/1.jpg", 0)], new Set()) === null)
  check("ownerUploadMediaIds lists exactly the owner-upload media ids", homes.ownerUploadMediaIds([up("https://own/1.jpg", 0), { url: "https://x", source: "rentcast", media_id: "rc" }, "https://legacy"]).join() === "m-0")
  check("the engine's half: a RentCast result row carries no photo; an IDX row does", homes.licensedResultPhotoUrl("rentcast", URL1) === null && homes.licensedResultPhotoUrl("idx", URL1) === URL1)

  console.log("\n F. RENTCAST DISPLAY — the MLS name is the source")
  const lab = describeListingSource("rentcast", { mlsName: "Unlock MLS" })
  check("a RentCast listing is labelled with its MLS as the source and RentCast as the facts carrier", /Listed on Unlock MLS/.test(lab.label) && /RentCast/.test(lab.label) && lab.verified_active_listing === false && lab.evidence_source === "provider:rentcast")
  check("without an MLS name the honest fallback stays", /RentCast property data/.test(describeListingSource("rentcast").label))
  check("the saved-home line names the MLS for a RentCast save and the site for a pasted link", /Listed on Unlock MLS/.test(homes.savedHomeSourceLine({ source: "rentcast", mls_name: "Unlock MLS" })) && /zillow\.com/.test(homes.savedHomeSourceLine({ source: "buyer_url", source_url: "https://www.zillow.com/homedetails/x" })))

  console.log("\n G. SAVE FROM A LINK — address from the link, facts through the rail, idempotent, tenant-stamped")
  const z = homes.parsePropertyLink("https://www.zillow.com/homedetails/1234-Oak-Hill-Dr-Killeen-TX-76542/29384_zpid/?utm_source=share#photos")
  check("Zillow: '1234 Oak Hill Dr', Killeen, TX 76542; tracking + fragment stripped", !("error" in z) && z.address?.street === "1234 Oak Hill Dr" && z.address.city === "Killeen" && z.address.state === "TX" && z.address.zip === "76542" && !z.url.includes("utm_") && !z.url.includes("#"), JSON.stringify(z))
  const rl = homes.parsePropertyLink("https://www.realtor.com/realestateandhomes-detail/77-Ranch-Rd_Copperas-Cove_TX_76522_M12345-67890")
  check("Realtor.com: '77 Ranch Rd', Copperas Cove", !("error" in rl) && rl.address?.street === "77 Ranch Rd" && rl.address.city === "Copperas Cove" && rl.address.zip === "76522", JSON.stringify(rl))
  const rf = homes.parsePropertyLink("https://www.redfin.com/TX/Harker-Heights/500-Mesa-Verde-Ct-76548/home/123456")
  check("Redfin: '500 Mesa Verde Ct', Harker Heights, TX 76548", !("error" in rf) && rf.address?.street === "500 Mesa Verde Ct" && rf.address.city === "Harker Heights" && rf.address.state === "TX" && rf.address.zip === "76548", JSON.stringify(rf))
  const unk = homes.parsePropertyLink("https://example-broker.com/listing/9f8e7d")
  check("an unknown site's link is accepted with address UNKNOWN (never guessed)", !("error" in unk) && unk.address === null)
  check("non-links and non-web schemes are refused", "error" in homes.parsePropertyLink("javascript:alert(1)") && "error" in homes.parsePropertyLink("not a link") && "error" in homes.parsePropertyLink("ftp://x.com/a") && "error" in homes.parsePropertyLink("https://user:pw@x.com/a"))
  check("the save key is stable for the same link (one row per buyer + link)", !("error" in z) && z.key === (homes.parsePropertyLink("https://www.zillow.com/homedetails/1234-Oak-Hill-Dr-Killeen-TX-76542/29384_zpid/") as { key: string }).key)

  const db = memSupabase({ saved_properties: [{ id: "other-tenant", brokerage_id: OTHER_BRK, contact_id: BUYER, source: "buyer_url", external_property_id: (z as { key: string }).key, source_url: "https://x" }] }, { uuidIds: true })
  const calls: Array<Record<string, unknown>> = []
  const lookup = async (req: any) => {
    calls.push(req)
    return { found: true, rungsTried: ["cache"], skipped: [], facts: { address: "1234 Oak Hill Dr", city: "Killeen", state: "TX", zip: "76542", beds: 4, baths: 2.5, sqft: 2400, yearBuilt: 2004, lotSize: 2.3, propertyType: "single_family", listingStatus: "active", listPrice: 489000, estimatedValue: 999999, taxAssessedValue: 111, annualPropertyTax: 1, propertyTaxYear: 2025, hoaMonthly: null, mlsNumber: "MLS-778", listingUrl: null, lat: null, lon: null, isEstimate: false, source: "rentcast", sourceNote: "" } } as any
  }
  const ctx = { brokerageId: BRK, contactId: BUYER, ownerUserId: AGENT_USER }
  const r1 = await homes.saveHomeFromLink(db as never, ctx, "https://www.zillow.com/homedetails/1234-Oak-Hill-Dr-Killeen-TX-76542/29384_zpid/", { lookup, now: NOW })
  const mine = db.tables.saved_properties.filter((r) => r.brokerage_id === BRK)
  check("the link save creates ONE row in the buyer's tenant, origin buyer_url, with the link as source_url", r1.ok && r1.created && mine.length === 1 && mine[0].source === "buyer_url" && /^https:\/\/www\.zillow\.com\/homedetails\//.test(mine[0].source_url) && mine[0].contact_id === BUYER && mine[0].user_id === AGENT_USER, JSON.stringify(mine))
  check("the facts came through the rail as a CUSTOMER lookup for the address read from the link", calls.length === 1 && calls[0].audience === "customer" && calls[0].purpose === "conversation" && calls[0].brokerageId === BRK && (calls[0].address as any)?.street === "1234 Oak Hill Dr")
  check("public listing facts are stored (address, beds, baths, sqft, MLS number, the ACTIVE asking price)", mine[0].bedrooms === 4 && mine[0].sqft === 2400 && mine[0].mls_number === "MLS-778" && mine[0].list_price === 489000 && mine[0].property_address === "1234 Oak Hill Dr")
  check("NO valuation, tax basis or photo is stored for the portal contact (no financials but their own)", !JSON.stringify(mine[0]).includes("999999") && !("estimated_value" in mine[0]) && mine[0].primary_photo_url === null)
  const r2 = await homes.saveHomeFromLink(db as never, ctx, "https://www.zillow.com/homedetails/1234-Oak-Hill-Dr-Killeen-TX-76542/29384_zpid/?utm_campaign=x", { lookup, now: NOW })
  check("saving the same link again refreshes the one row (idempotent)", r2.ok && !r2.created && db.tables.saved_properties.filter((r) => r.brokerage_id === BRK).length === 1)
  check("another tenant's row with the same link is never touched", db.tables.saved_properties.find((r) => r.id === "other-tenant")?.source_url === "https://x")
  const soldLookup = async (req: any) => ({ ...(await lookup(req)), facts: { ...(await lookup(req)).facts, listingStatus: "sold" } })
  const r3 = await homes.saveHomeFromLink(db as never, ctx, "https://www.redfin.com/TX/Harker-Heights/500-Mesa-Verde-Ct-76548/home/123456", { lookup: soldLookup, now: NOW })
  check("a home reported SOLD keeps its facts but no asking price (a stale price misleads)", r3.ok && db.tables.saved_properties.find((r) => r.id === (r3 as { savedId: string }).savedId)?.list_price === null)
  const r4 = await homes.saveHomeFromLink(db as never, ctx, "https://example-broker.com/listing/9f8e7d", { lookup, now: NOW })
  check("an unreadable link still saves (link only), says so, and spends no lookup", r4.ok && r4.created && !r4.resolved && r4.notes.some((n) => /couldn't read an address/.test(n)) && calls.length === 4, `calls=${calls.length}`)
  const missLookup = async () => ({ found: false, facts: null, rungsTried: [], skipped: [] }) as any
  const r5 = await homes.saveHomeFromLink(db as never, ctx, "https://www.realtor.com/realestateandhomes-detail/77-Ranch-Rd_Copperas-Cove_TX_76522_M1", { lookup: missLookup, now: NOW })
  check("a link whose facts aren't found keeps the address it read and tells the buyer the agent will fill in the rest", r5.ok && !r5.resolved && db.tables.saved_properties.find((r) => r.id === (r5 as { savedId: string }).savedId)?.property_address === "77 Ranch Rd")
  const refused = memSupabase({ saved_properties: [] }, { refuse: { saved_properties: "permission denied" } })
  const r6 = await homes.saveHomeFromLink(refused as never, ctx, "https://www.zillow.com/homedetails/1234-Oak-Hill-Dr-Killeen-TX-76542/1_zpid/", { lookup })
  check("a refused read is reported as a failure, never as a save", !r6.ok)

  console.log("\n H. SAVE A RENTCAST LISTING — identifiers on the buyer's own row, count-checked")
  const rdb = memSupabase({ saved_properties: [
    { id: "rc1", brokerage_id: BRK, contact_id: BUYER, source: "rentcast", external_property_id: "123-Main-St,-Killeen,-TX-76542", primary_photo_url: "https://vendor/photo.jpg" },
    { id: "rc-other", brokerage_id: OTHER_BRK, contact_id: BUYER, source: "rentcast", external_property_id: "123-Main-St,-Killeen,-TX-76542" },
  ] })
  const ref = homes.cleanListingRef({ externalId: "123-Main-St,-Killeen,-TX-76542", mlsNumber: "CTX-5521", mlsName: "Central Texas MLS", address: "123 Main St", price: 1 })
  check("the browser's reference keeps identifiers only (a posted price is dropped)", !!ref && ref.mlsNumber === "CTX-5521" && !("price" in ref))
  check("a malformed reference is refused", homes.cleanListingRef({ externalId: "<script>" }) === null && homes.cleanListingRef({ externalId: "ok", mlsNumber: "bad number!" })?.mlsNumber === null)
  const st = await homes.stampRentcastListingSave(rdb as never, { brokerageId: BRK, contactId: BUYER }, ref!)
  const rc1 = rdb.tables.saved_properties.find((r) => r.id === "rc1")!
  check("the save carries its rentcast_listing origin: listing id + MLS number + MLS name; any vendor photo cleared", st.ok && rc1.mls_number === "CTX-5521" && rc1.mls_name === "Central Texas MLS" && rc1.primary_photo_url === null && homes.savedHomeOrigin(rc1) === "rentcast_listing")
  check("another tenant's identical row is not stamped", !rdb.tables.saved_properties.find((r) => r.id === "rc-other")?.mls_name)
  const st0 = await homes.stampRentcastListingSave(rdb as never, { brokerageId: BRK, contactId: BUYER }, { externalId: "no-such-listing" })
  check("a stamp that matches nothing is reported, not called a success (count-checked)", !st0.ok)

  console.log("\n I. FAMILY — every origin shares, facts only, the collaborator is never a contact or a lead")
  const fdb = memSupabase({
    contacts: [{ id: BUYER, brokerage_id: BRK, first_name: "Dana", email: "dana@example.com" }],
    leads: [],
    saved_properties: [
      { id: "s-idx", brokerage_id: BRK, contact_id: BUYER, source: "idx", external_property_id: "idx-1", property_address: "1 Feed Ln", primary_photo_url: "https://idx/1.jpg", mls_name: "Central Texas MLS", dismissed: false },
      { id: "s-rc", brokerage_id: BRK, contact_id: BUYER, source: "rentcast", external_property_id: "rc-9", property_address: "9 Vendor Way", primary_photo_url: "https://vendor/9.jpg", mls_name: "Unlock MLS", dismissed: false },
      { id: "s-url", brokerage_id: BRK, contact_id: BUYER, source: "buyer_url", external_property_id: "url:abc", source_url: "https://www.zillow.com/homedetails/x", property_address: "5 Link Rd", primary_photo_url: "https://zillow/5.jpg", dismissed: false },
      { id: "s-own", brokerage_id: BRK, contact_id: BUYER, source: "brokerage_listing", listing_id: "L-own", property_address: "3 Own Ct", primary_photo_url: "https://own/legacy.jpg", dismissed: false },
    ],
    listing_media: [
      { id: "m-approved", brokerage_id: BRK, is_approved: true },
      { id: "m-unapproved", brokerage_id: BRK, is_approved: false },
    ],
    collaborative_searches: [], collaborative_search_members: [], collaborative_search_properties: [], property_family_ratings: [], property_consensus: [],
  }, { stampCreatedAt: true, uuidIds: true })
  let tokenN = 0
  const sh = await share.shareCollection(fdb as never, { brokerageId: BRK, buyerContactId: BUYER, actorUserId: AGENT_USER, listingRefs: ["idx-1", "rc-9", "url:abc", "L-own"], collaborator: { name: "Mom", email: "mom@example.com" }, scope: "feedback_only", now: NOW }, {
    checkSuppression: async () => ({ suppressed: false }), sendEmailInvite: async () => ({ ok: true }), tokenFactory: () => `tok-${++tokenN}-${"y".repeat(40)}`,
  })
  const shared = fdb.tables.collaborative_search_properties
  check("all three origins share (IDX/MLS, RentCast listing, pasted link) beside a tenant listing", sh.ok && sh.sharedHomeIds.length === 4 && shared.length === 4, JSON.stringify(sh))
  const pd = (addr: string) => shared.find((p) => p.property_data?.address === addr)?.property_data ?? {}
  check("photos follow the one gate: no stored IDX copy, no RentCast or pasted-link URL is ever shared", pd("1 Feed Ln").photo === null && pd("9 Vendor Way").photo === null && pd("5 Link Rd").photo === null)
  check("a tenant listing with no embedded media never shares its saved row's legacy primary_photo_url", pd("3 Own Ct").photo === null)
  // memSupabase runs no embed, so the `listings(photos)` half is driven directly on the row PostgREST would return.
  const ownRow = { source: "brokerage_listing", listing_id: "L-own", property_address: "3 Own Ct", primary_photo_url: "https://own/legacy.jpg", listings: { photos: [up("https://own/unapproved.jpg", 0, { media_id: "m-unapproved" }), up("https://own/approved.jpg", 1, { media_id: "m-approved" })] } }
  const appr = await share.approvedUploadIds(fdb as never, BRK, [ownRow])
  const apprOther = await share.approvedUploadIds(fdb as never, OTHER_BRK, [ownRow])
  check("approvals are read tenant-confined: only the approved upload id, none for another tenant", appr.error === null && [...appr.ids].join() === "m-approved" && apprOther.ids.size === 0)
  check("POSITIVE CONTROL: the tenant listing shares its APPROVED, attested owner upload — not the unapproved one, not the legacy copy", share.sharedFactsFromSaved(ownRow, appr.ids).photo === "https://own/approved.jpg" && share.sharedFactsFromSaved(ownRow).photo === null)
  const apprRefused = await share.approvedUploadIds(memSupabase({ listing_media: [] }, { refuse: { listing_media: "permission denied" } }) as never, BRK, [ownRow])
  check("an unreadable approval list reports its error and yields no ids (fail closed)", !!apprRefused.error && apprRefused.ids.size === 0)
  check("each shared home says where it came from (MLS name / site)", /Unlock MLS/.test(pd("9 Vendor Way").source_line ?? "") && /zillow\.com/.test(pd("5 Link Rd").source_line ?? ""))
  if (sh.ok) {
    const view = await share.collaboratorView(fdb as never, sh.token, NOW)
    const target = view.ok ? view.view.homes.find((h) => h.facts.address === "9 Vendor Way") : null
    const op = target ? await share.recordCollaboratorOpinion(fdb as never, sh.token, { sharedHomeId: target.id, vote: "like", comment: "Love the porch" }, { tellShoppingAgent: async () => true }, NOW) : { ok: false }
    const rating = fdb.tables.property_family_ratings.find((r) => r.property_id === target?.id)
    check("the family opinion is scoped to the selected saved home", op.ok && !!rating && rating.property_id === target!.id && fdb.tables.property_family_ratings.length === 1)
    check("the family member is NOT made a contact or a lead", fdb.tables.contacts.length === 1 && fdb.tables.leads.length === 0)
    check("POSITIVE CONTROL: the contact/lead counters see a planted row", (() => { const t = memSupabase({ contacts: [{ id: "x" }, { id: "y" }] }); return t.tables.contacts.length === 2 })())
  }

  console.log("\n J. WIRING (stripped source)")
  const act = code("app/actions/buyer-search/conversational-search.ts")
  const door = act.slice(act.indexOf("export async function saveHomeFromLinkAction"))
  check("saveHomeFromLinkAction is gated FIRST (gateBuyer → requireContactAccess) and ledgered", door.indexOf("gateBuyer(") > 0 && door.indexOf("gateBuyer(") < door.indexOf("saveHomeFromLink(") && /withActionLedger\(/.test(door) && /buyer_search\.home\.save_link/.test(door))
  check("the tenant on the save is the gate's (g.brokerageId), never a body field", /brokerageId: g\.brokerageId, contactId: input\.contactId, ownerUserId/.test(door) && !/input\.brokerageId/.test(door))
  check("the RentCast save stamps its origin through the gated reaction door, count-checked", /stampRentcastListingSave\(g\.svc/.test(act) && /cleanListingRef\(/.test(act))
  const eng = code("lib/buyer-search/search-engine.ts")
  check("the engine holds the buyer's stated constraints and returns the answer", /statedHardConstraints\(fitCriteria\.lifestyle/.test(eng) && /answerStatedConstraints\(/.test(eng) && /results = pageResults\.filter/.test(eng) && /constraint_answer: constraintAnswer/.test(eng))
  check("the engine shows a RentCast row's MLS as its source and passes photos through the gate", /mlsName: isExternal \?/.test(eng) && /__photo_url: licensedResultPhotoUrl\(e\.source, e\.photoUrl\)/.test(eng))
  check("ONE origin vocabulary: the engine names a candidate's origin through savedHomeOrigin", /origin: savedHomeOrigin\(/.test(eng))
  check("the criteria turn records only a well-formed buyer-stated lot minimum", /lotMinimum: validLotMinimum\(l\.lotMinimum\) \? l\.lotMinimum : null/.test(code("lib/buyer-search/criteria-turn.ts")))
  const nl = code("app/portal/[contactId]/search/PortalNlSearch.tsx")
  check("the portal search shows the hold and the shortage explanation", /hold\.shortage\.headline/.test(nl) && /hold\.shortage\.ideas/.test(nl) && /hold\.shortage\.transparency/.test(nl))
  const pageSrc = code("app/portal/[contactId]/search/page.tsx")
  check("the saved-homes card reads its photo through licensedPhotoFor (no raw primary_photo_url <img>)", /licensedPhotoFor\(item/.test(pageSrc) && !/src=\{item\.primary_photo_url\}/.test(pageSrc))
  check("POSITIVE CONTROL: the raw-photo finder sees a planted raw <img>", /src=\{item\.primary_photo_url\}/.test("<img src={item.primary_photo_url} />"))
  check("the saved card names each home's origin and never links to /properties/null", /savedHomeSourceLine\(item\)/.test(pageSrc) && /item\.listing_id \?/.test(pageSrc))
  check("the saved-homes read reads its { error } (an unreadable list is not 'No saved properties yet')", /savedResult\.error/.test(pageSrc))
  check("the link card is mounted and imports a server action only (proxy-graph budget)", /<SaveHomeFromLinkCard contactId=\{contactId\} \/>/.test(pageSrc) && !/from "@\/lib\//.test(code("app/portal/[contactId]/search/SaveHomeFromLinkCard.tsx")))
  const shareSrc = code("lib/portal/collaborative-share.ts")
  check("the family share reads photos through the gate with listings.photos and the approved set", /licensedPhotoFor\(r, r\.listings\?\.photos, approvedMediaIds\)/.test(shareSrc) && /listings\(photos\)/.test(shareSrc) && /\.eq\("is_approved", true\)/.test(shareSrc))
  const collabAct = code("app/actions/collaborative-search.ts")
  check("the second share door (addPropertyToSearch) uses the same columns and approvals", /\.select\(SHARE_SAVED_COLUMNS\)/.test(collabAct) && /sharedFactsFromSaved\(row, approvals\.ids\)/.test(collabAct))
  check("the portal card passes the approved set (an owner upload shows only once approved)", /licensedPhotoFor\(item, item\.listings\?\.photos, approvedMediaIds\)/.test(pageSrc) && /from\("listing_media"\)/.test(pageSrc))
  check("the link save never fetches the linked page (no fetch in saved-homes)", !/\bfetch\(/.test(code("lib/portal/saved-homes.ts")))
  check("POSITIVE CONTROL: the fetch finder sees a planted fetch", /\bfetch\(/.test("await fetch(url)"))

  console.log(`\n RESULT: ${pass} passed, ${fail} failed${fail ? ` — ${failures.join(" | ")}` : ""}`)
  if (fail === 0) console.log(" BUYER_CONSTRAINTS_PASS")
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
