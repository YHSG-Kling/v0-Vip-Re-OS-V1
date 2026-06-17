/**
 * lib/branding/resolve-brand-context.ts
 *
 * Wave 36 — TIER-AWARE brand resolution. The platform's subscription
 * tiers are solo_agent / team / brokerage, and an agent can sit
 * directly under a brokerage (no team) OR under a team that sits
 * under a brokerage. The previous resolver (lib/branding/resolve-
 * brokerage-brand.ts) only read from brokerages.* — wrong for any
 * agent on a team, because the team's logo/colors are what the team's
 * contacts recognize.
 *
 * Cascade rules (per-attribute, not per-row):
 *
 *   logoUrl          team.logo_url           > brokerages.logo_url
 *   primaryColor     teams.primary_color     > brokerages.primary_color  > default
 *   accentColor      teams.accent_color      > brokerage_brand_settings.accent_color > default
 *   brokerageName    brokerages.name (always — the brokerage of record)
 *   teamName         teams.name (when teamId is set)
 *   displayName      The name to render PROMINENTLY on the piece:
 *                    team name when teamId is set; else brokerage name.
 *                    Agents don't get their own "brokerage" — they get
 *                    a signature line on the back/footer instead.
 *   websiteWordmark  teams.website           > brokerage_brand_settings.website_url > brokerages.website
 *   phone            agents.phone_office     > teams.phone               > brokerages.phone
 *   licenseLine      AGENT's license is what's required on direct mail
 *                    (per state real-estate commissioner rules — the
 *                    agent is the licensee responsible for the piece).
 *                    Falls back to brokerage's license only when the
 *                    sender is brokerage-anonymous (e.g. broker-wide
 *                    farm mail without an agent attribution).
 *   tagline          teams.tagline > brokerage_brand_settings.tagline (when present)
 *
 * Fair Housing disclosure uses the resolved brokerageName so the
 * tenant of record carries the legal commitment regardless of which
 * team logo appears on top.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface BrandContext {
  /** Always the tenant of record — the brokerage that signs Fair
   *  Housing + license law. NEVER null. */
  brokerageId:   string
  brokerageName: string
  /** Team that appears on the piece, when the sender is on a team.
   *  null when the sender is brokerage-direct. */
  teamId?:       string | null
  teamName?:     string | null
  /** Agent identity for the per-piece signature/license line. */
  agentUserId?:  string | null
  agentName?:    string | null
  agentTitle?:   string | null

  /** The name to render PROMINENTLY on the piece. Team > brokerage. */
  displayName:   string

  /** Public-facing attributes (stripped + formatted, ready to drop
   *  into a printed footer). */
  display: {
    websiteWordmark: string | null
    phone:           string | null
    licenseLine:     string | null   // e.g. "CA License # 02345678"
    tagline:         string | null
  }
  /** Visual brand inputs. */
  visual: {
    primaryColor: string
    accentColor:  string
    logoUrl:      string | null
  }
  /** Equal Housing Opportunity — short form for postcards/business
   *  cards, long form for letters. */
  fairHousing: {
    shortDisclosure: string
    longDisclosure:  string
  }
  /** Audit trail — which tier supplied which field. Useful for the
   *  admin "why does this piece look like this?" diagnostic. */
  source: {
    logo:    "agent" | "team" | "brokerage" | "default"
    color:   "team" | "brokerage" | "default"
    license: "agent" | "brokerage" | "none"
  }
}

const DEFAULT_PRIMARY_COLOR = "#0F172A"
const DEFAULT_ACCENT_COLOR  = "#F59E0B"

function stripScheme(url: string | null | undefined): string | null {
  if (!url) return null
  return url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "") || null
}

export interface ResolveBrandArgs {
  brokerageId: string
  /** Set when the piece is being sent by an agent on a team. The
   *  team's logo + colors override the brokerage's. */
  teamId?:     string | null
  /** Set when an agent is signing the piece. Pulls license + photo +
   *  personal phone for the signature/footer. */
  agentUserId?: string | null
}

