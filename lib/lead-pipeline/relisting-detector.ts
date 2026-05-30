/**
 * lib/lead-pipeline/relisting-detector.ts
 *
 * Cross-time detection of a textbook motivated-seller signal: a listing that was DE-LISTED
 * (expired / withdrawn / cancelled) and then RE-LISTED. The relist is almost always at a price cut
 * or with a different agent — both lift `motivationScore` materially. Two implementations:
 *
 *   (1) Scan `raw_scraped_leads` history: same property-address signature with an `expired_listing`
 *       behavior followed by a new active-listing scrape within RELIST_WINDOW_DAYS.
 *   (2) Cross-check the RentCast listings index (active) against the most recent
 *       expired/withdrawn rows we hold.
 *
 * On detection, emits a `LISTING_RELISTED` kernel event (see lifecycle_events writer below) so the
 * standard reactor fan-out (notifications + portal + sequence enrollment) handles the downstream
 * UX uniformly. The detector itself never mutates leads — it only inserts the lifecycle event.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

const RELIST_WINDOW_DAYS = 365  // a year — most "pulled and back" cycles fall inside this

export interface RelistMatch {
  propertyAddress: string
  expiredAt:       string
  relistedAt:      string
  daysBetween:     number
  expiredRawId:    string
  relistedRawId:   string
}

export async function detectRelistedListings(opts?: { limit?: number }): Promise<{
  matches: RelistMatch[]
  emitted: number
  error:   string | null
}> {
  const svc = createServiceClient()
  const limit = Math.max(1, Math.min(1000, opts?.limit ?? 200))
  const cutoff = new Date(Date.now() - RELIST_WINDOW_DAYS * 86400_000).toISOString()

  // Pull recent ACTIVE-listing raw records and recent EXPIRED-listing raw records, join in code on
  // normalized property-address. Doing this in SQL via a JSONB inner-join is awkward across the
  // shape variants the different scrapers produce; the in-code join is bounded by the per-pass cap.
  const { data: active, error: aErr } = await svc
    .from("raw_scraped_leads")
    .select("id, raw_data, processed_at, created_at")
    .or("source.ilike.%active%,source.ilike.%new_listing%,source.like.batchdata%")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(limit)
  if (aErr) return { matches: [], emitted: 0, error: aErr.message }

  const { data: expired } = await svc
    .from("raw_scraped_leads")
    .select("id, raw_data, processed_at, created_at")
    .or("source.ilike.%expired%,source.ilike.%withdrawn%,source.ilike.%cancelled%")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (!active || active.length === 0 || !expired || expired.length === 0) {
    return { matches: [], emitted: 0, error: null }
  }

  // Normalize address: lower + strip punctuation + collapse whitespace.
  const norm = (s: unknown): string =>
    typeof s !== "string" ? "" : s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
  const addrOf = (rd: any): string =>
    norm(rd?.propertyAddress ?? rd?.property_address ?? rd?.address ?? rd?.normalized_preview?.propertyAddress)

  const expiredByAddr = new Map<string, typeof expired[number]>()
  for (const e of expired) {
    const k = addrOf(e.raw_data)
    if (k && !expiredByAddr.has(k)) expiredByAddr.set(k, e)  // newest expired wins
  }

  const matches: RelistMatch[] = []
  for (const a of active) {
    const k = addrOf(a.raw_data)
    if (!k) continue
    const e = expiredByAddr.get(k)
    if (!e) continue
    const expiredAt  = (e.processed_at ?? e.created_at) as string
    const relistedAt = (a.processed_at ?? a.created_at) as string
    if (new Date(relistedAt) <= new Date(expiredAt)) continue  // active scrape is older than the expiry → not a relist
    const daysBetween = Math.round((new Date(relistedAt).getTime() - new Date(expiredAt).getTime()) / 86400_000)
    matches.push({ propertyAddress: k, expiredAt, relistedAt, daysBetween, expiredRawId: e.id as string, relistedRawId: a.id as string })
  }

  // Emit one LISTING_RELISTED lifecycle_event per match — downstream reactor handles fan-out.
  let emitted = 0
  for (const m of matches) {
    await svc.from("lifecycle_events").insert({
      brokerage_id: null,  // platform-level signal; reactor resolves brokerage from the linked raw
      entity_type:  "raw_scraped_leads",
      entity_id:    m.relistedRawId,
      event_type:   "listing_relisted",
      metadata: {
        property_address: m.propertyAddress,
        expired_at:       m.expiredAt,
        relisted_at:      m.relistedAt,
        days_between:     m.daysBetween,
        expired_raw_id:   m.expiredRawId,
      },
    }).then(() => emitted++, () => null)
  }

  return { matches, emitted, error: null }
}
