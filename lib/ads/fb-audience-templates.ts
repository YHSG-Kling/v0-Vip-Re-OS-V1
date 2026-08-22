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

export interface AudienceTemplate {
  id: string
  name: string
  description: string
  category: "remarketing" | "lookalike" | "exclusion" | "geo" | "lifecycle"
  audienceType: AudienceType
  sourceRule: SourceRule
  consentBasis: string
  recommendedFor: string[]
  estimatedSizeLabel: string
}

export const FB_AUDIENCE_TEMPLATES: AudienceTemplate[] = [
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
