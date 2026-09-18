/**
 * lib/direct-mail/resolve-size-pref.ts
 *
 * Wave 36 item 5 — resolves the postcard size for a given
 * (use_kind × persona) along the agent → team → brokerage tier
 * cascade. Subscriber-controlled; recommendations are baked in as
 * platform defaults that the Settings UI shows as "currently
 * recommended" and lets the admin override per cell.
 *
 * Use kinds:
 *   farm_mail        Weekly farm dispatch. 4×6 by default (cost-
 *                    efficient at scale).
 *   welcome_kit      New-lead postcard + letter combo.
 *   sphere_outreach  Quarterly sphere mail.
 *
 * Lifecycle events have their own size column on lifecycle_promo_
 * policy.mail_postcard_size — read by listing-lifecycle-mail-
 * reactor.ts; that path doesn't go through this resolver.
 *
 * Recommendations (the bias each platform default codifies):
 *   - Luxury persona → 6×9 across all uses (premium service signal)
 *   - First-time + investor + military → 4×6 (cost-conscious cohort)
 *   - Downsize + senior + relocated → 4×6 for farm, 6×9 for sphere
 *     (the sphere mail is the relationship reinforcer)
 *   - Probate + divorce + expired + foreclosure → 4×6 (sensitive
 *     personas; premium feels off-brand)
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import type { Persona } from "@/lib/kernel/types"

export type DirectMailUseKind = "farm_mail" | "welcome_kit" | "sphere_outreach"

export type PostcardSize = "4x6" | "6x9"

// Platform-default recommendations. The Settings UI surfaces these
// next to the per-cell input as "Recommended: <size>".
const PLATFORM_RECOMMENDATIONS: Record<DirectMailUseKind, Partial<Record<Persona, PostcardSize>>> = {
  // `investor` entries added 2026-08-31 when the owner restored the persona
  // ("investor is a persona and not a contact type", m589) — the header's own
  // bias already grouped it with the cost-conscious 4×6 cohort.
  farm_mail: {
    luxury:      "6x9",
    upsize:      "6x9",
    relocated:   "4x6",
    first_time:  "4x6",
    downsize:    "4x6",
    fsbo:        "6x9",
    probate:     "4x6",
    military:    "4x6",
    divorce:     "4x6",
    senior:      "4x6",
    expired:     "4x6",
    foreclosure: "4x6",
    investor:    "4x6",
    other:       "4x6",
  },
  welcome_kit: {
    luxury:      "6x9",
    upsize:      "4x6",
    first_time:  "4x6",
    downsize:    "4x6",
    fsbo:        "6x9",
    investor:    "4x6",
    other:       "4x6",
  },
  sphere_outreach: {
    luxury:      "6x9",
    upsize:      "6x9",
    downsize:    "6x9",
    senior:      "6x9",
    relocated:   "6x9",
    first_time:  "4x6",
    investor:    "4x6",
    other:       "6x9",
  },
}

const FALLBACK_SIZE: PostcardSize = "4x6"

export interface SizePrefArgs {
  brokerageId:  string
  teamId?:      string | null
  agentUserId?: string | null
  useKind:      DirectMailUseKind
  persona:      Persona
}

export interface SizePrefResult {
  size:   PostcardSize
  source: "agent" | "team" | "brokerage" | "platform_recommendation" | "platform_default"
}

function lookupInPrefs(
  prefs: unknown,
  useKind: DirectMailUseKind,
  persona: Persona,
): PostcardSize | null {
  if (!prefs || typeof prefs !== "object") return null
  const key = `${useKind}:${persona}`
  const value = (prefs as Record<string, unknown>)[key]
  if (value === "4x6" || value === "6x9") return value
  return null
}

export async function resolveDirectMailSize(args: SizePrefArgs): Promise<SizePrefResult> {
  const svc = createServiceClient()

  // Cascade: agent → team → brokerage → platform recommendation → platform fallback.
  // Parallel-fetch the three tiers; missing rows resolve to null prefs.
  const [agentR, teamR, brokerageR] = await Promise.all([
    args.agentUserId
      ? svc.from("agents").select("direct_mail_size_prefs").eq("user_id", args.agentUserId).maybeSingle()
      : Promise.resolve({ data: null }),
    args.teamId
      ? svc.from("teams").select("direct_mail_size_prefs").eq("id", args.teamId).maybeSingle()
      : Promise.resolve({ data: null }),
    svc.from("brokerages").select("direct_mail_size_prefs").eq("id", args.brokerageId).maybeSingle(),
  ])
  const agentPrefs     = (agentR.data as { direct_mail_size_prefs?: unknown } | null)?.direct_mail_size_prefs ?? null
  const teamPrefs      = (teamR.data as { direct_mail_size_prefs?: unknown } | null)?.direct_mail_size_prefs ?? null
  const brokeragePrefs = (brokerageR.data as { direct_mail_size_prefs?: unknown } | null)?.direct_mail_size_prefs ?? null

  const fromAgent = lookupInPrefs(agentPrefs, args.useKind, args.persona)
  if (fromAgent) return { size: fromAgent, source: "agent" }

  const fromTeam = lookupInPrefs(teamPrefs, args.useKind, args.persona)
  if (fromTeam) return { size: fromTeam, source: "team" }

  const fromBrokerage = lookupInPrefs(brokeragePrefs, args.useKind, args.persona)
  if (fromBrokerage) return { size: fromBrokerage, source: "brokerage" }

  const recommended = PLATFORM_RECOMMENDATIONS[args.useKind]?.[args.persona]
  if (recommended) return { size: recommended, source: "platform_recommendation" }

  return { size: FALLBACK_SIZE, source: "platform_default" }
}

/** Synchronous accessor for the recommendation table — the Settings
 *  UI calls this to render the "Recommended:" hint next to each cell
 *  without a DB round-trip. */
export function getPlatformRecommendation(
  useKind: DirectMailUseKind,
  persona: Persona,
): PostcardSize {
  return PLATFORM_RECOMMENDATIONS[useKind]?.[persona] ?? FALLBACK_SIZE
}
