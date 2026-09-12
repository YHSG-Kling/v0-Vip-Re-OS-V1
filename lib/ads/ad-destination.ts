/**
 * lib/ads/ad-destination.ts
 *
 * WHERE A PAID AD SENDS THE CLICK — the missing half of
 * `ad_creative_variations.destination_url`.
 *
 * WHAT WAS BROKEN. `destination_url` was READ by the launch assembler
 * (lib/ads/launch-assembler.ts:51 → :149) and written by nobody: all three
 * writers of the table — lib/ads/ad-creative-engine.ts:178,
 * lib/ads/listing-ad-producer.ts:165 and lib/ads/ad-creator.ts:332 — omit the
 * column. That is not a cosmetic gap. `validateAdReadiness`
 * (lib/ads/connectors/ad-payload.ts:120 and :134) refuses to build a payload
 * without it for EVERY Google ad and for every Meta objective other than
 * `leads`, and `buildGoogleAdStructure` puts it in `final_urls`. So an entire
 * class of campaign could be drafted, approved by a human, and then never
 * launch — the readiness check reported `missing: ["creative.destinationUrl"]`
 * and there was no code path anywhere that could have supplied it.
 *
 * The destination is not a new fact to invent; it is one this system already
 * holds, in two shapes:
 *
 *   1. A LISTING ad sends the click to that listing's own published landing
 *      page — `/listing/<slug>`, the public route rendered by
 *      app/listing/[slug]/page.tsx from `listing_landing_pages`. That page is
 *      generated for the listing anyway; pointing the ad anywhere else would
 *      spend money driving traffic past it.
 *   2. Any other ad sends the click to the advertiser's own site, resolved on
 *      the SAME ladder the print/brand lane already uses for a wordmark —
 *      teams.website > brokerage_brand_settings.website_url > brokerages.website
 *      (lib/branding/resolve-brand-context.ts:25). One spelling of "this
 *      tenant's website" (CLAUDE.md §6), not a second one invented here.
 *
 * FAILS CLOSED, AND NEVER GUESSES A HOST. When the landing page is not
 * published, or the tenant has recorded no website, or NEXT_PUBLIC_APP_URL is
 * unset, this returns null and the creative is written with a null
 * destination — exactly as it is today. A null keeps `validateAdReadiness`
 * refusing, which is the correct outcome: an ad that cannot say where it sends
 * a click must not reach a provider. What it must never do is interpolate an
 * unset base URL into a live ad's final_urls; the same rule
 * lib/listing-presentation/section-drip.ts:831 states for a portal link.
 */
import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** The configured public origin, or null. Never a placeholder host. */
function publicOrigin(): string | null {
  const raw = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "")
  return /^https?:\/\//.test(raw) ? raw : null
}

/**
 * The published landing page for a listing, as an absolute URL. Null when the
 * listing has no published page or the origin is unset.
 *
 * NOT EXPORTED: the only caller is resolveAdDestination below, which IS the
 * module's door and is what both producers import. An `export` keyword whose
 * only reader is its own file is the finding orphan-export-guard exists to
 * raise, and the honest resolution is to stop claiming a door that nobody
 * knocks on — not to widen the guard's baseline until it stops saying so.
 */
async function listingAdDestination(
  supabase: Svc, listingId: string | null | undefined,
): Promise<string | null> {
  const origin = publicOrigin()
  if (!origin || !listingId) return null
  // `status = 'published'` is the same predicate getLandingPageBySlug uses
  // (app/actions/listing-landing.ts:118). A draft page 404s for the public, so
  // an ad must not be pointed at one.
  //
  // contact_id IS READ HERE, and it changes which page wins. The column is
  // stamped by both writers — the workflow adapter
  // (lib/workflow/adapters/listing-landing-page.ts:49, from the enrolled
  // contact) and generateListingLandingPage (app/actions/ai-listing-intake.ts)
  // — and until now nothing read it, so "the newest published page" could be a
  // page GENERATED FOR ONE NAMED PERSON inside a sequence. Pointing a paid
  // audience at that page spends budget sending strangers to a one-person
  // micro-site. A page with NO contact_id is the general page and is preferred;
  // a contact-scoped page is used only when it is the ONLY published page for
  // the listing, and that substitution is logged rather than made silently.
  const { data, error } = await supabase
    .from("listing_landing_pages")
    .select("slug, contact_id")
    .eq("listing_id", listingId)
    .eq("status", "published")
    .order("updated_at", { ascending: false })
    .limit(20)
  if (error) {
    console.error("[ad-destination] landing-page lookup was refused:", error.message)
    return null
  }
  const pages = (data ?? []) as Array<{ slug: string | null; contact_id: string | null }>
  const general = pages.find((p) => p.slug && !p.contact_id)
  const chosen = general ?? pages.find((p) => p.slug) ?? null
  if (!general && chosen) {
    console.warn(
      `[ad-destination] listing ${listingId} has no general published landing page — ` +
      `falling back to one generated for a single contact (${chosen.slug}).`,
    )
  }
  return chosen?.slug ? `${origin}/listing/${chosen.slug}` : null
}

/**
 * The advertiser's own site for this brokerage/team, on the brand ladder.
 * Null when nothing on the ladder is recorded.
 *
 * NOT EXPORTED — see the note on listingAdDestination above. resolveAdDestination
 * is this module's one door.
 */
async function brandAdDestination(
  supabase: Svc, brokerageId: string, teamId?: string | null,
): Promise<string | null> {
  const normalize = (v: unknown): string | null => {
    const s = String(v ?? "").trim()
    if (!s) return null
    // A tenant may have typed "acme-realty.com" with no scheme; a final_url
    // without one is rejected by Google, so it is completed here rather than
    // shipped broken. Nothing else about the value is assumed.
    return /^https?:\/\//i.test(s) ? s : `https://${s}`
  }

  if (teamId) {
    const { data, error } = await supabase
      .from("teams").select("website").eq("id", teamId).maybeSingle()
    if (error) console.error("[ad-destination] team website read was refused:", error.message)
    const url = normalize((data as { website?: unknown } | null)?.website)
    if (url) return url
  }

  const { data: bs, error: bsError } = await supabase
    .from("brokerage_brand_settings").select("website_url").eq("brokerage_id", brokerageId).maybeSingle()
  if (bsError) console.error("[ad-destination] brand-settings website read was refused:", bsError.message)
  const fromSettings = normalize((bs as { website_url?: unknown } | null)?.website_url)
  if (fromSettings) return fromSettings

  const { data: b, error: bError } = await supabase
    .from("brokerages").select("website").eq("id", brokerageId).maybeSingle()
  if (bError) console.error("[ad-destination] brokerage website read was refused:", bError.message)
  return normalize((b as { website?: unknown } | null)?.website)
}

/**
 * The destination for a creative: the listing's landing page when the campaign
 * is about a listing, else the advertiser's own site. Null when neither is
 * available — see the fail-closed note in this file's header.
 */
export async function resolveAdDestination(
  supabase: Svc,
  params: { brokerageId: string; listingId?: string | null; teamId?: string | null },
): Promise<string | null> {
  const listingUrl = await listingAdDestination(supabase, params.listingId)
  if (listingUrl) return listingUrl
  return brandAdDestination(supabase, params.brokerageId, params.teamId ?? null)
}
