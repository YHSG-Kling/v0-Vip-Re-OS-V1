// lib/voice/local-number-search.ts
// ─────────────────────────────────────────────────────────────────────────────
// LOCAL NUMBERS NEAREST THE TENANT (wave 82, lane 82D — owner verbatim: "the
// phone numbers most likely will not be toll free numbers, build non toll free
// provisioning and selection numbers which will most likely be area codes that
// start with their location.").
//
// ALREADY EXISTED — REUSED, never rebuilt:
//   · lib/voice/number-provisioning.ts — THE provisioning core (search →
//     purchase → tenant_phone_numbers → phone_number_events → webhook bind →
//     kickCarrierRegistration: A2P 10DLC for a local number, toll-free
//     verification for an 8xx). This file only decides WHAT to search.
//   · lib/providers/twilio/client.ts — THE Twilio SDK adapter; 82D taught it
//     Twilio's geographic Local search (InRegion / InPostalCode / NearNumber /
//     NearLatLong / Distance) and the TollFree list.
//   · lib/voice/a2p-registration.ts isTollFreeNumber — the ONE toll-free rule.
//   · lib/billing/phone-plan-resolve.ts — the plan allowance (bundle →
//     metered overage → hard cap) stays exactly where it is (provisionNumber).
//
// THE LADDER (Twilio AvailablePhoneNumber Local docs, 2026-09-25): AreaCode is
// exact; NearNumber finds numbers "geographically close … within distance
// miles" (default 25, max 500); InPostalCode / InLocality / InRegion narrow by
// geography. So: the tenant's own area code first (from the office phone the
// brokerage already publishes, or one typed), then nearby by the office number,
// then by lat/long, ZIP, city + state, a wider radius, and the state — and
// toll-free ONLY as the secondary option, never silently. Every candidate says
// which rung found it, so the picker can say "your area code" vs "nearby".
//
// PURE — no imports but the toll-free rule; the proof drives it with stubs.

import { isTollFreeNumber } from "@/lib/voice/a2p-registration"

export const NEAR_DISTANCE_MILES = 25
export const WIDE_DISTANCE_MILES = 75

export type LocalSearchRung =
  | "area_code" | "near_number" | "near_lat_long" | "postal_code" | "locality" | "near_number_wide" | "region" | "toll_free"

export const LOCAL_SEARCH_RUNG_LABELS: Record<LocalSearchRung, string> = {
  area_code: "Your area code",
  near_number: `Nearby (within ${NEAR_DISTANCE_MILES} mi of your office number)`,
  near_lat_long: `Nearby (within ${NEAR_DISTANCE_MILES} mi of your office)`,
  postal_code: "Your ZIP code",
  locality: "Your city",
  near_number_wide: `Wider area (within ${WIDE_DISTANCE_MILES} mi)`,
  region: "Your state",
  toll_free: "Toll-free (secondary option)",
}

export interface TenantLocationAnchor {
  /** An area code the human typed — wins over everything derived. */
  areaCode?: string | null
  /** The office phone on file (brokerages.phone) — its NPA is the local area code. */
  phone?: string | null
  zip?: string | null
  city?: string | null
  state?: string | null
  latitude?: number | null
  longitude?: number | null
}

export interface LocalSearchStep {
  rung: LocalSearchRung
  params: {
    areaCode?: string; inLocality?: string; inRegion?: string; inPostalCode?: string
    nearNumber?: string; nearLatLong?: string; distance?: number
  }
}

export type LocalSearchPlan =
  | { ok: true; areaCode: string | null; steps: LocalSearchStep[]; anchor: string; origin: { latitude: number; longitude: number } | null }
  | { ok: false; reason: string }

/** PURE: the NPA of a NANP number, or null (toll-free / N11 / malformed). */
export function areaCodeFromPhone(phone: string | null | undefined): string | null {
  const d = String(phone ?? "").replace(/\D/g, "")
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d
  if (ten.length !== 10) return null
  const npa = ten.slice(0, 3)
  return isValidLocalAreaCode(npa) && !isTollFreeNumber(ten) ? npa : null
}

