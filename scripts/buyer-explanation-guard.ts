#!/usr/bin/env tsx
/**
 * scripts/buyer-explanation-guard.ts (npm run test:buyer-explanation — key listed in the lane-148E notes)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 148, LANE 148E — NEIGHBOURLY BUYER EXPLANATIONS, MAPS, SOURCES (owner rulings 7, 8, 9; contract C18).
 *
 * Owner (2026-11-01): "you need to be more helpful — if they need walkability or how far it is to commute or yard size
 * or quiet setting, those can have more info like a map; outdoor space is a home with acreage; quiet setting is not
 * close to neighbors. The answers need to be a helping neighbor and more personable so that they want to meet with an
 * agent." + "buyer search is either on in-house listings or outside properties using RentCast or the tenant's IDX/MLS
 * provider" + "buyers' words are recorded; call transcripts save to the criteria store".
 *
 * WHAT IT PROVES (driven through the REAL modules; every absence claim has a POSITIVE CONTROL):
 *   A. THE PROVIDER — travel_time is a routed capability (Mapbox Matrix/Directions); unconfigured → no request and the
 *      variable named; failing → routed around; the gate refuses before any paid call; cache first; one request per
 *      page; booked per element; no tenant → nothing asked.
 *   B. C18 — every claim carries its evidence source or says unknown; validateClaims catches each broken shape.
 *   C. LIFESTYLE FROM EVIDENCE — commute (route, minutes, assumption, map), walkability (mapped places), yard/acreage
 *      (acres, unit basis, limits), quiet (building spacing, road exposure) — and UNKNOWN without evidence.
 *   D. THE THREE SOURCES labelled honestly — RentCast property data is never a verified active listing.
 *   E. THE WARM VOICE — a rubric every deterministic explanation passes (speaks to them, heard them, specific, one
 *      gentle question, the agent offered without pressure, never robotic); cold and pushy drafts fail it.
 *   F. NO INVENTED AMENITY — a place the evidence does not hold is refused (positive control: the same place WITH
 *      evidence passes); the model draft path runs that check and the rubric before it can be shown.
 *   G. THE EXPERT PROMPT — role, context, creative brief, facts (the evidence sources), must-not, decision, compliance
 *      boundary, output contract (question + agent offer), escalation.
 *   H. THE BUYER'S WORDS — call transcripts / portal turns recorded whole (literal, interpretation, confidence,
 *      consent — never fabricated), idempotent on the source, linked from the changes; corrections keep history; m916
 *      absent degrades by name.
 *   I. WIRING (stripped source) — in-house = the contact's tenant; RentCast facts carried; maps only from claim
 *      evidence in the portal; a search page never geocodes per home.
 *
 * BLIND SPOTS (published): no live Mapbox / Overpass / Nominatim / model call runs (no credentials in a proof — the
 * transports are driven through injected fakes with the documented response shapes); the portal is not rendered in a
 * browser (its wiring is read from stripped source); the warm-voice rubric is lexical — it proves the shape of a kind,
 * helpful answer, not that a human finds it kind.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const root = process.cwd()
const code = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const BRK = "11111111-1111-4111-8111-111111111111"
const CONTACT = "33333333-3333-4333-8333-333333333333"
const PROTECTED = /\b(kids?|children|family|families|school|schools|church|temple|mosque|synagogue|religio\w*|race|racial|ethnic\w*|national origin|disab\w*|older|senior|young|couple|married|safe|safety|crime|demographic\w*)\b/i
const HOME = { lat: 33.1507, lon: -96.8236 }       // a point in Frisco, TX
const MEDCTR = { lat: 33.0262, lon: -96.7898 }     // a point in Plano, TX

function fakeMapbox() {
  const calls: Array<{ path: string; query: Record<string, string> }> = []
  const call = async (req: any) => {
    calls.push({ path: req.path, query: req.query ?? {} })
    if (String(req.path).startsWith("/directions-matrix/")) {
      const n = String(req.query?.sources ?? "").split(";").filter(Boolean).length
      return { ok: true, status: 200, data: { code: "Ok", durations: Array.from({ length: n }, (_, i) => [1320 + i * 600]), distances: Array.from({ length: n }, (_, i) => [17500 + i * 9000]) } }
    }
    if (String(req.path).startsWith("/directions/")) {
      return { ok: true, status: 200, data: { code: "Ok", routes: [{ duration: 1310, distance: 17400, geometry: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" }] } }
    }
    return { ok: false, status: 404, data: null, error: "unexpected path" }
  }
  const store = new Map<string, unknown>()
  const cacheGet = async (k: string) => store.get(k) ?? null
  const cacheSet = async (k: string, v: unknown) => { store.set(k, v) }
  const booked: any[] = []
  const meter = async (i: any) => { booked.push(i); return true }
  return { calls, call, store, cacheGet, cacheSet, booked, meter }
}

async function main() {
  console.log("\n BUYER EXPLANATIONS — neighbourly, evidenced, sourced (wave 148E · rulings 7/8/9 · C18)\n")
  const rail = await import("../lib/ai-isa/property-lookup-rail")
  const { MAPBOX_SKU_USD } = await import("../lib/vendor-governance/cost-normalizer")
  const sv = await import("../lib/property/street-view")
  const ev = await import("../lib/buyer-search/explanation-evidence")
  const gen = await import("../lib/buyer-search/explanation-generator")
  const conv = await import("../lib/buyer-search/conversational-search")
  const { extractLifestyleAsks } = await import("../lib/buyer-search/conversation-criteria")
  const { scanFairHousing } = await import("../lib/buyer-search/fair-housing")

  // ── A ─────────────────────────────────────────────────────────────────────
  console.log("[A · the travel_time provider — routed, gated, cached, booked]")
  const tt = rail.CONTACT_PROVIDER_ROUTES.travel_time
  check("travel_time is a routed capability: Mapbox, at the SAME constant the transport books (MAPBOX_SKU_USD.matrix_element)", tt.length === 1 && tt[0].provider === "mapbox" && tt[0].unitCostUsd === MAPBOX_SKU_USD.matrix_element && tt[0].unitCostUsd > 0)
  check("travel_time degrades (a missing drive time is an UNKNOWN, never a blocked Mapbox failover)", rail.DEGRADABLE_CAPABILITIES.has("travel_time"))
  {
    const f = fakeMapbox()
    const r = await sv.requestTravelTimes({ brokerageId: BRK, origins: [HOME], destination: MEDCTR }, { env: {}, health: {}, call: f.call, cacheGet: f.cacheGet, cacheSet: f.cacheSet, gate: async () => ({ allowed: true, reason: "ok" }), meter: f.meter })
    check("UNCONFIGURED: no token → NO request, every answer null, and the waiting variable is NAMED (MAPBOX_TOKEN)", f.calls.length === 0 && r.provider === null && r.results.every((x) => x.minutes == null) && /MAPBOX_TOKEN/.test(r.note ?? ""), r.note ?? "")
  }
  {
    const f = fakeMapbox()
    const r = await sv.requestTravelTimes({ brokerageId: BRK, origins: [HOME], destination: MEDCTR }, { env: { MAPBOX_TOKEN: "sk.test" }, health: { mapbox: { state: "failing", routeAround: true, reason: "3 faults" } }, call: f.call, cacheGet: f.cacheGet, cacheSet: f.cacheSet, gate: async () => ({ allowed: true, reason: "ok" }), meter: f.meter })
    check("FAILING provider → routed around with its reason, no request", f.calls.length === 0 && r.provider === null && /provider_failing/.test(r.note ?? ""))
  }
  {
    const f = fakeMapbox()
    const r = await sv.requestTravelTimes({ brokerageId: BRK, origins: [HOME], destination: MEDCTR }, { env: { MAPBOX_TOKEN: "sk.test" }, health: {}, call: f.call, cacheGet: f.cacheGet, cacheSet: f.cacheSet, gate: async () => ({ allowed: false, reason: "past_due_beyond_grace" }), meter: f.meter })
    check("GATE FIRST: a refused gate makes NO paid request and books nothing (the reason is said)", f.calls.length === 0 && f.booked.length === 0 && /past_due_beyond_grace/.test(r.note ?? ""))
  }
  {
    const f = fakeMapbox()
    const r = await sv.requestTravelTimes({ brokerageId: null, origins: [HOME], destination: MEDCTR }, { env: { MAPBOX_TOKEN: "sk.test" }, health: {}, call: f.call, cacheGet: f.cacheGet, cacheSet: f.cacheSet, gate: async () => ({ allowed: true, reason: "ok" }), meter: f.meter })
    check("NO TENANT → nothing is asked (spend needs a verified tenant)", f.calls.length === 0 && r.provider === null)
  }
  const fA = fakeMapbox()
  const deps = { env: { MAPBOX_TOKEN: "sk.test", MAPBOX_PUBLIC_TOKEN: "pk.test" }, health: {}, call: fA.call, cacheGet: fA.cacheGet, cacheSet: fA.cacheSet, gate: async () => ({ allowed: true, reason: "ok" }), meter: fA.meter }
  const three = [HOME, { lat: 33.10, lon: -96.80 }, { lat: 33.20, lon: -96.85 }]
  const r1 = await sv.requestTravelTimes({ brokerageId: BRK, origins: three, destination: MEDCTR }, deps)
  const mcall = fA.calls[0]
  check("ONE Matrix request for a whole page: N sources → 1 destination, duration + distance annotations", fA.calls.length === 1 && /^\/directions-matrix\/v1\/mapbox\/driving\//.test(mcall.path) && mcall.query.sources === "0;1;2" && mcall.query.destinations === "3" && mcall.query.annotations === "duration,distance", JSON.stringify(mcall))
  check("answers parsed per home (seconds → minutes, metres kept)", r1.results[0].minutes === 22 && r1.results[0].meters === 17500 && r1.results[2].minutes === 42 && r1.elementsBilled === 3)
  check("BOOKED once per request at elements × MAPBOX_SKU_USD.matrix_element, platform-covered, variable", fA.booked.length === 1 && fA.booked[0].usageType === "matrix_element" && fA.booked[0].unitCount === 3 && Math.abs(fA.booked[0].cost - 3 * MAPBOX_SKU_USD.matrix_element) < 1e-9 && fA.booked[0].coverage === "platform_covered" && fA.booked[0].priceState === "variable")
  const r2 = await sv.requestTravelTimes({ brokerageId: BRK, origins: three, destination: MEDCTR }, deps)
  check("CACHE BEFORE PAID CALL: the same question again makes no request and bills nothing", fA.calls.length === 1 && r2.elementsBilled === 0 && r2.results.every((x) => x.cached && x.minutes != null))
  const route = await sv.requestTravelRoute({ brokerageId: BRK, from: HOME, to: MEDCTR }, deps)
  check("the Directions route returns minutes + the geometry a map draws (booked as one directions_request)", route.minutes === 22 && !!route.geometry && fA.booked.some((b) => b.usageType === "directions_request" && b.unitCount === 1))
  const routeMap = sv.getTravelRouteMapImageUrl({ from: HOME, to: MEDCTR, geometry: route.geometry, env: { MAPBOX_PUBLIC_TOKEN: "pk.test" } })
  check("the route map is drawn FROM the route geometry (Mapbox path overlay + A/B pins, public token only)", !!routeMap && routeMap.provider === "mapbox" && /\/static\/path-4\+3b82f6-0\.85\(/.test(routeMap.url) && /pin-s-a\+/.test(routeMap.url) && /access_token=pk\.test/.test(routeMap.url))
  check("POSITIVE CONTROL: no route geometry → NO route map (a straight line would pretend to be a road)", sv.getTravelRouteMapImageUrl({ from: HOME, to: MEDCTR, geometry: null, env: { MAPBOX_PUBLIC_TOKEN: "pk.test" } }) === null)
  check("a secret sk. token is never minted into a map URL (falls through to no provider)", sv.getTravelRouteMapImageUrl({ from: HOME, to: MEDCTR, geometry: "abc", env: { MAPBOX_TOKEN: "sk.secret" } }) === null)
  const svSrc = code("lib/property/street-view.ts")
  const body = svSrc.slice(svSrc.indexOf("export async function requestTravelTimes"), svSrc.indexOf("export interface TravelRoute"))
  check("in the transport, cache → route walk → gate → request → book run in that order (stripped source)", body.indexOf("cache.get(") < body.indexOf("resolveTravelTimeProvider(") && body.indexOf("resolveTravelTimeProvider(") < body.indexOf("travelGate(") && body.indexOf("travelGate(") < body.indexOf("mapboxCall(") && body.indexOf("mapboxCall(") < body.indexOf("bookTravelTimeSpend("))
  check("the transport walks routeCapability(\"travel_time\") and egresses only through the connector gateway", /routeCapability\("travel_time"/.test(svSrc) && /callConnector\(req\)/.test(svSrc) && !/fetch\(/.test(body))

  // ── B / C ────────────────────────────────────────────────────────────────
  console.log("\n[B · C18 claims · C · lifestyle answered from evidence]")
  const asks = extractLifestyleAsks("I want 2 acres, an easy commute to Plano Medical Center under 30 minutes, walkable to parks, and somewhere quiet, not close to neighbors.")
  check("asks captured in the buyer's words: acreage (min 2 acres), commute with target + limit, near parks, quiet / not close to neighbors", asks.some((a) => a.kind === "outdoor_space" && a.label === "acreage" && a.minAcres === 2) && asks.some((a) => a.kind === "commute" && a.target === "Plano Medical Center" && a.maxMinutes === 30) && asks.some((a) => a.kind === "nearby_amenity" && a.target === "parks") && asks.some((a) => a.kind === "quiet_setting" && /away from close neighbors/.test(a.label)), JSON.stringify(asks.map((a) => [a.kind, a.label, a.target, a.maxMinutes, a.minAcres])))
  const criteria = { ...conv.emptyCriteria(), maxPrice: 900000, minBeds: 3, lifestyle: asks, provenance: { lifestyle: { source: "said" as const, value: asks, evidence: "I want 2 acres…", channel: "portal" as const, at: "2026-11-01T00:00:00Z", reason: null } } }
  const routeMapEvidence = { kind: "route" as const, image_url: routeMap!.url, attribution: routeMap!.attribution, renderer: "mapbox" as const, evidence_source: "provider:mapbox" as const, from: { ...HOME, label: "14 Ranch Rd" }, to: { ...MEDCTR, label: "Plano Medical Center" }, minutes: 22, meters: 17400, profile: "driving", assumption: sv.trafficAssumption("driving"), observed_at: "2026-11-01T00:00:00Z" }
  const evidence = {
    home: { ...HOME, source: "provider:rentcast" as const },
    travel: [{ target: "Plano Medical Center", placeLabel: "Plano Medical Center", to: MEDCTR, profile: "driving", minutes: 22, meters: 17400, assumption: sv.trafficAssumption("driving"), observed_at: "2026-11-01T00:00:00Z", map: routeMapEvidence }],
    amenities: { source: "provider:osm" as const, observed_at: "2026-11-01T00:00:00Z", places: [{ name: "Shawnee Trail Park", kind: "park" as const, meters: 640, lat: 33.152, lon: -96.818 }, { name: "Kroger", kind: "grocery" as const, meters: 2100 }], map: null },
    surroundings: { source: "provider:osm" as const, observed_at: "2026-11-01T00:00:00Z", nearestOtherBuildingMeters: 85, buildingsWithin100m: 2, nearestMajorRoad: { meters: 900, name: "FM 423", kind: "primary" }, nearestRailMeters: null },
    notes: [],
  }
  const ranch = { price: 865000, bedrooms: 4, bathrooms: 3, property_type: "single_family", city: "Frisco", lot_size_sqft: 104544, facts_source: "provider:rentcast" as const, public_remarks: "Covered patio and mature trees." }
  const fit = gen.explainCriteriaFit(ranch as never, criteria as never, evidence)
  const item = (k: string) => [...fit.matches, ...fit.misses, ...fit.unknowns].find((i) => i.field === `lifestyle:${k}`)
  const commute = item("commute")!
  check("COMMUTE: a measured drive (22 min ≤ the 30 you gave) with route, distance, the traffic assumption, provider:mapbox and its map", fit.matches.includes(commute) && /About 22 min by car to Plano Medical Center/.test(commute.detail) && /without live traffic/.test(commute.detail) && commute.evidence?.source === "provider:mapbox" && commute.evidence?.figures?.minutes === 22 && commute.evidence?.map?.kind === "route", commute.detail)
  const yard = item("outdoor_space")!
  check("ACREAGE: 104,544 sq ft (RentCast) → 2.4 acres ≥ the 2 you asked for, in acres, with outdoor features and the usable-area limits", fit.matches.includes(yard) && /2\.4 acres/.test(yard.detail) && /covered patio/.test(yard.detail) && yard.evidence?.source === "provider:rentcast" && /usable yard isn't measured/.test(yard.evidence?.caveat ?? ""), yard.detail)
  const walk = item("nearby_amenity")!
  check("WALKABILITY: a park OSM maps within an easy walk, NAMED from the evidence, straight-line caveat", fit.matches.includes(walk) && /Shawnee Trail Park/.test(walk.detail) && walk.evidence?.source === "provider:osm" && /straight-line/.test(walk.evidence?.caveat ?? ""), walk.detail)
  const quiet = item("quiet_setting")!
  check("QUIET = not close to neighbours: nearest other mapped building ~280 ft, no major road within a quarter mile, never promised", fit.matches.includes(quiet) && /nearest other mapped building is about 280 ft/.test(quiet.detail) && /rush hour is the real test/.test(quiet.evidence?.caveat ?? ""), quiet.detail)
  const near = gen.explainCriteriaFit(ranch as never, criteria as never, { ...evidence, travel: [{ ...evidence.travel[0], minutes: 41, map: null }], surroundings: { ...evidence.surroundings, nearestMajorRoad: { meters: 60, name: "Dallas Pkwy", kind: "trunk" } } })
  check("a 41-minute drive is a MISS against 30; a trunk road 200 ft away is a quiet MISS (traffic sound said plainly)", near.misses.some((m) => m.field === "lifestyle:commute" && /over the 30 minutes/.test(m.detail)) && near.misses.some((m) => m.field === "lifestyle:quiet_setting" && /Dallas Pkwy/.test(m.detail)))
  const bare = gen.explainCriteriaFit({ price: 640000, bedrooms: 3, bathrooms: 2, property_type: "single_family", city: "Frisco", lot_size: 500 } as never, criteria as never, null)
  check("UNKNOWNS NEVER FACTS: with no evidence, commute / walkability / quiet are UNKNOWN; an ambiguous lot unit (500) is UNKNOWN, never converted", ["commute", "nearby_amenity", "quiet_setting", "outdoor_space"].every((k) => bare.unknowns.some((u) => u.field === `lifestyle:${k}`)) && bare.unknowns.some((u) => u.field === "lifestyle:outdoor_space" && /acres or square feet/.test(u.detail)))
  const small = gen.explainCriteriaFit({ price: 500000, lot_size: 0.18, city: "Frisco" } as never, { ...conv.emptyCriteria(), lifestyle: extractLifestyleAsks("less yard please") } as never, null)
  // Wave 149 (lane 149B — owner ruling 5, C27: "the buyer decides the yard and acreage minimum; AI clarifies, never invents
  // a minimum"): this pinned a WAYPOINT — "less yard" MATCHED a 0.18-acre lot against the platform's invented 0.2-acre bar
  // (SMALL_LOT_ACRES, now tombstoned). THE RULE, re-asserted: the lot is still read in acres only because it cannot be
  // square feet, and SAYS so — and with no size the buyer stated it is a FACT (fit.facts), not a platform verdict.
  check("an in-house lot of 0.18 (no unit recorded) reads as acres only because it cannot be square feet — and SAYS so; no stated size → a fact, never a platform verdict", (small.facts ?? []).some((m) => m.field === "lifestyle:outdoor_space" && /0\.18 acre/.test(m.detail) && /doesn't record the unit/.test(m.evidence?.caveat ?? "")) && !small.matches.some((m) => m.field === "lifestyle:outdoor_space"))
  const noMap = gen.explainCriteriaFit(ranch as never, criteria as never, { ...evidence, travel: [{ ...evidence.travel[0], map: null }] })
  check("POSITIVE CONTROL: a drive time with no drawn route carries NO map", !([...noMap.matches, ...noMap.misses].find((i) => i.field === "lifestyle:commute")?.evidence?.map))

  const label = ev.describeListingSource("rentcast")
  const claims = ev.claimsFromFit(fit, label)
  const v = ev.validateClaims(claims)
  check("C18: every claim names its evidence source or is an unknown (validateClaims clean)", v.ok && claims.every((c) => (c.unknown ? c.evidence_source === null : !!c.evidence_source)), v.problems.join("; "))
  check("C18: a RentCast row's listing facts are provider:rentcast (not 'listing'); remarks are agent_remarks; a drive is provider:mapbox with its map", claims.some((c) => c.topic === "price" && c.evidence_source === "provider:rentcast") && claims.some((c) => c.topic === "commute" && c.evidence_source === "provider:mapbox" && c.map?.kind === "route"))
  const bareClaims = ev.claimsFromFit(bare, ev.describeListingSource("platform", { brokerageName: "Kling Group Realty" }))
  check("C18: unknown claims carry no figures and no map", bareClaims.filter((c) => c.unknown).every((c) => !c.figures && !c.map) && bareClaims.some((c) => c.unknown && c.topic === "commute"))
  check("POSITIVE CONTROL: a claim with no evidence, an unknown with figures, and a route map with no minutes are each CAUGHT",
    !ev.validateClaims([{ claim: "x", topic: "commute", verdict: "match", evidence_source: null, confidence: "high" }]).ok
    && !ev.validateClaims([{ claim: "x", topic: "commute", verdict: "unknown", evidence_source: null, confidence: "low", unknown: true, figures: { minutes: 9 } }]).ok
    && !ev.validateClaims([{ claim: "x", topic: "commute", verdict: "match", evidence_source: "provider:mapbox", confidence: "medium", map: { ...routeMapEvidence, minutes: null } }]).ok)

  const { probeOverpassSurroundings } = await import("../lib/external/osint-neighborhood")
  let overpassQuery = ""
  const overpassFake = (async (req: any) => {
    overpassQuery = String(req.body?.data ?? "")
    return { ok: true, status: 200, headers: {}, drift: null, error: null, data: { elements: [
      { tags: { building: "house" }, center: { lat: HOME.lat + 0.00005, lon: HOME.lon } },           // the home itself (~6 m)
      { tags: { building: "house" }, center: { lat: HOME.lat + 0.0006, lon: HOME.lon } },            // ~67 m
      { tags: { highway: "primary", name: "FM 423" }, geometry: [{ lat: HOME.lat + 0.008, lon: HOME.lon }, { lat: HOME.lat + 0.004, lon: HOME.lon + 0.001 }] },
    ] } }
  }) as never
  const sp = await probeOverpassSurroundings(HOME.lat, HOME.lon, { call: overpassFake })
  const surr = sp.value!
  check("surroundings from OSM (the ONE Overpass egress): the home's own footprint is excluded, the nearest OTHER building and the road's nearest vertex measured", sp.outcome === "ok" && surr.nearestOtherBuildingMeters === 67 && surr.buildingsWithin100m === 2 && surr.nearestMajorRoad?.name === "FM 423" && (surr.nearestMajorRoad?.meters ?? 0) > 400 && (surr.nearestMajorRoad?.meters ?? 0) < 460 && /way\["building"\]/.test(overpassQuery) && /motorway\|trunk\|primary\|secondary/.test(overpassQuery), JSON.stringify(sp))

  // ── C2: the on-demand evidence door ("why this home?") end to end, every provider injected ──
  {
    const { gatherHomeLocationEvidence } = await import("../lib/buyer-search/location-evidence")
    const f = fakeMapbox()
    const geocodes: string[] = []
    const imgBooked: any[] = []
    const gdeps = {
      env: { MAPBOX_TOKEN: "sk.test", MAPBOX_PUBLIC_TOKEN: "pk.test" }, mapEnv: { MAPBOX_PUBLIC_TOKEN: "pk.test" }, health: {}, call: f.call, cacheGet: f.cacheGet, cacheSet: f.cacheSet,
      gate: async () => ({ allowed: true, reason: "ok" }), meter: f.meter, imageMeter: async (i: any) => { imgBooked.push(i); return true },
      geocode: async (p: any) => { geocodes.push(String(p.address)); return /Medical Center/.test(String(p.address)) ? { lat: MEDCTR.lat, lng: MEDCTR.lon } : /Ranch/.test(String(p.address)) ? { lat: HOME.lat, lng: HOME.lon } : null },
      amenities: async () => ({ outcome: "ok", places: [{ name: "Shawnee Trail Park", kind: "park" as const, meters: 640, lat: 33.152, lon: -96.818 }] }),
      surroundings: async () => ({ outcome: "ok", value: { nearestOtherBuildingMeters: 85, buildingsWithin100m: 2, nearestMajorRoad: null, nearestRailMeters: null } }),
    }
    const g = await gatherHomeLocationEvidence({ brokerageId: BRK, home: { address: "14 Ranch Rd", city: "Frisco", state: "TX", zip: "75034" }, asks }, gdeps)
    const t0 = g.travel[0]
    check("ON DEMAND: the home is placed (free geocoder, cached), the drive routed, and a ROUTE MAP drawn from that route (provider:mapbox, minutes, both ends)", g.home?.source === "provider:osm" && t0?.minutes === 22 && t0.map?.kind === "route" && t0.map.evidence_source === "provider:mapbox" && t0.map.minutes === 22 && !!t0.map.to, JSON.stringify(t0 ?? null).slice(0, 300))
    check("ON DEMAND: walkability carries a PLACES map of exactly the places OSM returned; spacing carries its OSM evidence", g.amenities?.map?.kind === "places" && g.amenities.map.evidence_source === "provider:osm" && /pin-s-1\+/.test(g.amenities.map.image_url) && g.surroundings?.nearestOtherBuildingMeters === 85)
    check("every map handed out is BOOKED (bookMapsImageSpend, the map_render SKU)", imgBooked.length === 2 && imgBooked.every((b) => b.vendorName === "mapbox" && b.usageType === "static_image"))
    const g2 = await gatherHomeLocationEvidence({ brokerageId: BRK, home: { address: "14 Ranch Rd", city: "Frisco", state: "TX", zip: "75034" }, asks }, gdeps)
    check("CACHE FIRST on the door too: the second explanation re-geocodes nothing and re-routes nothing", geocodes.length === 2 && f.calls.length === 1 && g2.travel[0]?.minutes === 22)
    const g3 = await gatherHomeLocationEvidence({ brokerageId: BRK, home: { address: "14 Ranch Rd", city: "Frisco", state: "TX", zip: "75034" }, asks: extractLifestyleAsks("easy commute to work") }, gdeps)
    check("'commute to work' with no address → NOT measured, and the note asks for the address (never a guessed destination)", (g3.travel.length === 0 || g3.travel[0].minutes == null))
    const g4 = await gatherHomeLocationEvidence({ brokerageId: BRK, home: { address: "14 Ranch Rd", city: "Frisco", state: "TX", zip: "75034" }, asks: extractLifestyleAsks("3 bed under 600k") }, gdeps)
    check("no lifestyle ask → nothing is fetched (no geocode, no route, no map)", g4.home === null && g4.travel.length === 0 && geocodes.length === 2 && f.calls.length === 1)
    const far = await gatherHomeLocationEvidence({ brokerageId: BRK, home: { address: "14 Ranch Rd", city: "Frisco", state: "TX", zip: "75034" }, asks: extractLifestyleAsks("commute to Seattle Medical Center") }, { ...gdeps, geocode: async (p: any) => (/Seattle/.test(String(p.address)) ? { lat: 47.6, lng: -122.3 } : { lat: HOME.lat, lng: HOME.lon }) })
    check("a destination the geocoder placed 2,000+ km away is REFUSED as the wrong place (never measured, said why)", far.travel[0]?.minutes == null && /too far from this home/.test(far.travel[0]?.note ?? ""), JSON.stringify(far.travel[0] ?? null).slice(0, 200))
  }

  // ── D ─────────────────────────────────────────────────────────────────────
  console.log("\n[D · the three sources, labelled for what they are]")
  const inh = ev.describeListingSource("platform", { brokerageName: "Kling Group Realty" })
  const idx = ev.describeListingSource("idx")
  check("in-house: 'One of Kling Group Realty's own listings', a verified active listing, evidence 'listing'", inh.kind === "in_house" && /Kling Group Realty's own listings/.test(inh.label) && inh.verified_active_listing && inh.evidence_source === "listing")
  check("IDX/MLS: from the MLS through the agent's IDX feed (status as the feed reports it)", idx.kind === "idx" && /MLS/.test(idx.label) && idx.verified_active_listing && /as the MLS feed reports/.test(idx.caveat ?? ""))
  check("RentCast: property data — NOT a verified active listing — and the agent confirms availability", label.kind === "rentcast" && !label.verified_active_listing && /not a verified active listing/i.test(label.label) && /confirm/.test(label.caveat ?? "") && label.evidence_source === "provider:rentcast")

  // ── E ─────────────────────────────────────────────────────────────────────
  console.log("\n[E · the warm, neighbourly voice — the agent's first impression]")
  const voices = [
    gen.composeNeighbourlyExplanation(fit, "14 Ranch Rd", { agentName: "Dana", brokerageName: "Kling Group Realty", source: label }),
    gen.composeNeighbourlyExplanation(near, "14 Ranch Rd", { agentName: "Dana", source: inh }),
    gen.composeNeighbourlyExplanation(bare, "9 Oak Ct", { agentName: null, source: inh }),
  ]
  for (const [i, e] of voices.entries()) {
    const text = gen.fullExplanationText(e)
    const r = ev.warmVoiceRubric(text, { agentName: i === 2 ? null : "Dana" })
    check(`explanation ${i + 1} passes the warm-voice rubric (speaks to them, heard them, specific, one gentle question, agent offered, no pressure, not robotic)`, r.pass, r.failures.join("; ") + " :: " + text)
  }
  check("the agent is offered by NAME, gently (an invitation, never a push)", /Dana would be glad to show it to you in person/.test(voices[0].agentOffer) && !/!/.test(voices[0].agentOffer))
  check("the follow-up question is ONE question from the fixed list", voices.every((e) => /\?$/.test(e.followUpQuestion) && (e.followUpQuestion.match(/\?/g) ?? []).length === 1))
  check("a commute with no destination asks WHERE (so the drive can be mapped)", gen.composeNeighbourlyExplanation(gen.explainCriteriaFit(ranch as never, { ...conv.emptyCriteria(), lifestyle: extractLifestyleAsks("my commute matters") } as never, null), "x").followUpQuestion.startsWith("Where's the commute to?"))
  check("a RentCast home SAYS it is property data, not a verified listing, in the narrative", /RentCast property data rather than a verified active listing/.test(voices[0].narrative))
  check("evidence-backed answers reach the narrative (the measured drive / the acres)", /22 min|2\.4 acres/.test(voices[0].narrative))
  check("every composition passes the steering check and names no protected class", voices.every((e) => scanFairHousing(gen.fullExplanationText(e)).flagged.length === 0 && !PROTECTED.test(`${e.headline} ${e.narrative}`)))
  check("UNKNOWNS NEVER AS FACTS in the narrative (restatesUnknown clean)", voices.every((e, i) => !gen.restatesUnknown(e.narrative, [fit, near, bare][i])))
  check("POSITIVE CONTROL: a cold, robotic draft FAILS the rubric", !ev.warmVoiceRubric("Property matches 4 of 5 criteria. Match score 82. Listed at $865k. Contact agent.").pass)
  check("POSITIVE CONTROL: a pushy draft FAILS the rubric", !ev.warmVoiceRubric("You told me you wanted acreage and this 2.4-acre home has it. Act now, it won't last! Would you like me to have your agent call you today?").pass)
  check("POSITIVE CONTROL: a warm draft with NO agent offer FAILS the rubric", !ev.warmVoiceRubric("You told me you wanted acreage, and this one sits on 2.4 acres with a covered patio and mature trees. The drive to Plano Medical Center is about 22 minutes. Is the price the only thing giving you pause?").pass)

  // ── F ─────────────────────────────────────────────────────────────────────
  console.log("\n[F · no invented amenity]")
  const factsNo = JSON.stringify({ listing: "14 Ranch Rd", claims: claims.filter((c) => c.topic !== "walkability").map((c) => c.claim) })
  const invented = ev.inventedPlaces("It's a short walk to Riverside Park, and a Whole Foods is around the corner.", factsNo)
  check("an INVENTED amenity is REFUSED (a park and a grocery the evidence never held)", invented.length >= 2 && invented.some((p) => /park/i.test(p)) && invented.some((p) => /Whole Foods/.test(p)), JSON.stringify(invented))
  const factsYes = JSON.stringify({ listing: "14 Ranch Rd", claims: claims.map((c) => c.claim) })
  check("POSITIVE CONTROL: the SAME kind of claim grounded in evidence passes (Shawnee Trail Park is in the OSM evidence)", ev.inventedPlaces("Shawnee Trail Park is an easy walk away, and the drive to Plano Medical Center is about 22 minutes.", factsYes).length === 0, JSON.stringify(ev.inventedPlaces("Shawnee Trail Park is an easy walk away, and the drive to Plano Medical Center is about 22 minutes.", factsYes)))
  check("home words are not places ('on the market', 'dining room')", ev.inventedPlaces("It has been on the market a week and the dining room is generous.", factsNo).length === 0)
  const convSrc = code("lib/buyer-search/conversational-search.ts")
  const narr = convSrc.slice(convSrc.indexOf("export async function narrateFitExplanation"))
  const modelReturn = narr.indexOf('via: "model"')
  check("the model draft is shown ONLY after: numbers grounded → no unknown restated → no invented place → warm-voice rubric → steering check (stripped source order)", narr.indexOf("numbersAreGrounded(") > 0 && narr.indexOf("numbersAreGrounded(") < narr.indexOf("restatesUnknown(") && narr.indexOf("restatesUnknown(") < narr.indexOf("inventedPlaces(") && narr.indexOf("inventedPlaces(") < narr.indexOf("warmVoiceRubric(") && narr.indexOf("warmVoiceRubric(") < narr.indexOf("scanFairHousing(") && narr.indexOf("scanFairHousing(") < modelReturn)
  const noTenant = await conv.narrateFitExplanation({ brokerageId: null, listingLabel: "14 Ranch Rd", fit, facts: ranch as never, claims, voice: { agentName: "Dana", source: label } })
  check("no tenant → no model call; the deterministic explanation carries the question and the agent offer", noTenant.via === "deterministic" && /\?$/.test(noTenant.followUpQuestion) && /Dana/.test(noTenant.agentOffer))

  // ── G ─────────────────────────────────────────────────────────────────────
  console.log("\n[G · the expert explanation prompt]")
  const P = conv.EXPLANATION_SYSTEM
  const SECTIONS = [/ROLE:/, /BUSINESS CONTEXT:/, /CREATIVE BRIEF:/, /FACTS YOU MAY RELY ON:/, /YOU MUST NOT:/, /THE DECISION YOU OWN:/, /COMPLIANCE BOUNDARY:/, /OUTPUT CONTRACT:/, /ESCALATION:/]
  const structured = (p: string) => SECTIONS.every((re) => re.test(p)) && p.length > 2000
  check("the prompt is the wave-148 expert standard (9 sections, the brand, the agent, the person served)", structured(P) && /brand/.test(P) && /agent/.test(P) && /first real impression/.test(P), `${P.length} chars`)
  check("the prompt names every evidence source and its honesty rule (RentCast ≠ verified listing; Mapbox with its assumption; OSM straight-line)", ["agent_remarks", "provider:rentcast", "provider:mapbox", "provider:osm"].every((s) => P.includes(s)) && /NOT a verified active listing/.test(P) && /traffic assumption/.test(P) && /straight-line/.test(P))
  check("the output contract demands ONE follow-up question and ONE gentle agent offer", /follow_up_question/.test(P) && /agent_offer/.test(P) && /never a push/.test(P))
  check("the prompt forbids invented places, demographics and promises", /invent/.test(P) && /amenity name/.test(P) && /demographics/.test(P) && /Never promise/.test(P))
  check("POSITIVE CONTROL: a one-line prompt fails the structure check", !structured("You explain why a home matches a buyer."))

  // ── H ─────────────────────────────────────────────────────────────────────
  console.log("\n[H · the buyer's words — recorded whole, consent never fabricated, corrections keep history]")
  const xdb = memSupabase(
    { contacts: [{ id: CONTACT, brokerage_id: BRK, contact_type: "buyer" }], property_preferences: [], buyer_criteria_changes: [], buyer_criteria_utterances: [], agent_action_ledger: [] },
    { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } },
  )
  const { recordStatedCriteriaTurn, persistCriteriaChanges } = await import("../lib/buyer-search/criteria-turn")
  const { loadBuyerCriteria, loadBuyerUtterances, CONSENT_BASES, UTTERANCE_SOURCE_KINDS } = await import("../lib/buyer-search/buyer-criteria")
  const transcript = "AI: Thanks for calling, what are you looking for?\nCaller: 4 bedrooms under 900k in Frisco, and I'd love 2 acres.\nAgent: Got it.\nCaller: The commute to Plano Medical Center should be under 30 minutes."
  const { buyerUtterances } = await import("../lib/buyer-search/conversation-criteria")
  const spoken = buyerUtterances(transcript).join(". ")
  const { parseNaturalLanguageQuery } = await import("../lib/buyer-search/intent-parser")
  const { extractCriteriaFromTranscript } = await import("../lib/buyer-search/conversation-criteria")
  check("PARSER DEFECT FIXED: 'under 30 minutes' is a commute limit, not a price — it no longer overwrites the stated 'under 900k'", extractCriteriaFromTranscript(spoken).criteria.maxPrice === 900000 && parseNaturalLanguageQuery("commute under 30 minutes").maxPrice == null && parseNaturalLanguageQuery("under 2 acres").maxPrice == null, JSON.stringify(extractCriteriaFromTranscript(spoken).criteria))
  check("POSITIVE CONTROL: real budgets still parse ('under 600k.', 'under $1.5m', 'under 450')", parseNaturalLanguageQuery("3 bed under 600k.").maxPrice === 600000 && parseNaturalLanguageQuery("homes under $1.5m").maxPrice === 1500000 && parseNaturalLanguageQuery("3 bed under 450 in Austin").maxPrice === 450000)
  const call1 = await recordStatedCriteriaTurn(xdb as never, { brokerageId: BRK, contactId: CONTACT, text: spoken, channel: "voice", actor: { type: "system" }, idempotencyKey: "buyer_search.criteria.update:c:call:VC-9", allowModelAssist: false, ledgerClient: xdb, source: { kind: "call_transcript", ref: "VC-9" }, consent: { basis: "call_recording_disclosure", ref: "VC-9" } })
  const U = xdb.tables.buyer_criteria_utterances
  check("a CALL TRANSCRIPT is recorded whole: buyer lines only (never the AI's or agent's), source call_transcript/VC-9", U.length === 1 && U[0].source_kind === "call_transcript" && U[0].source_ref === "VC-9" && !/Thanks for calling|Got it/.test(U[0].literal_text) && /2 acres/.test(U[0].literal_text))
  check("…with the structured interpretation (criteria + acreage + commute ask) and its confidence", U[0].interpretation?.criteria?.maxPrice === 900000 && (U[0].interpretation?.lifestyle ?? []).some((l: any) => l.label === "acreage" && l.minAcres === 2) && (U[0].interpretation?.lifestyle ?? []).some((l: any) => l.kind === "commute" && l.target === "Plano Medical Center") && U[0].confidence === "high")
  check("…and the consent basis the door STATED (call_recording_disclosure)", U[0].consent_basis === "call_recording_disclosure" && U[0].consent_ref === "VC-9")
  const changeRows = xdb.tables.buyer_criteria_changes
  check("every change the call produced links back to the utterance (evidence.utterance_id)", call1.changes.length >= 3 && changeRows.length === call1.changes.length && changeRows.every((r: any) => r.evidence?.utterance_id === U[0].id) && call1.utteranceId === U[0].id)
  await recordStatedCriteriaTurn(xdb as never, { brokerageId: BRK, contactId: CONTACT, text: spoken, channel: "voice", actor: { type: "system" }, idempotencyKey: "buyer_search.criteria.update:c:call:VC-9", allowModelAssist: false, ledgerClient: xdb, source: { kind: "call_transcript", ref: "VC-9" }, consent: { basis: "call_recording_disclosure", ref: "VC-9" } })
  check("a re-analysed call is IDEMPOTENT: still one utterance row for VC-9", xdb.tables.buyer_criteria_utterances.filter((r: any) => r.source_ref === "VC-9").length === 1)
  const call2 = await recordStatedCriteriaTurn(xdb as never, { brokerageId: BRK, contactId: CONTACT, text: "Actually somewhere quiet, not close to neighbors.", channel: "voice", actor: { type: "system" }, idempotencyKey: "buyer_search.criteria.update:c:call:VC-10", allowModelAssist: false, ledgerClient: xdb, source: { kind: "call_transcript", ref: "VC-10" } })
  const u10 = xdb.tables.buyer_criteria_utterances.find((r: any) => r.source_ref === "VC-10")
  check("CONSENT NEVER FABRICATED: a call with no stated disclosure is recorded consent_basis NULL, and the note says so", !!u10 && u10.consent_basis === null && call2.notes.some((n) => /No consent basis was stated/.test(n)))
  const portal = await recordStatedCriteriaTurn(xdb as never, { brokerageId: BRK, contactId: CONTACT, text: "walkable to parks", channel: "portal", actor: { type: "user", userId: "44444444-4444-4444-8444-444444444444" }, idempotencyKey: "k-portal-148e", allowModelAssist: false, ledgerClient: xdb })
  const up = xdb.tables.buyer_criteria_utterances.find((r: any) => r.source_ref === "k-portal-148e")
  check("a portal turn by the signed-in buyer carries the channel's FACTUAL basis (self_service_portal)", !!up && up.consent_basis === "self_service_portal" && up.source_kind === "portal_turn" && portal.utteranceId === up.id)
  const nBefore = xdb.tables.buyer_criteria_utterances.length
  const thanks = await recordStatedCriteriaTurn(xdb as never, { brokerageId: BRK, contactId: CONTACT, text: "ok thanks!", channel: "sms", actor: { type: "system" }, idempotencyKey: "k-sms-thanks", allowModelAssist: false, ledgerClient: xdb })
  check("a message that states nothing searchable records nothing (no utterance, no change)", xdb.tables.buyer_criteria_utterances.length === nBefore && thanks.utteranceId === null && thanks.changes.length === 0)
  const curBefore = await loadBuyerCriteria(xdb as never, CONTACT, { brokerageId: BRK })
  const confirm = await recordStatedCriteriaTurn(xdb as never, { brokerageId: BRK, contactId: CONTACT, text: "Still 4 bedrooms.", channel: "email", actor: { type: "system" }, idempotencyKey: "k-email-confirm", allowModelAssist: false, ledgerClient: xdb })
  check("a CONFIRMATION (same value restated) is still the buyer's words: recorded with basis inbound_message, zero change rows", confirm.changes.length === 0 && !!confirm.utteranceId && xdb.tables.buyer_criteria_utterances.find((r: any) => r.source_ref === "k-email-confirm")?.consent_basis === "inbound_message" && curBefore?.minBeds === 4)
  const { applyCorrection } = conv
  const corrected = applyCorrection(curBefore, "maxPrice", 850000, "2026-11-01T01:00:00Z", "portal")
  await persistCriteriaChanges(xdb as never, { brokerageId: BRK, contactId: CONTACT, next: corrected.next, drafts: [corrected.change!], actor: { type: "user", userId: null }, idempotencyKey: "k-correct-1", trigger: "corrected", channel: "portal", reasonDetail: "buyer edited max price", ledgerClient: xdb })
  check("CORRECTIONS KEEP HISTORY: the edit is a new 'corrected' change row; the heard words stay exactly as heard", xdb.tables.buyer_criteria_changes.some((r: any) => r.trigger === "corrected" && r.proposed_value === 850000) && U[0].interpretation?.criteria?.maxPrice === 900000)
  const heard = await loadBuyerUtterances(xdb as never, { brokerageId: BRK, contactId: CONTACT })
  check("the 'what you told us' reader returns the words with their interpretation, tenant-bound", heard.rows.length >= 4 && heard.rows.every((r) => !!r.literal) && heard.note === null)
  const noTable = memSupabase({ contacts: [{ id: CONTACT, brokerage_id: BRK, contact_type: "buyer" }], property_preferences: [], buyer_criteria_changes: [], agent_action_ledger: [] }, { uuidIds: true, stampCreatedAt: true, missingTables: ["buyer_criteria_utterances"], unique: { agent_action_ledger: [["idempotency_key"]] } })
  const degraded = await recordStatedCriteriaTurn(noTable as never, { brokerageId: BRK, contactId: CONTACT, text: "3 bed under 600k in Frisco", channel: "portal", actor: { type: "user", userId: null }, idempotencyKey: "k-nom916", allowModelAssist: false, ledgerClient: noTable })
  check("m916 NOT APPLIED: degrades BY NAME — the criteria changes are still saved, and the note says the words wait for m916", degraded.changes.length >= 3 && noTable.tables.buyer_criteria_changes.length >= 3 && degraded.notes.some((n) => /m916/.test(n)) && degraded.utteranceId === null)
  const mig = readFileSync(join(root, "supabase/migrations/m916-buyer-criteria-utterances.sql"), "utf8")
  const line1 = mig.split("\n")[0]
  check("m916 line 1 is the lane stamp OR the APPLIED stamp (the rule, not the waypoint)", line1 === "-- WRITTEN, NOT APPLIED (wave 148, lane 148E) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor" || line1.startsWith("-- ── APPLIED LIVE "))
  const listIn = (constraint: string) => { const m = new RegExp(`${constraint}[\\s\\S]*?IN \\(([^)]*)\\)`).exec(stripComments(mig)); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [] }
  check("the code vocabularies EQUAL the m916 CHECK lists (source_kind, consent_basis) — derived, not pinned", JSON.stringify(listIn("buyer_criteria_utterances_source_kind_check")) === JSON.stringify([...UTTERANCE_SOURCE_KINDS]) && JSON.stringify(listIn("buyer_criteria_utterances_consent_basis_check")) === JSON.stringify([...CONSENT_BASES]))
  check("m916: idempotent on the source (UNIQUE contact_id, source_kind, source_ref), consent nullable with NO default, RLS tenant read, writes revoked", /UNIQUE \(contact_id, source_kind, source_ref\)/.test(mig) && /consent_basis\s+text\s+NULL/.test(mig) && !/consent_basis[^\n]*DEFAULT/.test(mig) && /ENABLE ROW LEVEL SECURITY/.test(mig) && /REVOKE INSERT, UPDATE, DELETE/.test(mig))

  // ── I ─────────────────────────────────────────────────────────────────────
  console.log("\n[I · wiring — in-house is this tenant's own; RentCast facts carried; maps only from evidence]")
  const eng = code("lib/buyer-search/search-engine.ts")
  const inHouse = /\.from\('listings'\)[\s\S]{0,400}\.eq\('brokerage_id',\s*contact\.brokerage_id[\s\S]{0,40}\)\s*\.in\('status',\s*buyerShoppableListingStatuses\(\)\)/
  check("in-house listings are bounded to the CONTACT's tenant (never another brokerage's inventory as 'ours')", inHouse.test(eng))
  check("POSITIVE CONTROL: the in-house finder rejects the old platform-wide read", !inHouse.test(".from('listings').select('id').in('status', buyerShoppableListingStatuses()).is('deleted_at', null)"))
  check("no tenant → no in-house read (fail closed, the outside sources still answer)", /contact\.brokerage_id\s*\?\s*await q\.order/.test(eng))
  const act = code("app/actions/buyer-search/conversational-search.ts")
  check("'why this home?' reads only the gate tenant's listing, gathers evidence, and returns claims + question + offer", /\.eq\("id", input\.listingId\)\.eq\("brokerage_id", g\.brokerageId\)/.test(act) && /gatherHomeLocationEvidence\(/.test(act) && /claimsFromFit\(/.test(act) && /followUpQuestion: told\.followUpQuestion/.test(act))
  check("every search result carries its source label, its C18 claims (validated), the question and the agent offer", /source_label: sourceLabel/.test(eng) && /claims,/.test(eng) && /validateClaims\(claims\)/.test(eng) && /agent_offer: voice\.agentOffer/.test(eng))
  check("a RentCast row's facts are labelled provider:rentcast and its lot size / coordinates are carried", /facts_source: e\.source === 'rentcast' \? 'provider:rentcast' : 'listing'/.test(eng) && /lot_size_sqft: e\.lotSizeSqft/.test(eng) && /latitude: l\.latitude \?\? null/.test(code("lib/property/external-listings-search.ts")))
  const le = code("lib/buyer-search/location-evidence.ts")
  const page = le.slice(le.indexOf("export async function gatherPageTravelEvidence"))
  check("a search PAGE never geocodes a home over the network (cache or the row's own coordinates only) and asks ONE Matrix request", /homePoint\(h, deps, false\)/.test(page) && (page.match(/requestTravelTimes\(/g) ?? []).length === 1 && !/requestTravelRoute\(/.test(page))
  const portalUi = code("app/portal/[contactId]/search/PortalNlSearch.tsx")
  check("the portal labels every home by its source and renders a map ONLY from a claim's evidence", /describeListingSource\(m\.source\)\.label/.test(portalUi) && /x\.claims\.map\(\(c\) => c\.map\)/.test(portalUi) && !/getMapImageUrl|api\.mapbox|maps\.googleapis/.test(portalUi))
  const fhFiles = ["lib/buyer-search/explanation-evidence.ts", "lib/buyer-search/location-evidence.ts"]
  check("the evidence modules carry no protected-class evidence kind (no crime / demographics / school-quality source in code)", fhFiles.every((f) => !/\b(crime|demographic\w*|school_rating|greatschools)\b/i.test(code(f))))

  console.log(`\n RESULT: ${pass} passed, ${fail} failed${fail ? ` — ${failures.join(" | ")}` : ""}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
