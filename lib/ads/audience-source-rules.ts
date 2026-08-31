// lib/ads/audience-source-rules.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHAT AN AD AUDIENCE'S SOURCE RULE ACTUALLY RESOLVES TO — the other missing half.
//
// ── THE DEFECT THIS MODULE EXISTS TO REMOVE ──────────────────────────────────
// `lib/kernel/ads.ts syncAudience` declared FIFTEEN `SourceRule` types and
// narrowed its contacts query for exactly TWO — `contact_list` (by tags) and, once
// the persona lane landed, `persona_segment`. The other THIRTEEN fell through to
// the unnarrowed base query:
//
//     select id, email, phone, first_name, last_name
//       from contacts
//      where brokerage_id = $tenant and email is not null and tcpa_consent = true
//
// …and that result was SHA-256 hashed and uploaded to Meta / Google Customer Match
// on the six-hourly sync cron, under an audience name that promised a narrow
// slice. All eleven shipped FB audience templates were affected.
//
// This ranks above an ordinary wiring bug for four reasons, and they are the
// reasons this module is shaped the way it is:
//   · it is an EGRESS defect — the rows LEAVE, to two ad platforms, and there is
//     no undo. So the resolution must be decided BEFORE the read, not after;
//   · the audience NAME is the lie. An operator who picked "Investors" cannot see
//     that everybody went. So the resolution carries an operator-facing LABEL and
//     is surfaced before a sync leaves (previewAudienceResolution);
//   · TCPA consent was the only filter, and consent to be contacted BY THE
//     BROKERAGE is not consent to be uploaded to Meta. So consent is a floor here,
//     never a definition;
//   · it defeats the fair-housing work BY VOLUME rather than by criteria — no
//     protected-class criterion is used, yet the delivered audience is "everybody",
//     so whatever targeting the platform then applies lands on the whole book.
//
// ── THE ONE LINE THAT MATTERS MOST ───────────────────────────────────────────
// `resolveSourceRuleNarrowing` has NO permissive default. A rule type it does not
// recognise, a rule that is null, a rule whose filters do not pin down what its
// name promises — every one of them REFUSES (CLAUDE.md §4, fail closed). A
// fall-through default that WIDENS is the exact inversion of fail-closed and it is
// what made this defect possible. Deleting that default is the fix; everything
// below is the thirteen honest definitions that make deleting it survivable.
//
// ── PURE ON PURPOSE ──────────────────────────────────────────────────────────
// No DB client, no network, no `server-only`. It emits a DECLARATIVE narrowing
// that two consumers apply: the Supabase query builder in `syncAudience`, and
// `contactMatchesPredicates` below, which is what lets the simulator prove on a
// FIXTURE that each rule EXCLUDES somebody. That second consumer is not a
// convenience — the live database holds four contacts, and a filter that returns
// everyone is indistinguishable from no filter at that size. That is precisely how
// this defect survived.
//
// ── GROUNDED IN THE LIVE SCHEMA, 2026-08-22 (CLAUDE.md §3) ───────────────────
// Every column named below was read off the live database and every one has a
// verified writer. Columns that do NOT exist, or exist with nothing writing them,
// produce a REFUSAL rather than a filter — a filter naming an absent column is
// refused entirely by PostgREST (PGRST204), and a filter on a writerless column
// silently matches everyone or no one, which is the same failure in a new costume.

import { LIFETIME_CONTACT_TYPES } from "@/lib/contact-types"

// ─── THE ROSTER ───────────────────────────────────────────────────────────────

/**
 * THE canonical `SourceRule.type` vocabulary (CLAUDE.md §6 — one vocabulary per
 * function). `lib/kernel/ads.ts` derives its `SourceRule["type"]` union FROM this
 * constant rather than restating it, so a type added there without a narrowing
 * here is a COMPILE error (see `NARROWERS` below), not a silent fall-through to
 * "every consented contact in the tenant".
 */
export const SOURCE_RULE_TYPES = [
  "website_visitors",
  "contact_list",
  "engagement",
  "lifetime_customers",
  "qualified_leads",
  "active_buyers",
  "active_sellers",
  "consultations_completed",
  "open_house_attendees",
  "high_engagement_contacts",
  "investor_contacts",
  "in_pipeline",
  "lookalike_seed",
  "exclusion_active_pipeline",
  "persona_segment",
] as const

export type SourceRuleType = (typeof SOURCE_RULE_TYPES)[number]

export function isSourceRuleType(v: unknown): v is SourceRuleType {
  return typeof v === "string" && (SOURCE_RULE_TYPES as readonly string[]).includes(v)
}