/** PURE: a NANP geographic area code — [2-9][0-9][0-9], not an N11 service
 *  code, not a toll-free / premium / personal-communications NPA. */
export function isValidLocalAreaCode(raw: string | null | undefined): boolean {
  const a = String(raw ?? "").replace(/\D/g, "")
  if (!/^[2-9]\d\d$/.test(a)) return false
  if (a[1] === "1" && a[2] === "1") return false // N11
  if (isTollFreeNumber(`${a}5550100`)) return false
  if (["900", "500", "521", "522", "523", "524", "525", "526", "527", "528", "529", "533", "544", "566", "577", "588", "700", "710"].includes(a)) return false
  return true
}

function e164(phone: string | null | undefined): string | null {
  const d = String(phone ?? "").replace(/\D/g, "")
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d
  return ten.length === 10 ? `+1${ten}` : null
}

/**
 * PURE, FAIL-CLOSED: the ordered search ladder for a tenant location. Refuses
 * (with the reason) when there is no location at all — never a random
 * nationwide number.
 */
export function planLocalNumberSearch(anchor: TenantLocationAnchor, opts: { includeTollFree?: boolean } = {}): LocalSearchPlan {
  const typed = String(anchor.areaCode ?? "").replace(/\D/g, "").slice(0, 3)
  if (typed && !isValidLocalAreaCode(typed)) {
    return { ok: false, reason: `"${typed}" is not a local (geographic) area code${isTollFreeNumber(`${typed}5550100`) ? " — it is toll-free; tick the toll-free option instead" : ""}` }
  }
  const areaCode = typed || areaCodeFromPhone(anchor.phone)
  const office = anchor.phone && areaCodeFromPhone(anchor.phone) ? e164(anchor.phone) : null
  const zip = String(anchor.zip ?? "").replace(/\D/g, "").slice(0, 5)
  const state = String(anchor.state ?? "").trim().toUpperCase()
  const region = /^[A-Z]{2}$/.test(state) ? state : null
  const city = String(anchor.city ?? "").trim().slice(0, 80) || null
  const hasLatLong = typeof anchor.latitude === "number" && typeof anchor.longitude === "number" && Number.isFinite(anchor.latitude) && Number.isFinite(anchor.longitude)

  const steps: LocalSearchStep[] = []
  if (areaCode) steps.push({ rung: "area_code", params: { areaCode } })
  if (office) steps.push({ rung: "near_number", params: { nearNumber: office, distance: NEAR_DISTANCE_MILES } })
  if (hasLatLong) steps.push({ rung: "near_lat_long", params: { nearLatLong: `${anchor.latitude},${anchor.longitude}`, distance: NEAR_DISTANCE_MILES } })
  if (zip.length === 5) steps.push({ rung: "postal_code", params: { inPostalCode: zip } })
  if (city && region) steps.push({ rung: "locality", params: { inLocality: city, inRegion: region } })
  if (office) steps.push({ rung: "near_number_wide", params: { nearNumber: office, distance: WIDE_DISTANCE_MILES } })
  if (region) steps.push({ rung: "region", params: { inRegion: region } })
  if (!steps.length) {
    return { ok: false, reason: "no location on file to search near — add the office phone, ZIP, or city + state (brokerage settings or the location), or type an area code" }
  }
  if (opts.includeTollFree) steps.push({ rung: "toll_free", params: {} })
  const anchorLine = [areaCode ? `area code ${areaCode}` : null, city, region, zip.length === 5 ? zip : null].filter(Boolean).join(" · ")
  return { ok: true, areaCode, steps, anchor: anchorLine, origin: hasLatLong ? { latitude: anchor.latitude as number, longitude: anchor.longitude as number } : null }
}

export interface RawCandidate {
  phoneNumber: string
  locality: string | null
  region: string | null
  postalCode?: string | null
  rateCenter?: string | null
  smsCapable?: boolean | null
  voiceCapable?: boolean | null
  /** Wave 83D — Twilio returns the rate center's coordinates on each candidate. */
  latitude?: number | null
  longitude?: number | null
}

/** PURE (wave 83D): great-circle miles between two points (haversine, R = 3958.8 mi).
 *  null when either point is missing or non-finite — never a made-up distance. */
