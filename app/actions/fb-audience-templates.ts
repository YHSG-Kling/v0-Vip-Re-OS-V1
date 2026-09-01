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

import type { SourceRule, AudienceType } from "@/lib/kernel/ads"
import {
  FB_AUDIENCE_TEMPLATES,
  findAudienceTemplate,
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

/**
 * Resolve a template id to its create-audience parameters, ready for
 * `createAudience` (lib/ads/facebook-audience-sync.ts). Caller passes the
 * resolved params on through.
 *
 * Was `createFacebookAudience` until 2026-09-01, when that duplicate export was
 * deleted onto its survivor — the tombstone naming it is at the top of
 * lib/ads/facebook-audience-sync.ts. A comment naming a function that no longer
 * exists sends the next reader looking for a door that was deliberately closed.
 */
export async function resolveAudienceTemplate(templateId: string): Promise<{
  audienceName: string
  audienceType: AudienceType
  sourceRule: SourceRule
  consentBasis: string
} | null> {
  const tpl = findAudienceTemplate(templateId)
  if (!tpl) return null
  return {
    audienceName: tpl.name,
    audienceType: tpl.audienceType,
    sourceRule: tpl.sourceRule,
    consentBasis: tpl.consentBasis,
  }
}