/**
 * THE RULE TYPES THAT DEFINE AN AUDIENCE WHICH **REMOVES** PEOPLE.
 *
 * ── WHY THIS EXISTS (owner ruling, 2026-08-23) ───────────────────────────────
 * The owner ruled that `military`, `senior`, `divorced` and `probate` are valid
 * situation personas for ADS, "because that is how we show them info or ads that
 * is worded to their situation as part of them-first methology." That ruling is
 * about TAILORING — reaching someone and speaking to their situation.
 *
 * The fair-housing exposure in this area (HUD v. Meta) is about EXCLUSION —
 * withholding a housing ad from people because of a protected characteristic.
 * Those are different operations on the same field, and this product already had
 * a first-class name for the second one: an audience whose rule type declares it
 * exists to be SUBTRACTED from a campaign rather than targeted by it.
 *
 * DERIVED BY PREFIX FROM THE ONE ROSTER, never hand-listed (CLAUDE.md §6): a
 * second `exclusion_*` type added above is covered the day it is added, and the
 * failure mode of a hand-list here would be the permissive one. Today the set has
 * exactly one member, `exclusion_active_pipeline`, and the simulator asserts both
 * that it is non-empty (a silently-empty set would make the exclusion refusal
 * unreachable while reading as enforced) and that it equals the prefix scan.
 *
 * ── THE BLIND SPOT THIS ONCE PUBLISHED IS CLOSED (2026-08-23) ───────────────
 * It read: this covers exclusion as DECLARED in the audience's own rule and NOT
 * exclusion as APPLIED on the ad platform, because `TargetingConfig` had
 * `custom_audience_ids` and no excluded-audience field and
 * `facebook_custom_audiences` had no column recording that an audience was used
 * as a suppression list — so an operator who exported a persona audience and
 * pasted it into Meta's "Exclude" box was outside anything this system could see.
 *
 * Owner ruling: "capability is vital to this os to have not exclude." The
 * capability is built, and it is built so the OS can REFUSE:
 *   · `TargetingConfig.excluded_audience_ids` (lib/kernel/ads.ts,
 *     lib/ads/ad-creator-types.ts) — an exclusion an operator intends is now
 *     DECLARED in the product, with a control in the campaign wizard;
 *   · lib/ads/audience-exclusion.ts gates every id in that slot at all four
 *     doors, escalating the persona verdict to `"exclusion"` whatever the
 *     audience's own rule type says — because the PLACEMENT is what makes it
 *     subtract. A protected-characteristic persona audience there is REFUSED;
 *   · migration m538 records `used_as_suppression_at` /
 *     `used_as_suppression_by_campaign_id` on the audience, so the fact outlives
 *     the campaign; the ads dashboard reads it back onto the audience card.
 *
 * WHAT REMAINS, STATED RATHER THAN CLAIMED CLOSED: this product can govern the
 * exclusions that pass through it. An operator with direct access to Meta Ads
 * Manager can still build an audience there, or upload a list by hand, and
 * exclude it — no software in this repo is in that path. What has changed is
 * that the supported way to do it now runs through a gate instead of round the
 * outside of one.
 */
export const EXCLUSION_SOURCE_RULE_TYPES: readonly SourceRuleType[] = Object.freeze(
  SOURCE_RULE_TYPES.filter((t) => t.startsWith("exclusion_")),
)

const EXCLUSION_TYPES = new Set<string>(EXCLUSION_SOURCE_RULE_TYPES)

/**
 * PURE. True when this `SourceRule.type` declares a SUBTRACTIVE audience.
 *
 * MODULE-PRIVATE ON PURPOSE (§6). This is the implementation of `audienceUseOf`
 * below, not a second public way to ask the same question. It was exported once,
 * and the one caller that used it — `protectedClassSegmentationIn` — became the
 * second spelling this module now exists to prevent. Callers outside this file
 * ask `audienceUseOf(rule)`, which takes the RULE rather than a bare type string
 * and so cannot be handed the wrong field.
 */
function isExclusionSourceRuleType(v: unknown): v is SourceRuleType {
  return typeof v === "string" && EXCLUSION_TYPES.has(v)
}

/**
 * WHICH OPERATION an audience performs on the people its rule selects.
 *
 * `"inclusion"` — the audience is TARGETED: these people are reached, and the
 * persona chooses the wording they are reached with. This is what the owner
 * ruled on.
 * `"exclusion"` — the audience is SUBTRACTED: these people are removed from a
 * campaign's delivery. A protected characteristic may not do this.
 */
export type AudienceUse = "inclusion" | "exclusion"

/**
 * PURE. Which operation this audience rule declares.
 *
 * LIVES HERE, NOT IN audience-persona-basis.ts, AND THAT IS THE POINT (§6).
 * Two modules need this answer — the persona gate, which picks the inclusion or
 * the exclusion rule, and `protectedClassSegmentationIn`, which turns its
 * persona carve-out off when the audience subtracts. The persona module cannot
 * be the home: it imports `protectedClassReasonFor` from the compliance module,
 * so the compliance module importing back would be a cycle, and the cycle is
 * exactly why the second spelling appeared there in the first place. Beside the
 * roster, both readers reach one function.
 *
 * DEFAULTS TO `"inclusion"`, and that default is safe in exactly one direction:
 * an unrecognised rule type is refused outright by `resolveSourceRuleNarrowing`
 * before it can populate anything, so "inclusion" here can never widen what an
 * audience delivers — it can only decide which persona rule is applied to a rule
 * that some other gate is already going to refuse.
 */
export function audienceUseOf(rule: unknown): AudienceUse {
  if (!rule || typeof rule !== "object") return "inclusion"
  return isExclusionSourceRuleType((rule as { type?: unknown }).type) ? "exclusion" : "inclusion"
}

// ─── THE DECLARATIVE NARROWING ────────────────────────────────────────────────

/** The comparison operators both consumers implement. Nothing else is emitted. */
export type NarrowOp = "eq" | "in" | "not_in" | "gte" | "lte" | "contains" | "not_null"

