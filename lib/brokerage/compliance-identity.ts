import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * THE ONE PLACE THAT RESOLVES "WHO IS ADVERTISING" FROM A SESSION USER.
 *
 * Five call sites each repeated their own version of this select — with
 * different column lists, different aliases, and (in every case) a dropped
 * `error`:
 *
 *   app/actions/blog.ts:221                     brokerages by params.brokerageId
 *   app/actions/generate-marketing-image.ts:115 brokerages + agents by ctx.userId
 *   app/api/cron/poll-did-videos/route.ts:238   brokerages by the video's brokerage
 *   lib/kernel/listings.ts:987                  brokerage via a nested listing embed
 *   lib/marketing/social-media-pairing.ts:196   brokerages by params.brokerageId
 *
 * They all feed the same downstream consumer — the brand attribution the
 * renderers stamp on public marketing (`BrandHints` in lib/ai/image-generation.ts)
 * — plus, now, the disclosure check in
 * lib/application/compliance-monitoring.ts:scanContentComplianceService.
 *
 * This is the survivor they collapse into. It is deliberately NOT narrowed to
 * compliance: it returns the full brand/identity row (logo, colour, address,
 * phone) so an image or video call site can adopt it without a second read.
 *
 * FORMATTING LIVES ELSEWHERE. lib/ai/image-generation.ts:compositeAttributionBand
 * is the canonical formatter for the rendered line
 * ("Brokerage · Lic #X (ST) · Agent #Y", agent licence appended only when it
 * differs from the brokerage's). This module resolves FACTS only and never
 * renders a second, disagreeing attribution string.
 *
 * TWO ID CLASSES. `agents.id` is NOT `users.id`. The acting agent is found by
 * `agents.user_id = <session user id>`; the returned `agentId` is the agents row
 * id and must never be compared against a users.id.
 *
 * EVERY READ DESTRUCTURES `error`. supabase-js RESOLVES a failed query, so a
 * permission denial arrives as `data: null` and is indistinguishable from
 * "nothing recorded" unless the error is checked. Those two cases mean opposite
 * things to a compliance caller — "we could not look" vs "they have not set it"
 * — so failed reads are reported separately in `unreadable`, never folded into
 * the nulls.
 */

export type BrokerageComplianceIdentity = {
  /** The tenant this identity belongs to. Null when it could not be resolved. */
  brokerageId: string | null

  /** brokerages.name — NOT NULL in the schema, but may still be blank/whitespace. */
  brokerageName: string | null
  /** brokerages.dba — the trade name. A brokerage advertising under its DBA is identified. */
  brokerageDba: string | null
  brokerageLicense: string | null
  brokerageLicenseState: string | null

  /** Brand fields the marketing/video call sites need, so they need no second read. */
  brokerageLogoUrl: string | null
  brokeragePrimaryColor: string | null
  /**
   * SUPERSEDED BY m456. This comment used to read: "`brokerages` carries
   * city/state, NOT a street `address` column — verified against the live
   * schema." That was true when written and is FALSE now — m456 added
   * `address`, `address_line2` and `zip` after the owner ruled the brokerage
   * needs a complete address including the street.
   *
   * Left as a correction rather than deleted, because the original note is why
   * `lib/kernel/listings.ts` selecting `brokerages.address` looked like a bug in
   * the caller when it was really a missing column: the schema moved and the
   * comment did not. A stale "verified" is worse than no comment — it is an
   * assertion of fact with a date nobody can see.
   *
   * This resolver deliberately still selects only city/state: it answers the
   * Fair Housing disclosure question ("does this copy name the brokerage and a
   * licence"), which no street line participates in. The address has its own
   * consumer in the listing-form prefill.
   */
  brokerageCity: string | null
  brokerageState: string | null
  brokeragePhone: string | null

  /** agents.id for the session user (NOT users.id). Null when the user has no agents row. */
  agentId: string | null
  agentLicense: string | null
  agentLicenseState: string | null
  /** agents.team_id — team-branded call sites resolve the team from this. */
  agentTeamId: string | null

  /**
   * Non-empty when a read FAILED rather than returned nothing. Every null above
   * is then "not established", not "not set" — a caller that grades on absence
   * must check this first or it will report an unreadable record as an empty one.
   */
  unreadable: string[]
}

const EMPTY_IDENTITY: BrokerageComplianceIdentity = {
  brokerageId: null,
  brokerageName: null,
  brokerageDba: null,
  brokerageLicense: null,
  brokerageLicenseState: null,
  brokerageLogoUrl: null,
  brokeragePrimaryColor: null,
  brokerageCity: null,
  brokerageState: null,
  brokeragePhone: null,
  agentId: null,
  agentLicense: null,
  agentLicenseState: null,
  agentTeamId: null,
  unreadable: [],
}

/** Blank and whitespace-only are "not set", not a value. brokerages.name is NOT NULL. */
const trimOrNull = (v: unknown): string | null => {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/**
 * Resolve the brokerage's advertising identity and the acting agent's licence.
 *
 * @param client  Injected Supabase client. Pass the request-scoped user client
 *                from a server action (RLS applies), or a service client from a
 *                cron/webhook that has no session.
 * @param userId  The SESSION user's id (users.id / auth uid). Never a
 *                caller-supplied id — resolve it from the session and pass it
 *                here. Null is accepted (a cron has no user) and yields a
 *                brokerage-only identity when `options.brokerageId` is given.
 * @param options.brokerageId  Explicit tenant override for call sites that
 *                already know the brokerage (blog posts, scheduled videos,
 *                social pairing). When omitted the brokerage is derived from the
 *                user's agents row, falling back to users.brokerage_id.
 */
export async function resolveBrokerageComplianceIdentity(
  client: SupabaseClient,
  userId: string | null,
  options?: { brokerageId?: string | null },
): Promise<BrokerageComplianceIdentity> {
  const identity: BrokerageComplianceIdentity = { ...EMPTY_IDENTITY, unreadable: [] }

  let brokerageId: string | null = trimOrNull(options?.brokerageId) ?? null

  if (userId) {
    // agents.user_id → the agents row. This is the ONLY correct join: agents.id
    // is a different id class from users.id and matching on it silently returns
    // nothing (or, worse, someone else's row).
    const { data: agentRow, error: agentError } = await client
      .from("agents")
      .select("id, brokerage_id, license_number, license_state, team_id")
      .eq("user_id", userId)
      .maybeSingle()

    if (agentError) {
      identity.unreadable.push(`agent profile (${agentError.message})`)
    } else if (agentRow) {
      identity.agentId = (agentRow as { id: string | null }).id ?? null
      identity.agentLicense = trimOrNull((agentRow as { license_number?: unknown }).license_number)
      identity.agentLicenseState = trimOrNull((agentRow as { license_state?: unknown }).license_state)
      identity.agentTeamId = (agentRow as { team_id?: string | null }).team_id ?? null
      brokerageId = brokerageId ?? ((agentRow as { brokerage_id?: string | null }).brokerage_id ?? null)
    }

    // Not every user is an agent — a broker/owner or compliance officer has a
    // users row and a tenant but no agents row. users.brokerage_id is the tenant
    // anchor in that case.
    if (!brokerageId) {
      const { data: userRow, error: userError } = await client
        .from("users")
        .select("brokerage_id")
        .eq("id", userId)
        .maybeSingle()

      if (userError) {
        identity.unreadable.push(`user record (${userError.message})`)
      } else {
        brokerageId = (userRow as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
      }
    }
  }

  identity.brokerageId = brokerageId

  if (brokerageId) {
    const { data: brokerage, error: brokerageError } = await client
      .from("brokerages")
      .select("name, dba, license_number, license_state, logo_url, primary_color, city, state, phone")
      .eq("id", brokerageId)
      .maybeSingle()

    if (brokerageError) {
      identity.unreadable.push(`brokerage record (${brokerageError.message})`)
    } else if (brokerage) {
      const b = brokerage as Record<string, unknown>
      identity.brokerageName = trimOrNull(b.name)
      identity.brokerageDba = trimOrNull(b.dba)
      identity.brokerageLicense = trimOrNull(b.license_number)
      identity.brokerageLicenseState = trimOrNull(b.license_state)
      identity.brokerageLogoUrl = trimOrNull(b.logo_url)
      identity.brokeragePrimaryColor = trimOrNull(b.primary_color)
      identity.brokerageCity = trimOrNull(b.city)
      identity.brokerageState = trimOrNull(b.state)
      identity.brokeragePhone = trimOrNull(b.phone)
    }
  }

  return identity
}
