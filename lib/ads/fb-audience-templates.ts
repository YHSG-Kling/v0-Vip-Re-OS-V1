// lib/ads/fb-audience-templates.ts
//
// FB AUDIENCE PREBUILT TEMPLATES (pure)
//
// One-click audience creation for the most common real estate use cases.
// Each template is a curated SourceRule + recommended consent basis +
// description. Agents browse these in the Ads Dashboard → Audiences tab and
// spin up a Facebook custom audience in a single click.
//
// This module is intentionally pure (no "use server", no DB, no egress) so the
// catalog can be imported directly by client components AND re-exported from the
// `app/actions/fb-audience-templates.ts` server action. The actual contact-list
// resolution happens at sync time inside the kernel `syncAudience` command.

import type { SourceRule, AudienceType } from "@/lib/kernel/ads"
import {
  ADS_ELIGIBLE_PERSONAS,
  PERSONA_SEGMENT_TYPE,
} from "@/lib/ads/audience-persona-basis"
// THE ONE VOCABULARY FOR "does this audience subtract people" (CLAUDE.md §6).
// `category: "exclusion"` used to be a SECOND spelling of it here — see the
// tombstone on `category` below.
import { audienceUseOf, type AudienceUse } from "@/lib/ads/audience-source-rules"
import type { CampaignPersona } from "@/lib/campaigns/contact-sources"

export interface AudienceTemplate {
  id: string
  name: string
  description: string
  /**
   * WHAT KIND OF RECIPE this is, for browsing. A SHELF LABEL — never the
   * operation the audience performs.
   *
   * ── TOMBSTONE: `"exclusion"` WAS A MEMBER HERE AND IS GONE (CLAUDE.md §6) ──
   * SURVIVOR: `audienceUseOf(template.sourceRule)` — lib/ads/audience-source-rules.ts:171,
   * derived by prefix from the one `SOURCE_RULE_TYPES` roster. `templateAudienceUse`
   * below is the accessor callers use.
   *
   * The deleted member was a second spelling of exclusion intent and it had
   * already drifted from the first: `exclude_lifetime_customers` carried
   * `category: "exclusion"` while its own `sourceRule.type` was
   * `lifetime_customers`, which `audienceUseOf` reads as an INCLUSION rule — so
   * the catalog said "exclusion" and every gate that matters said "inclusion"
   * about the same template. It also never persisted: `facebook_custom_audiences`
   * has no category column, so the claim vanished the moment an operator clicked
   * the template and could not be checked by anything downstream.
   *
   * "persona" stays its own shelf rather than folding into "lifecycle": lifecycle
   * is WHERE someone is in our funnel, persona is WHAT KIND of client they are and
   * what they are trying to do. Conflating them is how a persona audience ends up
   * being built out of a lifecycle stage.
   */
  category: "remarketing" | "lookalike" | "geo" | "lifecycle" | "persona"
  audienceType: AudienceType
  sourceRule: SourceRule
  consentBasis: string
  recommendedFor: string[]
  estimatedSizeLabel: string
}

/**
 * WHAT EACH ADS-ELIGIBLE PERSONA IS TRYING TO DO. This is the OPERATOR-FACING
 * copy for a persona template — the situation, never a characteristic.
 *
 * It is a `Record<CampaignPersona, …>` over the ELIGIBLE set only, and the
 * derivation below reads it through `ADS_ELIGIBLE_PERSONAS`, so the day a persona
 * is added to the canonical union with no copy here, this file stops compiling
 * rather than shipping a template labelled `undefined`. Only `other` is excluded:
 * it names no situation, so there is nothing to write copy about.
 *
 * ── THE FOUR ADDED BY THE 2026-08-23 RULING ─────────────────────────────────
 * `senior`, `probate`, `divorce` and `military` were ineligible in this file's
 * first cut and shipped no template. The owner ruled them in: "that is how we
 * show them info or ads that is worded to their situation as part of them-first
 * methology." Their copy below is written to that instruction — each entry names
 * a TRANSACTION SITUATION and the information a person in it actually needs, and
 * none of them is phrased as a preference for or against a class of person. A
 * template here is an INCLUSION basis by construction (`PERSONA_SEGMENT_TYPE`);
 * a persona audience that SUPPRESSES people is refused by
 * `assertAudiencePersonaBasis` and the catalog has no way to express one.
 */