export interface NarrowPredicate {
  /** A REAL column on the target table, live-verified. */
  column: string
  op: NarrowOp
  value: unknown
  /** One clause of the operator-facing sentence. Never a bare code. */
  says: string
}

/**
 * An id-set prefetch. Some rules are true of a contact because of a row in
 * ANOTHER table (a qualified lead, an open-house check-in, a live transaction).
 *
 * Deliberately NOT a PostgREST embed. `contacts` joins several of these tables by
 * more than one FK — `transactions` alone reaches a contact through `contact_id`,
 * `buyer_contact_id` AND `seller_contact_id` — and a bare embed across a
 * multi-FK pair is killed outright by PGRST201 (CLAUDE.md §3). So the consumer
 * reads the ids first and applies `.in("id", ids)`.
 *
 * AN EMPTY PREFETCH IS AN EMPTY AUDIENCE, NEVER AN UNFILTERED ONE. That rule is
 * stated here because it is the exact shape of the original defect: "I found no
 * ids, so I will not filter" uploads the whole book.
 */
export interface NarrowJoin {
  /** Live-verified table name. */
  table: string
  /** Columns on `table` that hold a `contacts.id`. Any match counts. */
  contactIdColumns: string[]
  /** Filters applied to `table` before the ids are collected. */
  predicates: NarrowPredicate[]
  says: string
}

export interface SourceRuleNarrowingOk {
  ok: true
  ruleType: SourceRuleType
  /**
   * The sentence an operator reads BEFORE the sync leaves: what this audience
   * actually resolves to. The whole point of the surfacing work — the audience
   * name promised a slice, and until now nothing said what was delivered.
   */
  label: string
  /** Applied directly to the `contacts` query. */
  predicates: NarrowPredicate[]
  /** Applied first, as an id-set prefetch, when present. */
  join: NarrowJoin | null
  /**
   * False for `lookalike_seed` ONLY: that rule uploads no CRM contacts at all —
   * the connector seeds from an already-synced audience's external id. Before
   * this flag existed, a `lookalike_seed` audience whose
   * `lookalike_seed_audience_id` was null missed the lookalike branch entirely and
   * fell into the CUSTOM branch, which uploaded every consented contact.
   */
  uploadsContacts: boolean
  /**
   * True when the persona gate — `assertAudiencePersonaBasis` /
   * `resolveAudiencePersonaBasis`, built by the persona lane — is what narrows
   * this rule. This module does NOT re-implement that gate (CLAUDE.md §6): it
   * defers, and the consumer keeps calling the one gate that already exists.
   */
  narrowedByPersonaGate: boolean
}

export type NarrowRefusalKind =
  /** `source_rule` is absent, null, or not an object. Nothing was declared. */
  | "no_rule"
  /** `type` is missing or is not in `SOURCE_RULE_TYPES`. */
  | "unknown_type"
  /** The type is real but its filters do not pin down what its name promises. */
  | "underspecified"
  /** No column or table in the live schema expresses this rule. */
  | "no_expressing_data"
  /** The audience is built ON the ad platform from its pixel; there is no CRM list. */
  | "platform_native"

export interface SourceRuleNarrowingRefusal {
  ok: false
  ruleType: string
  refusalKind: NarrowRefusalKind
  /** A sentence naming the audience's promise and what is missing to keep it. */
  refusal: string
}

export type SourceRuleNarrowing = SourceRuleNarrowingOk | SourceRuleNarrowingRefusal

// ─── LIVE-VERIFIED VOCABULARIES ───────────────────────────────────────────────
// Each of these is a subset of a LIVE CHECK constraint, read on 2026-08-22 and
// quoted in the comment above it so the next reader can re-verify without a
// round trip. A value not in the CHECK cannot exist in the column, so a filter
// naming one matches nothing forever — the silent-empty failure mode.

/**
 * `contacts_contact_type_check` admits (m539): lead, prospect, client,
 * lifetime_customer, sphere, vendor, referral_partner, investor, buyer, seller,
 * both, other. `lifetime` and `past_client` were retired as duplicate spellings of
 * lifetime_customer — see lib/contact-types.ts.
 */
const BUYER_CONTACT_TYPES = ["buyer", "both"] as const
const SELLER_CONTACT_TYPES = ["seller", "both"] as const
/**
 * REPOINTED (2026-08-31) from contact_type onto contact_persona. Owner ruling,
 * verbatim: "investor is a persona and not a contact type." The rule always
 * MEANT the persona — its template copy read "ROI-focused content, multi-family
 * deals, off-market opportunities", a SITUATION, not a transaction side — and
 * m589 (APPLIED) made 'investor' a storable contacts.contact_persona value.
 * Live rows carrying contact_type='investor' at repoint time: ZERO, so no
 * audience membership changed. m593 (written, not applied) retires 'investor'
 * from contacts_contact_type_check.
 */
const INVESTOR_PERSONA = "investor"

/**
 * `contacts_buyer_stage_check` — the stages that mean a buyer is NO LONGER an
 * active shopper. `BUYER_UNDER_CONTRACT` is in this list because the shipped
 * template's own words are "haven't gone under contract".
 */
