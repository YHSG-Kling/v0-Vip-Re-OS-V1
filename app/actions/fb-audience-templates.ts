"use server"

/**
 * FB AUDIENCE PREBUILT TEMPLATES (server action)
 *
 * One-click audience creation for the most common real estate use cases.
 * The canonical catalog + the AudienceTemplate type now live in the pure
 * module `@/lib/ads/fb-audience-templates` so they can be imported directly by
 * client components (the Audiences tab of the Ads Dashboard). This file is the
 * "use server" accessor surface.
 *
 * The actual contact-list resolution happens at sync time inside the kernel
 * `syncAudience` command, which translates the SourceRule into the matching
 * contacts/leads and pushes hashed PII to Facebook.
 */

import {
  FB_AUDIENCE_TEMPLATES,
  type AudienceTemplate,
} from "@/lib/ads/fb-audience-templates"

// NOTE: a "use server" file may only export async functions — the AudienceTemplate
// TYPE is imported directly from "@/lib/ads/fb-audience-templates" by consumers, and
// must NOT be re-exported here (RSC strips non-function exports → build error).

/**
 * Read all prebuilt audience templates available to a brokerage. Returns the
 * static catalog for now — future enhancements could let brokerages
 * customize/extend templates and persist to a `audience_templates` table.
 */
export async function listAudienceTemplates(): Promise<AudienceTemplate[]> {
  return FB_AUDIENCE_TEMPLATES
}

// TOMBSTONE (§1.1, 2026-09-03, lane L6): `resolveAudienceTemplate(templateId)` deleted.
// SURVIVOR: the client mapping in app/dashboard/campaigns/ads/ads-dashboard-client.tsx
// `handleUseTemplate` (the "Use template" path), which already holds the full template
// from listAudienceTemplates() and maps name → audienceName, audienceType, sourceRule
// and consentBasis straight into createAudience (lib/ads/facebook-audience-sync.ts) —
// the same four fields this action re-derived from an id the client had already
// resolved, over a server round-trip nothing called. The pure lookup it wrapped survives
// as lib/ads/fb-audience-templates.ts:findAudienceTemplate. This was also an un-gated
// "use server" endpoint; it exposed only the static catalog, no tenant data.