const PERSONA_TEMPLATE_COPY: Record<
  Exclude<CampaignPersona, "other">,
  { name: string; situation: string; recommendedFor: string[]; size: string }
> = {
  first_time: {
    name: "First-Time Buyers",
    situation: "Contacts buying their first home. They need the process explained, not another listing blast.",
    recommendedFor: ["Buyer education content", "Down payment / loan program explainers", "First-time buyer seminars"],
    size: "~20–300",
  },
  relocated: {
    name: "Relocating",
    situation: "Contacts moving into or across your market. Their question is the neighbourhood, not the house.",
    recommendedFor: ["Neighbourhood guides", "Relocation checklists", "Virtual tour offers"],
    size: "~10–150",
  },
  luxury: {
    name: "Luxury",
    situation: "Contacts in the luxury tier. Discretion, comparables and off-market inventory.",
    recommendedFor: ["Private listing previews", "Luxury market reports", "Off-market opportunities"],
    size: "~5–80",
  },
  fsbo: {
    name: "For Sale By Owner",
    situation: "Owners selling on their own. The pitch is what representation adds, with evidence.",
    recommendedFor: ["FSBO conversion content", "Pricing-accuracy proof", "Net-sheet comparisons"],
    size: "~5–100",
  },
  upsize: {
    name: "Upsizing",
    situation: "Contacts who have outgrown their home and are trading up.",
    recommendedFor: ["Buy-before-you-sell explainers", "Bridge financing", "Larger-home inventory"],
    size: "~10–200",
  },
  downsize: {
    name: "Downsizing",
    situation: "Contacts deliberately moving to a smaller home. A stated INTENT, not an inference about anybody's age.",
    recommendedFor: ["Equity-release explainers", "Single-level / low-maintenance inventory", "Move management"],
    size: "~10–200",
  },
  expired: {
    name: "Expired Listings",
    situation: "Owners whose listing expired unsold. They already tried; the pitch is what changes.",
    recommendedFor: ["Relist strategy", "Pricing post-mortems", "Marketing-plan comparisons"],
    size: "~5–150",
  },
  foreclosure: {
    name: "Foreclosure / Pre-Foreclosure",
    situation: "Owners facing foreclosure — a financial and legal situation, sourced from public filings on the parcel.",
    recommendedFor: ["Options explainers", "Short-sale education", "Timeline guidance"],
    size: "~5–80",
  },
  probate: {
    name: "Probate / Inherited Property",
    situation: "Contacts settling an estate that includes a property. The questions are the court timeline, the co-heirs and what a sale actually requires — not another listing blast.",
    recommendedFor: ["Probate timeline explainers", "Executor checklists", "Estate-sale coordination", "As-is vs repair guidance"],
    size: "~5–80",
  },
  divorce: {
    name: "Divorce / Separation",
    situation: "Contacts dividing a marital home. They need the buy-out, refinance and sale options laid out plainly, and a process that works with two decision-makers.",
    recommendedFor: ["Buy-out vs sale explainers", "Equity-split walkthroughs", "Neutral-party listing process"],
    size: "~5–80",
  },
  senior: {
    name: "Senior Transition",
    situation: "Contacts making a later-life move — to single-level living, to be near family, or into a care community. The information they need is about equity, timing and the logistics of a move out of a long-held home.",
    recommendedFor: ["Equity-release explainers", "Move-management resources", "Single-level / low-maintenance inventory", "Timing around a family move"],
    size: "~10–150",
  },
  military: {
    name: "Military / VA",
    situation: "Service members and veterans buying or selling around a posting. PCS timelines are short and VA financing has rules most agents explain badly.",
    recommendedFor: ["VA loan explainers", "PCS relocation timelines", "Base-proximity neighbourhood guides"],
    size: "~5–100",
  },
  // The fourteenth persona (owner ruling 2026-08-31: "investor is a persona and
  // not a contact type"; m589). Copy carried over from the retired
  // `investor_contacts` lifecycle template this entry SUPERSEDES — see the
  // tombstone below the catalog.
  investor: {
    name: "Investors",
    situation: "Contacts buying for investment — portfolio, rental income or a flip. ROI-focused content, multi-family deals, off-market opportunities.",
    recommendedFor: ["Off-market deals", "Cash-flow analysis", "1031 exchange info"],
    size: "~5–50",
  },
}