const INACTIVE_BUYER_STAGES = [
  "BUYER_UNDER_CONTRACT",
  "BUYER_CLOSED",
  "BUYER_DISENGAGED",
  "BUYER_ON_HOLD",
] as const

/**
 * `listings_status_check` — pre-listing through live-on-market. `pending`,
 * `sold`, `withdrawn`, `cancelled`, `off_market` and `expired` are deliberately
 * absent: a seller whose listing already went pending is not an "active seller",
 * and the audience's name would be false for them.
 */
const ACTIVE_LISTING_STATUSES = ["draft", "listing_signed", "coming_soon", "active"] as const

/**
 * `transactions_status_check` — a deal that is live. `closed`/`funded`/`lost`/
 * `archived` are excluded: a closed deal is a lifetime customer, not a pipeline.
 */
const LIVE_TRANSACTION_STATUSES = [
  "qualifying", "active", "under_contract", "pending", "clear_to_close",
] as const

/** `transactions_status_check` — a deal that COMPLETED. Used for ownership tenure. */
const COMPLETED_TRANSACTION_STATUSES = ["closed", "funded"] as const

/**
 * The `leads.lead_stage` value the AI ISA writes when it qualifies a lead.
 * `leads.lead_stage` is free text with NO CHECK, so this is pinned to its
 * WRITERS rather than to a constraint:
 *   · app/actions/ai-isa/accept-handoff.ts — `.update({ lead_stage: 'qualified' })`
 *   · app/leads/components/GhostRecoveryQueue.tsx — same value on recovery.
 * Both verified 2026-08-22. If those writers change spelling this filter matches
 * nothing — which is the fail-closed direction, and the preview surface reports a
 * zero rather than a silent everybody.
 */
const QUALIFIED_LEAD_STAGE = "qualified"

/**
 * `contacts.status` — free text, default 'new'. `'active'` is written by
 * lib/contact-promotion/contact-creator.ts:300 and by the vendor-access lane.
 * This is the ONE deliberately-wide rule's anchor; see `exclusion_active_pipeline`.
 */
const ACTIVE_CONTACT_STATUS = "active"

// ─── HELPERS ──────────────────────────────────────────────────────────────────

interface RuleShape {
  type?: unknown
  filters?: Record<string, unknown> | null
}

function refuse(
  ruleType: string,
  refusalKind: NarrowRefusalKind,
  refusal: string,
): SourceRuleNarrowingRefusal {
  return { ok: false, ruleType, refusalKind, refusal }
}

/** ISO cutoff for a lookback window, or null when no window was declared. */
function cutoffISO(days: unknown, now: Date): string | null {
  if (days === undefined || days === null) return null
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) return null
  return new Date(now.getTime() - days * 86_400_000).toISOString()
}

/** A declared lookback that is present but nonsensical (0, negative, a string). */
function lookbackIsInvalid(days: unknown): boolean {
  if (days === undefined || days === null) return false
  return typeof days !== "number" || !Number.isFinite(days) || days <= 0
}

function nonEmptyStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
  return out.length === v.length && out.length > 0 ? out : null
}

// ─── THE THIRTEEN DEFINITIONS ─────────────────────────────────────────────────

type Narrower = (filters: Record<string, unknown>, now: Date) => SourceRuleNarrowing

/**
 * One entry per member of `SOURCE_RULE_TYPES`, enforced by the `Record` type. A
 * new rule type added to the roster WITHOUT a definition here does not compile —
 * which is the structural version of "no permissive default".
 */
