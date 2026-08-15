'use server'

// NOTE: This action's INSERT/SELECT statements still reference columns that
// do not exist on the live newsletter_sections schema today (section_name,
// section_order, is_dynamic, ai_prompt_template, placeholder_text, min/max_words)
// AND on newsletter_brokers_templates (template_name, brand_colors, etc.). A
// follow-up wave will either (a) add those columns + a newsletter_template_id
// FK so sections can belong to a template instead of a campaign, OR
// (b) collapse the template path onto a campaign-with-draft-status pattern.
// This file updates ONLY the sectionType vocabulary to the canonical
// newsletter section taxonomy (lib/kernel/newsletter/section-types.ts) so the
// UI no longer hardcodes the legacy 5-value Template Builder union.

import { createClient } from '@/lib/supabase/server'
import {
  normalizeSectionType,
  type NewsletterSectionType,
} from '@/lib/kernel/newsletter/section-types'

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

export async function createTemplate(input: CreateTemplateInput) {
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Get user's brokerage from users table
  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (userError) throw new Error(`Failed to fetch user: ${userError.message}`)
  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Check if template name already exists for this brokerage
  const { data: existing } = await supabase
    .from('newsletter_brokers_templates')
    .select('id')
    .eq('brokerage_id', userData.brokerage_id)
    .eq('template_name', input.templateName)
    .single()

  if (existing) throw new Error(`Template "${input.templateName}" already exists for your brokerage`)

  // Create template
  const { data: template, error: templateError } = await supabase
    .from('newsletter_brokers_templates')
    .insert({
      brokerage_id: userData.brokerage_id,
      template_name: input.templateName,
      template_description: input.templateDescription,
      brand_colors: input.brandColors,
      logo_url: input.logoUrl,
      created_by: user.id,
      approval_status: 'draft',
      template_tags: input.templateTags || [],
    })
    .select()
    .single()

  if (templateError) throw new Error(`Failed to create template: ${templateError.message}`)

  // Create sections
  if (input.sections.length > 0) {
    const { error: sectionsError } = await supabase
      .from('newsletter_sections')
      .insert(
        input.sections.map(s => ({
          newsletter_template_id: template.id,
          section_name: s.sectionName,
          section_type: normalizeSectionType(s.sectionType),
          ai_prompt_template: s.aiPrompt,
          section_order: s.sectionOrder,
          is_dynamic: s.isDynamic,
          placeholder_text: s.placeholderText,
          min_words: s.minWords,
          max_words: s.maxWords,
        })),
      )

    if (sectionsError) {
      // Rollback: delete template if sections fail
      await supabase.from('newsletter_brokers_templates').delete().eq('id', template.id)
      throw new Error(`Failed to create sections: ${sectionsError.message}`)
    }
  }

  return {
    success: true,
    templateId: template.id,
    message: 'Template created successfully',
  }
}
