/**
 * lib/branding/resolve-brokerage-brand.ts
 *
 * Wave 36 — single source of truth for the VISUAL brand context every
 * Remotion composition + every Lob mailer needs. Pulls brokerages.* +
 * brokerage_brand_settings.* + the agent's personal touches (photo,
 * personal_website_url) into one struct so a Remotion composition's
 * `brand` prop is filled from one async call.
 *
 * Distinct from lib/agents/brokerage-context.ts which resolves the
 * VOICE brand (tone, prohibited words). Voice + visual are kept
 * separate because Remotion compositions need visual only — pulling
 * the voice rules would be wasted work + a useless prop.
 *
 * Direct-mail-specific responsibilities:
 *   - Returns the canonical Equal Housing Opportunity attribution
 *     ("Equal Housing Opportunity" wordmark + license_state + license_
 *     number) so every printed piece carries the legally-required
 *     Fair Housing disclosure without the composition author having
 *     to remember.
 *   - Sanitizes the website URL to a clean wordmark ("vipre.com"
 *     without scheme) so the printed footer doesn't show "https://".
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface BrokerageBrandContext {
  brokerageId:   string
  brokerageName: string
  /** Public-facing brokerage attributes ready to drop into a printed
   *  piece's footer. Already string-formatted; null when the source
   *  column is empty. */
  display: {
    websiteWordmark: string | null
    phone:           string | null
    licenseLine:     string | null  // e.g. "CA DRE# 02345678"
  }
  visual: {
    primaryColor: string
    accentColor:  string
    logoUrl:      string | null
  }
  /** Equal Housing Opportunity disclosure block — short form for
   *  postcards/business cards, long form for letters. Both required by
   *  HUD when a broker is FHA/HUD-approved (which most brokerages are
   *  for the lending channel) and considered best practice for every
   *  brokerage. The text is identical for all brokerages; we centralize
   *  it so a future copy-tweak only changes here. */
  fairHousing: {
    shortDisclosure: string
    longDisclosure:  string
  }
}

const DEFAULT_PRIMARY_COLOR = "#0F172A"  // slate-900 — matches existing Remotion compositions
const DEFAULT_ACCENT_COLOR  = "#F59E0B"  // amber-500

function stripScheme(url: string | null | undefined): string | null {
  if (!url) return null
  return url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "") || null
}

export async function resolveBrokerageBrandContext(
  brokerageId: string,
): Promise<BrokerageBrandContext> {
  const svc = createServiceClient()

  const [brokerageR, brandSettingsR] = await Promise.all([
    svc.from("brokerages")
      .select("name, logo_url, primary_color, website, phone, license_number, license_state")
      .eq("id", brokerageId)
      .maybeSingle(),
    svc.from("brokerage_brand_settings")
      .select("accent_color, tagline, website_url")
      .eq("brokerage_id", brokerageId)
      .maybeSingle(),
  ])

  const b = (brokerageR.data ?? {}) as {
    name?: string | null
    logo_url?: string | null
    primary_color?: string | null
    website?: string | null
    phone?: string | null
    license_number?: string | null
    license_state?: string | null
  }
  const bs = (brandSettingsR.data ?? {}) as {
    accent_color?: string | null
    tagline?: string | null
    website_url?: string | null
  }

  const brokerageName = (b.name ?? "").trim() || `Brokerage ${brokerageId.slice(0, 8)}`
  const websiteWordmark = stripScheme(bs.website_url ?? b.website ?? null)
  const phone = (b.phone ?? "").trim() || null

  let licenseLine: string | null = null
  if (b.license_number && b.license_state) {
    // States vary: CA uses DRE, TX uses TREC, FL uses RE, NY uses DOS.
    // Use the generic "License #" so the line is correct in every state
    // without needing a per-state lookup table. The line still appears
    // alongside the broker name so it reads naturally.
    licenseLine = `${b.license_state.toUpperCase()} License # ${b.license_number}`
  }

  return {
    brokerageId,
    brokerageName,
    display: {
      websiteWordmark,
      phone,
      licenseLine,
    },
    visual: {
      primaryColor: (b.primary_color ?? "").trim() || DEFAULT_PRIMARY_COLOR,
      accentColor:  (bs.accent_color ?? "").trim() || DEFAULT_ACCENT_COLOR,
      logoUrl:      (b.logo_url ?? "").trim() || null,
    },
    fairHousing: {
      // Postcards and small mailers — single line under the footer.
      shortDisclosure: "Equal Housing Opportunity. All information deemed reliable but not guaranteed.",
      // Letters — full paragraph at the bottom. The bracketed brokerage
      // name is interpolated so the brokerage owns the line, not the
      // platform.
      longDisclosure:
        `${brokerageName} is committed to the principles of the Fair Housing Act and the ` +
        "Equal Credit Opportunity Act. We provide equal professional service without regard to race, " +
        "color, religion, sex, handicap, familial status, national origin, sexual orientation, or " +
        "gender identity. All information is deemed reliable but not guaranteed and is provided " +
        "for informational purposes only.",
    },
  }
}