const NARROWERS: Record<SourceRuleType, Narrower> = {
  // ── PLATFORM-NATIVE (2) — refuse, because there is no CRM list to send ──────
  //
  // These two audience types are built ON Meta/Google from the advertiser's own
  // pixel: the platform already knows who hit the site or engaged with the page,
  // and there is no CRM query that reproduces it. `syncAudience`'s own comment
  // said as much ("platform-native … no CRM upload") — but the code had no branch
  // for it, so both fell into the Customer-Match branch and uploaded the whole
  // consented book under a name promising site visitors.
  //
  // Could they be built from CRM data? Not honestly, today: `site_activity`,
  // `listing_page_analytics` and `calendar_events` are all EMPTY on the live
  // database and none of them carries a `contact_id` this could join on. Refusing
  // is the fail-closed answer, and it is a REFUSAL rather than a silent zero so
  // the operator is told to create the audience on the platform instead.
  website_visitors: () =>
    refuse(
      "website_visitors",
      "platform_native",
      "promises people who visited your website. That audience is built ON the ad platform from its own " +
        "pixel — this product holds no per-contact web-visit record to reproduce it (site_activity and " +
        "listing_page_analytics are empty and carry no contact key). Rather than upload your whole " +
        "consented contact list under that name, this refuses: create a Website Custom Audience in Meta " +
        "or Google Ads directly, then reference it here.",
    ),
  engagement: () =>
    refuse(
      "engagement",
      "platform_native",
      "promises people who engaged with your page, posts or ads. That is the ad platform's own " +
        "engagement signal and this product never receives it per person — social_engagement_tracking is " +
        "page-level, not contact-level. Build an Engagement Custom Audience on the platform; this refuses " +
        "rather than uploading every consented contact under that name.",
    ),

  // ── NO EXPRESSING DATA (1) — refuse, and name what would be needed ──────────
  consultations_completed: () =>
    refuse(
      "consultations_completed",
      "no_expressing_data",
      "promises contacts who attended a consultation. Nothing in the live schema records that: the " +
        "`appointments` table exists but is EMPTY and has no writer anywhere in this codebase (verified " +
        "2026-08-22 — no insert, no update, no read), and `calendar_events` carries no contact key at " +
        "all. A filter on a writerless column matches everyone or no one silently, so this refuses. " +
        "Wire an appointment writer (contact_id + status) and this rule becomes buildable.",
    ),

  // ── THE SEED (1) — real, but it uploads no contacts ─────────────────────────
  //
  // A lookalike is seeded from an already-synced audience's EXTERNAL id; the CRM
  // contact list plays no part. `uploadsContacts: false` is what stops the caller
  // running the contacts query at all. Before it, a `lookalike_seed` rule on an
  // audience with no `lookalike_seed_audience_id` skipped the lookalike branch and
  // landed in the Customer-Match branch — uploading everybody as a "seed".
  lookalike_seed: () => ({
    ok: true,
    ruleType: "lookalike_seed",
    label:
      "seeds a platform lookalike from an already-synced audience. No CRM contacts are uploaded by " +
      "this rule; the seed audience must itself have synced first.",
    predicates: [],
    join: null,
    uploadsContacts: false,
    narrowedByPersonaGate: false,
  }),

  // ── THE PERSONA BASIS (1) — narrowed by the gate the persona lane built ─────
  persona_segment: () => ({
    ok: true,
    ruleType: "persona_segment",
    label:
      "contacts whose declared persona is one of the audience's ads-eligible personas " +
      "(narrowed by the persona basis gate, lib/ads/audience-persona-basis.ts).",
    predicates: [],
    join: null,
    uploadsContacts: true,
    // DEFERRED, NOT DUPLICATED (CLAUDE.md §6). `resolveAudiencePersonaBasis` +
    // `rawSpellingsForPersona` already produce the `.in("contact_persona", …)`
    // filter and already REFUSE an unresolvable basis. A second implementation
    // here would be a second vocabulary that drifts, and the drift that matters
    // is the permissive one.
    narrowedByPersonaGate: true,
  }),

  // ── TAGS (1) ───────────────────────────────────────────────────────────────
  contact_list: (filters) => {
    const tags = nonEmptyStringArray(filters.contact_tags)
    if (!tags) {
      // THIS WAS A HOLE TOO. The original code read
      //   `if (type === "contact_list" && filters.contact_tags)`
      // so a `contact_list` rule with NO tags — or with `contact_tags: []`, which
      // is falsy-adjacent enough that nobody looked — skipped the narrowing and
      // uploaded the whole book. An empty tag list is not "all tags".
      return refuse(
        "contact_list",
        "underspecified",
        "promises a tagged slice of your contacts but names no tags. `filters.contact_tags` must be a " +
          "non-empty list of strings. An absent or empty tag list is not 'every tag' — it is no basis at " +
          "all, and it would upload every consented contact in the brokerage.",
      )
    }
    return {
      ok: true,
      ruleType: "contact_list",
      label: `contacts tagged ${tags.map((t) => `“${t}”`).join(" AND ")}`,
      predicates: [
        { column: "tags", op: "contains", value: tags, says: `tagged ${tags.join(" + ")}` },
      ],
      join: null,
      uploadsContacts: true,
      narrowedByPersonaGate: false,
    }
  },

  // ── LIFECYCLE / TYPE (3) ───────────────────────────────────────────────────
  lifetime_customers: (filters, now) => {
    const tenure = filters.min_tenure_months
    const predicates: NarrowPredicate[] = [
      {
        column: "contact_type",
        op: "in",
        value: [...LIFETIME_CONTACT_TYPES],
        says: `contact_type is one of ${[...LIFETIME_CONTACT_TYPES].join("/")}`,
      },
    ]
    let join: NarrowJoin | null = null
    let tenureSays = ""
    if (tenure !== undefined && tenure !== null) {
      if (typeof tenure !== "number" || !Number.isFinite(tenure) || tenure < 0) {
        return refuse(
          "lifetime_customers",
          "underspecified",
          "declares `min_tenure_months` but it is not a non-negative number. A tenure floor that cannot " +
            "be read must refuse rather than be dropped — dropping it silently widens the audience.",
        )
      }
      if (tenure > 0) {
        // Ownership tenure needs a PURCHASE DATE. `transactions.close_date` is the
        // only one in the live schema; `contacts.home_anniversary` exists but is
        // written by nothing, so filtering on it would silently match no one.
        const cutoff = new Date(now.getTime())
        cutoff.setMonth(cutoff.getMonth() - tenure)
        join = {
          table: "transactions",
          contactIdColumns: ["contact_id", "buyer_contact_id", "seller_contact_id"],
          predicates: [
            {
              column: "status",
              op: "in",
              value: [...COMPLETED_TRANSACTION_STATUSES],
              says: "the deal completed",
            },
            { column: "close_date", op: "lte", value: cutoff.toISOString().slice(0, 10), says: `closed ≥ ${tenure} months ago` },
          ],
          says: `owned for at least ${tenure} months (transactions.close_date)`,
        }
        tenureSays = `, owning for ${tenure}+ months`
      }
    }
    return {
      ok: true,
      ruleType: "lifetime_customers",
      label: `past clients — contacts whose type is one of ${[...LIFETIME_CONTACT_TYPES].join(", ")}${tenureSays}`,
      predicates,
      join,
      uploadsContacts: true,
      narrowedByPersonaGate: false,
    }
  },

  investor_contacts: () => ({
    ok: true,
    ruleType: "investor_contacts",
    label: `contacts whose contact_persona is “${INVESTOR_PERSONA}”`,
    predicates: [
      { column: "contact_persona", op: "eq", value: INVESTOR_PERSONA, says: "contact_persona = investor" },
    ],
    join: null,
    uploadsContacts: true,
    narrowedByPersonaGate: false,
  }),

  high_engagement_contacts: (filters) => {
    const min = filters.min_engagement_score
    if (typeof min !== "number" || !Number.isFinite(min) || min <= 0) {
      // `contacts.engagement_score` DEFAULTS TO 0, so `>= 0` — and therefore an
      // absent threshold read as zero — is literally every row. The audience is
      // named "high engagement"; a threshold is the whole rule, not a garnish.
      return refuse(
        "high_engagement_contacts",
        "underspecified",
        "promises contacts whose engagement score is high, but names no threshold. " +
          "`filters.min_engagement_score` must be a number greater than 0 — `contacts.engagement_score` " +
          "DEFAULTS to 0, so an absent or zero threshold matches every contact in the brokerage while " +
          "still calling itself “high engagement”.",
      )
    }
    return {
      ok: true,
      ruleType: "high_engagement_contacts",
      label: `contacts whose engagement_score is ${min} or higher`,
      predicates: [
        { column: "engagement_score", op: "gte", value: min, says: `engagement_score ≥ ${min}` },
      ],
      join: null,
      uploadsContacts: true,
      narrowedByPersonaGate: false,
    }
  },

  // ── ACTIVITY-BOUND (2) ─────────────────────────────────────────────────────
  active_buyers: (filters, now) => {
    const cutoff = cutoffISO(filters.days_lookback, now)
    if (!cutoff) {
      // "ACTIVE" IS A RECENCY CLAIM. Without a window the rule degrades to "every
      // buyer we have ever held", which is a materially different — and much
      // larger — audience than the one the name sells.
      return refuse(
        "active_buyers",
        "underspecified",
        "promises buyers who are ACTIVE, but names no activity window. `filters.days_lookback` must be a " +
          "positive number of days. Without it this is “every buyer contact ever recorded”, which is a " +
          "different and far larger audience than the name sells.",
      )
    }
    return {
      ok: true,
      ruleType: "active_buyers",
      label:
        `buyers (contact_type ${[...BUYER_CONTACT_TYPES].join("/")}) contacted in the last ` +
        `${filters.days_lookback} days and not yet under contract`,
      predicates: [
        { column: "contact_type", op: "in", value: [...BUYER_CONTACT_TYPES], says: "a buyer" },
        { column: "last_contacted_at", op: "gte", value: cutoff, says: `contacted since ${cutoff.slice(0, 10)}` },
        {
          column: "buyer_stage",
          op: "not_in",
          value: [...INACTIVE_BUYER_STAGES],
          says: "not under contract, closed, on hold or disengaged",
        },
      ],
      join: null,
      uploadsContacts: true,
      narrowedByPersonaGate: false,
    }
  },

  active_sellers: (filters) => {
    if (lookbackIsInvalid(filters.days_lookback)) {
      return refuse(
        "active_sellers",
        "underspecified",
        "declares `days_lookback` but it is not a positive number of days. A window that cannot be read " +
          "must refuse rather than be dropped.",
      )
    }
    return {
      ok: true,
      ruleType: "active_sellers",
      label:
        "sellers who hold a listing that is pre-listing or live on market " +
        `(listings.status in ${[...ACTIVE_LISTING_STATUSES].join("/")})`,
      predicates: [
        { column: "contact_type", op: "in", value: [...SELLER_CONTACT_TYPES], says: "a seller" },
      ],
      join: {
        table: "listings",
        // `seller_contact_id` is the seller; `contact_id` is the older spelling
        // still carried by app/api/cron/seller-updates/route.ts:82, which reads
        // `listing.seller_contact_id ?? listing.contact_id`. Both are honoured so
        // this rule does not silently exclude rows written by the older writer.
        contactIdColumns: ["seller_contact_id", "contact_id"],
        predicates: [
          {
            column: "status",
            op: "in",
            value: [...ACTIVE_LISTING_STATUSES],
            says: "listing is pre-listing or live",
          },
        ],
        says: "holds a pre-listing or live listing",
      },
      uploadsContacts: true,
      narrowedByPersonaGate: false,
    }
  },

  // ── JOIN-BOUND (3) ─────────────────────────────────────────────────────────
  qualified_leads: (filters, now) => {
    if (lookbackIsInvalid(filters.days_lookback)) {
      return refuse(
        "qualified_leads",
        "underspecified",
        "declares `days_lookback` but it is not a positive number of days.",
      )
    }
    const cutoff = cutoffISO(filters.days_lookback, now)
    const predicates: NarrowPredicate[] = [
      {
        column: "lead_stage",
        op: "eq",
        value: QUALIFIED_LEAD_STAGE,
        says: `lead_stage = ${QUALIFIED_LEAD_STAGE}`,
      },
    ]
    if (cutoff) {
      predicates.push({
        column: "stage_entered_at",
        op: "gte",
        value: cutoff,
        says: `qualified since ${cutoff.slice(0, 10)}`,
      })
    }
    return {
      ok: true,
      ruleType: "qualified_leads",
      label:
        "contacts converted from a lead the ISA marked qualified" +
        (cutoff ? ` in the last ${filters.days_lookback} days` : ""),
      predicates: [],
      join: {
        table: "leads",
        // THE LEAD ITSELF IS NEVER UPLOADED. `leads` are explicitly unconsented at
        // capture (leads_lifecycle_state_check carries 'unconsented'), and Meta's
        // Custom Audiences policy requires an opt-in relationship — the reasoning
        // already recorded in lib/audiences/audience-sync.ts's header. So this
        // resolves through `leads.contact_id` to the CONTACT the lead became, and
        // the contacts query's own `tcpa_consent = true` floor still applies.
        contactIdColumns: ["contact_id"],
        predicates,
        says: "became a contact from an ISA-qualified lead",
      },
      uploadsContacts: true,
      narrowedByPersonaGate: false,
    }
  },

  open_house_attendees: (filters, now) => {
    if (lookbackIsInvalid(filters.days_lookback)) {
      return refuse(
        "open_house_attendees",
        "underspecified",
        "declares `days_lookback` but it is not a positive number of days.",
      )
    }
    const cutoff = cutoffISO(filters.days_lookback, now)
    const predicates: NarrowPredicate[] = []
    if (cutoff) {
      predicates.push({
        column: "check_in_time",
        op: "gte",
        value: cutoff,
        says: `checked in since ${cutoff.slice(0, 10)}`,
      })
    }
    return {
      ok: true,
      ruleType: "open_house_attendees",
      label:
        "contacts who checked in at one of your open houses" +
        (cutoff ? ` in the last ${filters.days_lookback} days` : ""),
      predicates: [],
      join: {
        table: "open_house_attendees",
        // PUBLISHED BLIND SPOT (CLAUDE.md §2). `open_house_attendees.contact_id` is
        // written by ONE of the three insert sites — app/actions/open-house-
        // automation.ts:178. The walk-in sign-in paths (open-house-automation.ts:
        // 1615, seller-open-house.ts:677) write name/email/phone and leave
        // contact_id NULL, so those attendees are NOT in this audience even when
        // the same person exists as a contact. That undercounts, which is the
        // fail-closed direction; matching on raw email instead would mean shipping
        // an unverified email join into an egress path, which is worse.
        contactIdColumns: ["contact_id"],
        predicates,
        says: "checked in at an open house",
      },
      uploadsContacts: true,
      narrowedByPersonaGate: false,
    }
  },

  in_pipeline: (filters) => {
    if (lookbackIsInvalid(filters.days_lookback)) {
      return refuse(
        "in_pipeline",
        "underspecified",
        "declares `days_lookback` but it is not a positive number of days.",
      )
    }
    return {
      ok: true,
      ruleType: "in_pipeline",
      label:
        "contacts on a LIVE transaction " +
        `(transactions.status in ${[...LIVE_TRANSACTION_STATUSES].join("/")})`,
      predicates: [],
      join: {
        table: "transactions",
        // Three FKs reach a contact from this table, which is exactly why this is
        // an id prefetch and not an embed (PGRST201 — CLAUDE.md §3).
        contactIdColumns: ["contact_id", "buyer_contact_id", "seller_contact_id"],
        predicates: [
          {
            column: "status",
            op: "in",
            value: [...LIVE_TRANSACTION_STATUSES],
            says: "the deal is live",
          },
        ],
        says: "is on a live transaction",
      },
      uploadsContacts: true,
      narrowedByPersonaGate: false,
    }
  },

  // ── THE ONE DELIBERATELY WIDE RULE (1) ─────────────────────────────────────
  //
  // This audience is MEANT to be broad — it exists to be applied as an EXCLUSION
  // so prospecting ads do not spend on people already in conversation. Wide is not
  // the same as unnarrowed, though, and the distinction is the whole finding:
  // `status = 'active'` genuinely excludes contacts sitting at the 'new' default,
  // at 'inactive', and at every other status, so the audience is a defined set
  // rather than "whatever the base query returned".
  exclusion_active_pipeline: () => ({
    ok: true,
    ruleType: "exclusion_active_pipeline",
    label:
      `every contact whose status is “${ACTIVE_CONTACT_STATUS}” — intentionally broad, and intended ` +
      "for use as an EXCLUSION rather than as a targeting audience",
    predicates: [
      { column: "status", op: "eq", value: ACTIVE_CONTACT_STATUS, says: "status = active" },
    ],
    join: null,
    uploadsContacts: true,
    narrowedByPersonaGate: false,
  }),
}