/**
 * PERSONA-BASIS TEMPLATES — the owner's ruling made one-click.
 *
 * DERIVED from `ADS_ELIGIBLE_PERSONAS` rather than typed out, so the catalog and
 * the gate can never disagree: a persona the gate refuses cannot appear here, and
 * a persona the gate admits gets an audience an operator can actually build.
 * Hand-listing them would let the two drift, and the drift that matters is the
 * permissive one — a shipped template for a persona the gate refuses is an
 * operator clicking a button that always errors.
 */
const PERSONA_BASIS_TEMPLATES: AudienceTemplate[] = ADS_ELIGIBLE_PERSONAS.flatMap((persona) => {
  const copy = PERSONA_TEMPLATE_COPY[persona as keyof typeof PERSONA_TEMPLATE_COPY]
  if (!copy) return []
  return [{
    id: `persona_${persona}`,
    name: `Persona — ${copy.name}`,
    description: copy.situation,
    category: "persona" as const,
    audienceType: "persona_segment" as AudienceType,
    sourceRule: { type: PERSONA_SEGMENT_TYPE, filters: { personas: [persona] } } as SourceRule,
    consentBasis: "Existing contacts with marketing consent — segmented on declared transaction situation",
    recommendedFor: copy.recommendedFor,
    estimatedSizeLabel: copy.size,
  }]
})

