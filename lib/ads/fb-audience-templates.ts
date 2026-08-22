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
import type { CampaignPersona } from "@/lib/campaigns/contact-sources"

export interface AudienceTemplate {
  id: string
  name: string
  description: string
  // "persona" — the basis the owner ruled on ("audience should be segmented on
  // persona"). Kept as its own category rather than folded into "lifecycle":
  // lifecycle is WHERE they are in our funnel, persona is WHAT KIND of client they
  // are and what they are trying to do. Conflating them is how a persona audience
  // ends up being built out of a lifecycle stage.
  category: "remarketing" | "lookalike" | "exclusion" | "geo" | "lifecycle" | "persona"
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
 * rather than shipping a template labelled `undefined`. A persona ruled INELIGIBLE
 * (senior, probate, divorce, military) has no entry and gets no template — the
 * catalog cannot offer an audience the gate would refuse.
 */
const PERSONA_TEMPLATE_COPY: Record<
  Exclude<CampaignPersona, "senior" | "probate" | "divorce" | "military" | "other">,
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

  // ─── EXCLUSION ──────────────────────────────────────────────────────────
  {
    id: "exclude_active_pipeline",
    name: "Exclude — Active Pipeline",
    description: "USE AS EXCLUSION on every retargeting/lookalike campaign. Prevents your ads from spending budget on contacts you're already in conversation with.",
    category: "exclusion",
    audienceType: "custom",
    sourceRule: {
      type: "exclusion_active_pipeline",
      filters: {},
    },
    consentBasis: "Internal exclusion list — never shared with FB in identifiable form",
    recommendedFor: ["Apply as exclusion to ALL prospecting campaigns"],
    estimatedSizeLabel: "Your full active pipeline",
  },
  {
    id: "exclude_lifetime_customers",
    name: "Exclude — Lifetime Customers",
    description: "USE AS EXCLUSION on prospecting ads — your past clients shouldn't see ads asking them to 'find an agent.' Suppresses them from cold-acquisition campaigns.",
    category: "exclusion",
    audienceType: "custom",
    sourceRule: {
      type: "lifetime_customers",
      filters: {},
    },
    consentBasis: "Internal exclusion list",
    recommendedFor: ["Prospecting / acquisition campaigns"],
    estimatedSizeLabel: "Your full lifetime customer roster",
  },

  // ─── LIFECYCLE / SPHERE ─────────────────────────────────────────────────
  {
    id: "lifetime_customers",
    name: "Lifetime Customers — Direct",
    description: "Reach your past clients with anniversary content, market updates, and referral asks. They've already converted; this is relationship-keeping.",
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
    recommendedFor: ["Annual anniversaries", "Market updates", "Referral asks", "Equity awareness"],
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
  {
    id: "investor_contacts",
    name: "Investors",
    description: "Investor-type contacts only. ROI-focused content, multi-family deals, off-market opportunities.",
    category: "lifecycle",
    audienceType: "custom",
    sourceRule: {
      type: "investor_contacts",
      filters: {},
    },
    consentBasis: "Existing contacts with consent",
    recommendedFor: ["Off-market deals", "Cash-flow analysis", "1031 exchange info"],
    estimatedSizeLabel: "~5–50",
  },

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
 * Pure synchronous lookup of a template by id. Returns the full template or
 * undefined. The server-action `resolveAudienceTemplate` builds its
 * create-audience params on top of this.
 */
export function findAudienceTemplate(templateId: string): AudienceTemplate | undefined {
  return FB_AUDIENCE_TEMPLATES.find((t) => t.id === templateId)
}