// ─── THE ENTRY POINT ──────────────────────────────────────────────────────────

/**
 * Resolve what an audience's `source_rule` ACTUALLY selects, or REFUSE.
 *
 * FAIL CLOSED, WITH NO WIDENING DEFAULT (CLAUDE.md §4). There is deliberately no
 * `default:` arm that returns "no predicates" — every path out of this function
 * is either a definition or a refusal. That absence is the fix; the definitions
 * above are what make it survivable.
 *
 * `now` is a parameter so lookback windows are testable without freezing a clock.
 */
export function resolveSourceRuleNarrowing(
  rule: unknown,
  now: Date = new Date(),
): SourceRuleNarrowing {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return refuse(
      "(none)",
      "no_rule",
      "has NO source rule at all. An audience with no rule is not “everyone with consent” — it is an " +
        "audience nobody defined, and uploading the brokerage's whole consented contact list under its " +
        "name is the defect this refusal exists to prevent.",
    )
  }
  const r = rule as RuleShape
  if (!isSourceRuleType(r.type)) {
    return refuse(
      typeof r.type === "string" ? r.type : `(${typeof r.type})`,
      "unknown_type",
      `names source rule type ${JSON.stringify(r.type)}, which this product cannot resolve. The known ` +
        `types are: ${SOURCE_RULE_TYPES.join(", ")}. An unrecognised type REFUSES rather than falling ` +
        "through to an unnarrowed upload.",
    )
  }
  const filters =
    r.filters && typeof r.filters === "object" && !Array.isArray(r.filters)
      ? (r.filters as Record<string, unknown>)
      : {}

  const narrowing = NARROWERS[r.type](filters, now)
  if (!narrowing.ok) return narrowing

  // ── SERVICE-AREA NARROWING, applied to every resolvable rule ───────────────
  // `filters.zip_codes` was declared on `SourceRule` and read by NOTHING — a
  // writerless-reader orphan on the permissive side: an operator who narrowed an
  // audience to their service area got the whole brokerage anyway. It only ever
  // narrows, so it is safe to apply uniformly (CLAUDE.md §1 — build the missing
  // half rather than delete the field).
  const zips = nonEmptyStringArray(filters.zip_codes)
  if (zips) {
    return {
      ...narrowing,
      label: `${narrowing.label}, limited to zip ${zips.join("/")}`,
      predicates: [
        ...narrowing.predicates,
        { column: "zip_code", op: "in", value: zips, says: `zip in ${zips.join("/")}` },
      ],
    }
  }
  return narrowing
}

