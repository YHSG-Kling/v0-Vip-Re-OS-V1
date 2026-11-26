/**
 * lib/kernel/newsletter/template-blueprint.ts
 *
 * A broker newsletter template's section blueprint — the authored plan for
 * what sections a template renders, in what order, with what prompt and word
 * bounds.
 *
 * WHY IT IS A JSON ENVELOPE ON THE TEMPLATE ROW
 * The per-section table in this schema hangs off newsletter campaigns: its
 * parent column is NOT NULL and its only foreign key targets the campaigns
 * table, so a template has no legitimate parent id to write there. It also
 * has no columns for the authoring fields below — prompt, dynamic flag,
 * placeholder copy, word bounds — so even a renamed write would drop them.
 * The blueprint therefore lives on the template row's own free-text `content`
 * column, and every authored field survives the round trip.
 *
 * WHY THE DISCRIMINATOR EXISTS
 * That `content` column is shared with producers that store plain prose in it
 * (a learning module promoted to a newsletter draft, for example). The
 * discriminator makes the two cases distinguishable with certainty instead of
 * by guesswork: prose does not parse as JSON, and JSON from another producer
 * does not carry this format tag. Readers must use `parseTemplateBlueprint`
 * and treat a null result as "this template has no blueprint", never as
 * "this template has zero sections".
 *
 * Pure module — no I/O, so it is directly unit-testable.
 */

import { normalizeSectionType, type NewsletterSectionType } from './section-types'

/** Format tag stored in the envelope. Bump the suffix if the shape changes so
 *  old rows stay readable by a reader that understands both. */
export const TEMPLATE_BLUEPRINT_FORMAT = 'newsletter_template_sections_v1'

export interface TemplateSectionBlueprint {
  /** Canonical section taxonomy key (lib/kernel/newsletter/section-types.ts). */
  sectionType: NewsletterSectionType
  /** Author-facing name for this slot, e.g. "This Month in Maplewood". */
  sectionName: string
  /** Prompt handed to the writer when the section is generated. */
  aiPrompt: string | null
  /** Render order — lower renders first. */
  sectionOrder: number
  /** True when the section is AI-generated per send rather than static copy. */
  isDynamic: boolean
  /** Copy shown in the builder preview before generation. */
  placeholderText: string | null
  minWords: number | null
  maxWords: number | null
}

export interface TemplateBlueprintEnvelope {
  format: typeof TEMPLATE_BLUEPRINT_FORMAT
  sections: TemplateSectionBlueprint[]
}

function coerceSection(raw: unknown, index: number): TemplateSectionBlueprint | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const sectionName = typeof r.sectionName === 'string' ? r.sectionName : ''
  if (!sectionName) return null
  return {
    sectionType: normalizeSectionType(typeof r.sectionType === 'string' ? r.sectionType : null),
    sectionName,
    aiPrompt: typeof r.aiPrompt === 'string' ? r.aiPrompt : null,
    sectionOrder: typeof r.sectionOrder === 'number' ? r.sectionOrder : index,
    isDynamic: r.isDynamic === true,
    placeholderText: typeof r.placeholderText === 'string' ? r.placeholderText : null,
    minWords: typeof r.minWords === 'number' ? r.minWords : null,
    maxWords: typeof r.maxWords === 'number' ? r.maxWords : null,
  }
}

/**
 * Read a stored `content` value back into a blueprint.
 *
 * Returns null — never an empty array — when the value is absent, is prose, or
 * is JSON written by a different producer. Null means "no blueprint here"; an
 * empty array means "a blueprint that deliberately has no sections". Callers
 * that collapse the two will report a fabricated section count of 0 for
 * templates whose sections simply were not authored through this path.
 */
export function parseTemplateBlueprint(content: unknown): TemplateSectionBlueprint[] | null {
  if (typeof content !== 'string' || content.trim() === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null // prose, not a blueprint
  }

  if (!parsed || typeof parsed !== 'object') return null
  const env = parsed as Record<string, unknown>
  if (env.format !== TEMPLATE_BLUEPRINT_FORMAT) return null
  if (!Array.isArray(env.sections)) return null

  const sections = env.sections
    .map((s, i) => coerceSection(s, i))
    .filter((s): s is TemplateSectionBlueprint => s !== null)
    .sort((a, b) => a.sectionOrder - b.sectionOrder)

  return sections
}