export function distanceMiles(
  a: { latitude?: number | null; longitude?: number | null } | null | undefined,
  b: { latitude?: number | null; longitude?: number | null } | null | undefined,
): number | null {
  const ok = (p: any) => p && typeof p.latitude === "number" && typeof p.longitude === "number" && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
  if (!ok(a) || !ok(b)) return null
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b!.latitude! - a!.latitude!)
  const dLon = rad(b!.longitude! - a!.longitude!)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a!.latitude!)) * Math.cos(rad(b!.latitude!)) * Math.sin(dLon / 2) ** 2
  return Math.round(2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h))) * 10) / 10
}

export interface LocalNumberCandidate extends RawCandidate {
  rung: LocalSearchRung
  rungLabel: string
  /** true when the number's NPA equals the tenant's area code. */
  inAreaCode: boolean
  tollFree: boolean
  /** The carrier registration lane the purchase will kick (kickCarrierRegistration). */
  registrationLane: "10dlc" | "tollfree"
  /** Wave 83D — miles from the geocoded office to the number's rate center;
   *  null when either side has no coordinates (never guessed). */
  distanceMiles: number | null
}

export type LocalSearchResult =
  | { ok: true; candidates: LocalNumberCandidate[]; tried: Array<{ rung: LocalSearchRung; found: number; error?: string }>; anchor: string; areaCode: string | null }
  | { ok: false; reason: string; tried: Array<{ rung: LocalSearchRung; found: number; error?: string }> }

/**
 * Walk the ladder until `limit` distinct candidates are found. `search` is the
 * Twilio adapter call (local or toll-free per rung). A rung that ERRORS is
 * recorded and the walk continues; if every rung errored the result is a
 * refusal naming the errors (never "no numbers" when nobody could look).
 * Toll-free is searched only when it is on the plan AND the local rungs found
 * fewer than `limit` — the secondary option, never the default.
 */
export async function runLocalNumberSearch(
  plan: Extract<LocalSearchPlan, { ok: true }>,
  search: (step: LocalSearchStep, limit: number) => Promise<{ ok: true; rows: RawCandidate[] } | { ok: false; error: string }>,
  opts: { limit?: number } = {},
): Promise<LocalSearchResult> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 30)
  const seen = new Set<string>()
  const out: LocalNumberCandidate[] = []
  const tried: Array<{ rung: LocalSearchRung; found: number; error?: string }> = []
  for (const step of plan.steps) {
    if (out.length >= limit) break
    const r = await search(step, limit - out.length)
    if (!r.ok) { tried.push({ rung: step.rung, found: 0, error: r.error }); continue }
    let found = 0
    // Wave 83D — within a rung, nearest first when the office is geocoded
    // (rung order still wins: "your area code" before "nearby").
    const rows = plan.origin
      ? [...r.rows].sort((x, y) => (distanceMiles(plan.origin, x) ?? Infinity) - (distanceMiles(plan.origin, y) ?? Infinity))
      : r.rows
    for (const row of rows) {
      if (!row?.phoneNumber || seen.has(row.phoneNumber)) continue
      const tollFree = isTollFreeNumber(row.phoneNumber)
      // A local rung never hands back a toll-free number as "local".
      if (tollFree && step.rung !== "toll_free") continue
      seen.add(row.phoneNumber)
      found++
      out.push({
        ...row, rung: step.rung, rungLabel: LOCAL_SEARCH_RUNG_LABELS[step.rung],
        inAreaCode: !!plan.areaCode && areaCodeFromPhone(row.phoneNumber) === plan.areaCode,
        tollFree, registrationLane: tollFree ? "tollfree" : "10dlc",
        distanceMiles: distanceMiles(plan.origin, row),
      })
      if (out.length >= limit) break
    }
    tried.push({ rung: step.rung, found })
  }
  if (!out.length && tried.length && tried.every((t) => t.error)) {
    return { ok: false, reason: `number search failed on every rung: ${tried.map((t) => `${t.rung}: ${t.error}`).join("; ")}`, tried }
  }
  return { ok: true, candidates: out, tried, anchor: plan.anchor, areaCode: plan.areaCode }
}