export const FB_AUDIENCE_TEMPLATES: AudienceTemplate[] = [
  ...PERSONA_BASIS_TEMPLATES,
  // ─── REMARKETING ────────────────────────────────────────────────────────
  {
    id: "qualified_leads_remarketing",
    name: "Qualified Leads — Retargeting",
    description: "Contacts the AI ISA has qualified but who haven't yet booked an appointment. Reach them where they live online with a soft re-engagement ad.",
    category: "remarketing",
    audienceType: "custom",
    sourceRule: {
      type: "qualified_leads",
      filters: { days_lookback: 60 },
    },
    consentBasis: "Existing business relationship — qualified by ISA after capturing TCPA consent",
    recommendedFor: ["Buyer & seller funnels", "Open house follow-ups", "New listing campaigns"],
    estimatedSizeLabel: "~50–500",
  },
  {
    id: "active_buyers",
    name: "Active Buyers in Pipeline",
    description: "Buyers in your CRM who have engaged in the last 30 days but haven't gone under contract. Show them new listings before they hit their inbox.",
    category: "remarketing",
    audienceType: "custom",
    sourceRule: {
      type: "active_buyers",
      filters: { days_lookback: 30 },
    },
    consentBasis: "Active client relationship — full consent on file",
    recommendedFor: ["Just-listed alerts", "Price-reduction announcements", "Open house invites"],
    estimatedSizeLabel: "~20–200",
  },
  {
    id: "open_house_attendees",
    name: "Open House Attendees",
    description: "Everyone who checked in at one of your open houses. Perfect for similar-property promotion and reactivation.",
    category: "remarketing",
    audienceType: "custom",
    sourceRule: {
      type: "open_house_attendees",
      filters: { days_lookback: 90 },
    },
    consentBasis: "Sign-in form consent at open house",
    recommendedFor: ["Similar listings", "Market updates", "Buyer consultations"],
    estimatedSizeLabel: "~10–500",
  },

  // ─── LOOKALIKE ──────────────────────────────────────────────────────────
  {
    id: "lifetime_customers_lookalike",
    name: "Lifetime Customer Lookalike (1%)",
    description: "Facebook finds users who look like your past clients — the strongest lookalike for real estate. Pulls from your lifetime customer roster as the seed.",
    category: "lookalike",
    audienceType: "lookalike",
    sourceRule: {
      type: "lookalike_seed",
      filters: { seed_country: "US", seed_lookalike_size_pct: 1 },
    },
    consentBasis: "Aggregated, hashed seed list — no PII shared with Facebook in identifiable form",
    recommendedFor: ["New buyer/seller acquisition in your market", "Brand awareness ads"],
    estimatedSizeLabel: "~2M (1% of US adults)",
  },
  {
    id: "qualified_leads_lookalike",
    name: "Qualified Leads Lookalike (3%)",
    description: "Looks like the people your ISA has actually qualified. A wider net than lifetime customers — useful for top-of-funnel growth.",
    category: "lookalike",
    audienceType: "lookalike",
    sourceRule: {
      type: "lookalike_seed",
      filters: { seed_country: "US", seed_lookalike_size_pct: 3 },
    },
    consentBasis: "Aggregated, hashed seed list",
    recommendedFor: ["Awareness campaigns", "Lead magnets", "Free home value offers"],
    estimatedSizeLabel: "~6M (3% of US adults)",
  },

  // ─── SUPPRESSION-FIRST (the rule type declares it, not a category) ──────
  {
    id: "exclude_active_pipeline",
    name: "Exclude — Active Pipeline",
    description: "USE AS EXCLUSION on every retargeting/lookalike campaign. Prevents your ads from spending budget on contacts you're already in conversation with. Its rule type is `exclusion_active_pipeline`, so the product itself knows this audience exists to be subtracted — `templateAudienceUse` reads that, and the gate at lib/ads/audience-exclusion.ts checks it when a campaign actually uses it.",
    // Its shelf is lifecycle; its OPERATION is derived from the rule type, which
    // is the only spelling of exclusion intent left in this file (see `category`).
    category: "lifecycle",
    audienceType: "custom",
    sourceRule: {
      type: "exclusion_active_pipeline",
      filters: {},
    },
    consentBasis: "Internal exclusion list — never shared with FB in identifiable form",
    recommendedFor: ["Apply as exclusion to ALL prospecting campaigns"],
    estimatedSizeLabel: "Your full active pipeline",
  },
  // ── TOMBSTONE: "Exclude — Lifetime Customers" (id `exclude_lifetime_customers`)
  //    WAS HERE AND IS GONE (CLAUDE.md §1, §6) ───────────────────────────────
  // SURVIVOR: the `lifetime_customers` template at lib/ads/fb-audience-templates.ts:307,
  // which declares the identical rule (`{ type: "lifetime_customers" }`) and has
  // absorbed this one's recommendation.
  //
  // It was a DUPLICATE that existed only to carry `category: "exclusion"` — the
  // second spelling of exclusion intent this file no longer has. The two
  // spellings disagreed about this very template: the category said "exclusion"
  // while `audienceUseOf(sourceRule)` said "inclusion", and no gate reads the
  // category, so an operator who clicked it got an ordinary lifetime-customer
  // audience with a promise attached to nothing.
  //
  // The capability it was reaching for now exists for real: a campaign declares
  // which audiences it SUPPRESSES in `TargetingConfig.excluded_audience_ids`, and
  // every audience placed there is gated (lib/ads/audience-exclusion.ts). "Use
  // this as an exclusion" is a property of the CAMPAIGN that uses it — one
  // audience, used either way, checked when it is used.

  // ─── LIFECYCLE / SPHERE ─────────────────────────────────────────────────
  {
    // THE SURVIVOR of the `exclude_lifetime_customers` merge (§1). That template
    // named the SAME rule type with the same filters and differed only in the
    // deleted `category: "exclusion"` spelling, so its content is merged here:
    // its use — suppressing past clients from cold-acquisition prospecting — is
    // now DECLARED where the system can see and gate it, in a campaign's
    // `excluded_audience_ids` slot, rather than asserted by a catalog label that
    // never left the browser.
    id: "lifetime_customers",
    name: "Lifetime Customers",
    description: "Your past clients. Target them directly with anniversary content, market updates and referral asks — or put this audience in a campaign's Exclude list so prospecting ads never ask a past client to 'find an agent'.",
    category: "lifecycle",
    audienceType: "custom",
    sourceRule: {
      type: "lifetime_customers",
      // RENAMED from `min_purchase_age_months` — see the field's note at
      // lib/kernel/ads.ts (SourceRule.filters). The word "age" here meant elapsed
      // time since purchase, but it collides with the protected-class token
      // vocabulary, so this shipped template was refused by the fair-housing
      // audience gate. One vocabulary per function (CLAUDE.md §6): tenure.
      filters: { min_tenure_months: 0 },
    },
    consentBasis: "Past client — established relationship",
    recommendedFor: [
      "Annual anniversaries", "Market updates", "Referral asks", "Equity awareness",
      // Merged from the deleted duplicate.
      "Exclude from prospecting / acquisition campaigns",
    ],
    estimatedSizeLabel: "Your full LC roster",
  },
  {
    id: "high_engagement_contacts",
    name: "High-Engagement Contacts",
    description: "Contacts whose engagement score is 70+. They're paying attention — invest your warmest content here.",
    category: "lifecycle",
    audienceType: "custom",
    sourceRule: {
      type: "high_engagement_contacts",
      filters: { min_engagement_score: 70 },
    },
    consentBasis: "Existing contacts with consent",
    recommendedFor: ["Featured listings", "Personal videos", "Event invites"],
    estimatedSizeLabel: "~30–300",
  },
  // TOMBSTONE (§1.1, 2026-08-31): the `investor_contacts` template stood here —
  // "Investor-type contacts only", selecting contact_type='investor'. The owner
  // ruled that value out of contact_type ("investor is a persona and not a
  // contact type"), which made this a DUPLICATE of the derived persona template.
  // SURVIVOR: `persona_investor` in PERSONA_BASIS_TEMPLATES above (its copy —
  // ROI-focused content, off-market deals, 1031 — was merged onto
  // PERSONA_TEMPLATE_COPY.investor first). The `investor_contacts` SOURCE RULE
  // TYPE itself survives in lib/ads/audience-source-rules.ts, repointed onto
  // contact_persona='investor', because the live jsonb CHECK
  // (facebook_custom_audiences_source_rule_type_check, m532) still admits the
  // type and a stored audience naming it must keep resolving.

  // ─── GEO ─────────────────────────────────────────────────────────────────
  {
    id: "service_area_lookalike",
    name: "Service Area Lookalike",
    description: "Facebook builds a lookalike of your contacts AND restricts to your service-area zip codes. Pure geo-fenced acquisition.",
    category: "geo",
    audienceType: "lookalike",
    sourceRule: {
      type: "lookalike_seed",
      filters: { seed_country: "US", seed_lookalike_size_pct: 5 },
    },
    consentBasis: "Aggregated seed list + geo restriction",
    recommendedFor: ["Hyper-local listing promotion", "Neighborhood ad targeting"],
    estimatedSizeLabel: "Local market coverage",
  },
]