export async function resolveBrandContext(args: ResolveBrandArgs): Promise<BrandContext> {
  const svc = createServiceClient()

  // Parallel-fetch everything the cascade might need. Each query is
  // independently optional — a missing team row falls through to the
  // brokerage row, etc.
  const [brokerageR, brandSettingsR, teamR, agentR] = await Promise.all([
    svc.from("brokerages")
      .select("name, logo_url, primary_color, website, phone, license_number, license_state")
      .eq("id", args.brokerageId)
      .maybeSingle(),
    svc.from("brokerage_brand_settings")
      .select("accent_color, tagline, website_url")
      .eq("brokerage_id", args.brokerageId)
      .maybeSingle(),
    args.teamId
      ? svc.from("teams")
          .select("name, logo_url, primary_color, accent_color, website, phone, tagline")
          .eq("id", args.teamId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    args.agentUserId
      ? svc.from("agents")
          .select("phone_office, phone_mobile, photo_url, license_number, license_state, users(first_name, last_name)")
          .eq("user_id", args.agentUserId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
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
  const team = (teamR.data ?? null) as {
    name?: string | null
    logo_url?: string | null
    primary_color?: string | null
    accent_color?: string | null
    website?: string | null
    phone?: string | null
    tagline?: string | null
  } | null
  const agent = (agentR.data ?? null) as {
    users?: { first_name?: string | null; last_name?: string | null } | null
    phone_office?: string | null
    phone_mobile?: string | null
    photo_url?: string | null
    license_number?: string | null
    license_state?: string | null
  } | null

  const brokerageName = (b.name ?? "").trim() || `Brokerage ${args.brokerageId.slice(0, 8)}`
  const teamName      = team?.name?.trim() || null
  const agentName     = agent?.users ? [agent.users.first_name, agent.users.last_name].filter(Boolean).join(" ") || null : null

  // ── Cascade resolution per field ────────────────────────────────────────
  const logoUrl   = team?.logo_url?.trim() || b.logo_url?.trim() || null
  const logoSrc   = (team?.logo_url ? "team" : (b.logo_url ? "brokerage" : "default")) as BrandContext["source"]["logo"]

  const primaryColor = team?.primary_color?.trim() || b.primary_color?.trim() || DEFAULT_PRIMARY_COLOR
  const accentColor  = team?.accent_color?.trim()  || bs.accent_color?.trim()  || DEFAULT_ACCENT_COLOR
  const colorSrc     = (team?.primary_color ? "team" : (b.primary_color ? "brokerage" : "default")) as BrandContext["source"]["color"]

  const websiteWordmark = stripScheme(team?.website ?? bs.website_url ?? b.website ?? null)
  const phone           = (agent?.phone_office ?? team?.phone ?? b.phone ?? "").trim() || null
  const tagline         = (team?.tagline ?? bs.tagline ?? null) || null

  // License: AGENT's license is what state law requires on direct
  // mail (the agent is the responsible licensee). Falls back to the
  // brokerage's license only when no agent is attached (broker-wide
  // farm mail, e.g.).
  let licenseLine: string | null = null
  let licenseSrc: BrandContext["source"]["license"] = "none"
  if (agent?.license_number && agent?.license_state) {
    licenseLine = `${agent.license_state.toUpperCase()} License # ${agent.license_number}`
    licenseSrc  = "agent"
  } else if (b.license_number && b.license_state) {
    licenseLine = `${b.license_state.toUpperCase()} License # ${b.license_number}`
    licenseSrc  = "brokerage"
  }

  const displayName = teamName ?? brokerageName

  return {
    brokerageId:   args.brokerageId,
    brokerageName,
    teamId:        args.teamId ?? null,
    teamName,
    agentUserId:   args.agentUserId ?? null,
    agentName,
    agentTitle:    null,  // future: agents.title column or per-piece override
    displayName,
    display: {
      websiteWordmark,
      phone,
      licenseLine,
      tagline,
    },
    visual: {
      primaryColor,
      accentColor,
      logoUrl,
    },
    fairHousing: {
      shortDisclosure: "Equal Housing Opportunity. All information deemed reliable but not guaranteed.",
      longDisclosure:
        `${brokerageName} is committed to the principles of the Fair Housing Act and the ` +
        "Equal Credit Opportunity Act. We provide equal professional service without regard to race, " +
        "color, religion, sex, handicap, familial status, national origin, sexual orientation, or " +
        "gender identity. All information is deemed reliable but not guaranteed and is provided " +
        "for informational purposes only.",
    },
    source: {
      logo:    logoSrc,
      color:   colorSrc,
      license: licenseSrc,
    },
  }
}