// ─── THE FIXTURE EVALUATOR ────────────────────────────────────────────────────

/**
 * PURE. Does one row satisfy a predicate list?
 *
 * This is the SECOND consumer of the declarative narrowing and it is not a
 * convenience: the live database holds FOUR contacts, so a live count can never
 * discriminate between "this filter narrows" and "this filter is absent". The
 * simulator asserts on fixtures where each rule's population is a STRICT SUBSET,
 * and that is only possible because the narrowing is data rather than a chain of
 * `.eq()` calls buried in an egress function.
 *
 * Unknown/NULL handling is deliberately STRICT: a null column value satisfies no
 * operator except an explicit `not_in`/`eq` against null. A row we know nothing
 * about is not a member of an audience that claims to know something about it.
 */
export function rowMatchesPredicates(
  row: Record<string, unknown>,
  predicates: readonly NarrowPredicate[],
): boolean {
  return predicates.every((p) => {
    const v = row[p.column]
    switch (p.op) {
      case "eq":
        return v === p.value
      case "in":
        return Array.isArray(p.value) && (p.value as unknown[]).includes(v)
      case "not_in":
        // A NULL stage has not reached any of the excluded stages, so it passes —
        // this matches Postgres `col is null or col <> all(...)` only when the
        // caller applies the same `.or()`, which the query builder in syncAudience
        // does. Kept identical on both sides on purpose (CLAUDE.md §6).
        return !(Array.isArray(p.value) && (p.value as unknown[]).includes(v))
      case "gte":
        if (v === null || v === undefined) return false
        return compare(v, p.value) >= 0
      case "lte":
        if (v === null || v === undefined) return false
        return compare(v, p.value) <= 0
      case "contains":
        return Array.isArray(v) && Array.isArray(p.value) && (p.value as unknown[]).every((x) => v.includes(x))
      case "not_null":
        return v !== null && v !== undefined
    }
  })
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/**
 * PURE. The full membership answer for a fixture: does this contact belong in the
 * audience this rule defines? `joinRows` are the rows of the join table (if any).
 *
 * Mirrors the query builder in `syncAudience` clause for clause — including the
 * rule that an EMPTY join id-set yields an EMPTY audience.
 */
export function contactMatchesNarrowing(
  contact: Record<string, unknown>,
  narrowing: SourceRuleNarrowingOk,
  joinRows: Array<Record<string, unknown>> = [],
  personaSpellings: readonly string[] | null = null,
): boolean {
  if (!narrowing.uploadsContacts) return false
  if (!rowMatchesPredicates(contact, narrowing.predicates)) return false
  if (narrowing.narrowedByPersonaGate) {
    if (!personaSpellings) return false
    if (!personaSpellings.includes(String(contact.contact_persona))) return false
  }
  if (narrowing.join) {
    const ids = new Set<unknown>()
    for (const jr of joinRows) {
      if (!rowMatchesPredicates(jr, narrowing.join.predicates)) continue
      for (const col of narrowing.join.contactIdColumns) {
        if (jr[col] !== null && jr[col] !== undefined) ids.add(jr[col])
      }
    }
    if (!ids.has(contact.id)) return false
  }
  return true
}