/**
 * PURE. Which OPERATION a template's audience performs on the people it selects
 * — derived from its source rule, never from its shelf label.
 *
 * THE ONE ACCESSOR (§6). It exists so callers do not each write
 * `audienceUseOf(t.sourceRule)` and one of them eventually write
 * `t.category === "exclusion"` instead, which is the drift this file just paid
 * for: the deleted category said "exclusion" about a template whose rule type
 * said "inclusion", and the gates read the rule type.
 *
 * Note what it is NOT: it answers what the AUDIENCE'S OWN RULE declares. A
 * campaign can subtract any audience by naming it in
 * `TargetingConfig.excluded_audience_ids`, and THAT placement is gated by
 * lib/ads/audience-exclusion.ts, which escalates the persona verdict to
 * "exclusion" whatever this returns.
 */
export function templateAudienceUse(template: AudienceTemplate): AudienceUse {
  return audienceUseOf(template.sourceRule)
}

/**
 * Pure synchronous lookup of a template by id. Returns the full template or
 * undefined. (The server action `resolveAudienceTemplate` that once wrapped this
 * was deleted 2026-09-03 onto the client's own template → createAudience mapping,
 * ads-dashboard-client.tsx handleUseTemplate; see the tombstone in
 * app/actions/fb-audience-templates.ts.)
 */
export function findAudienceTemplate(templateId: string): AudienceTemplate | undefined {
  return FB_AUDIENCE_TEMPLATES.find((t) => t.id === templateId)
}
