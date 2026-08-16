'use server'

import { createClient } from '@/lib/supabase/server'
import {
  normalizeSectionType,
  type NewsletterSectionType,
} from '@/lib/kernel/newsletter/section-types'
import {
  TEMPLATE_BLUEPRINT_FORMAT,
  type TemplateSectionBlueprint,
} from '@/lib/kernel/newsletter/template-blueprint'

export interface CreateTemplateInput {
  templateName: string
  templateDescription?: string
  brandColors: {
    primary: string
    secondary: string
    accent: string
  }
  logoUrl?: string
  sections: Array<{
    /** Canonical taxonomy (m117). Legacy aliases (real_estate_tip,
     *  agent_feature, etc.) are accepted and normalized at insert time. */
    sectionType: NewsletterSectionType | string
    sectionName: string
    aiPrompt?: string
    sectionOrder: number
    isDynamic: boolean
    placeholderText?: string
    minWords?: number
    maxWords?: number
  }>
  templateTags?: string[]
}

// ─── WHERE A BROKER TEMPLATE'S SECTIONS LIVE, AND WHY IT IS ONE STATEMENT ─────
//
// A broker template's sections are persisted as a JSON blueprint on the
// template row's own `content` column, inside a single INSERT. They are NOT
// written to the per-section table, because that table cannot hold them:
//
//   * its parent column is NOT NULL and its only foreign key points at
//     newsletter_campaigns — a template is not a campaign, so there is no
//     legitimate parent id to supply; and
//   * it carries none of the authoring fields a template needs (the prompt,
//     the dynamic flag, the placeholder copy, the word bounds). Only the
//     section type overlaps.
//
// So every authored field is kept — nothing is dropped and no column is
// invented. `content` is a free-text column shared with other producers that
// write plain prose, so the blueprint is wrapped in a discriminated envelope
// (see lib/kernel/newsletter/template-blueprint.ts). A reader that does not
// find the discriminator is looking at prose and must treat it as such; that
// is what makes this unambiguous rather than a guess.
//
// ATOMICITY — this is deliberate, and it is the reason the old rollback is
// gone. Persisting the sections on the template row makes creation a SINGLE
// row write: it either lands whole or it does not land at all, with no
// partial state to repair. The previous shape did a parent INSERT, then a
// child INSERT, and on child failure DELETED the parent it had just created.
// That converts a recoverable partial save into destroyed work, and it is
// unsound besides — the delete is itself a write that can be refused, leaving
// exactly the orphan it was meant to prevent while the caller is told the
// whole operation failed. One statement removes the failure mode instead of
// compensating for it.
// ─────────────────────────────────────────────────────────────────────────────

export async function createTemplate(input: CreateTemplateInput) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .maybeSingle()

  if (userError) throw new Error(`Failed to fetch user: ${userError.message}`)
  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  const templateName = input.templateName?.trim()
  if (!templateName) throw new Error('Template name is required')

  // Name collision check. maybeSingle, because "no row yet" is the expected
  // answer here and must not surface as an error; a real refusal still does.
  const { data: existing, error: existingError } = await supabase
    .from('newsletter_brokers_templates')
    .select('id')
    .eq('brokerage_id', userData.brokerage_id)
    .eq('template_name', templateName)
    .maybeSingle()

  if (existingError) {
    throw new Error(`Could not check existing templates: ${existingError.message}`)
  }
  if (existing) throw new Error(`Template "${templateName}" already exists for your brokerage`)

  // Normalize the authored sections into the stored blueprint shape. Ordering
  // is taken from the authored sectionOrder when supplied, and falls back to
  // authoring position so two sections never collapse onto one slot.
  const sections: TemplateSectionBlueprint[] = (input.sections ?? []).map((s, i) => ({
    sectionType: normalizeSectionType(s.sectionType),
    sectionName: s.sectionName,
    aiPrompt: s.aiPrompt ?? null,
    sectionOrder: typeof s.sectionOrder === 'number' ? s.sectionOrder : i,
    isDynamic: s.isDynamic === true,
    placeholderText: s.placeholderText ?? null,
    minWords: typeof s.minWords === 'number' ? s.minWords : null,
    maxWords: typeof s.maxWords === 'number' ? s.maxWords : null,
  }))

  const { data: created, error: templateError } = await supabase
    .from('newsletter_brokers_templates')
    .insert({
      brokerage_id: userData.brokerage_id,
      template_name: templateName,
      name: templateName,
      template_description: input.templateDescription,
      brand_colors: input.brandColors,
      logo_url: input.logoUrl,
      created_by: user.id,
      approval_status: 'draft',
      status: 'draft',
      template_tags: input.templateTags || [],
      content: JSON.stringify({
        format: TEMPLATE_BLUEPRINT_FORMAT,
        sections,
      }),
    })
    .select('id')

  if (templateError) throw new Error(`Failed to create template: ${templateError.message}`)

  // A write refused by row-level security comes back as zero rows with a null
  // error, so a resolved promise is not evidence that anything was stored.
  // Count the returned rows; that is the only proof the row exists.
  if (!created || created.length !== 1) {
    throw new Error(
      'The template was not saved. Your account does not have permission to create ' +
        'templates for this brokerage, or the request was rejected before it was stored.',
    )
  }

  return {
    success: true,
    templateId: created[0].id as string,
    sectionCount: sections.length,
    message: `Template created with ${sections.length} section${sections.length === 1 ? '' : 's'}`,
  }
}
