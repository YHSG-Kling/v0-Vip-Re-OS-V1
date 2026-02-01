'use server'

import { createClient } from '@/lib/supabase/server'

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
    sectionType: 'real_estate_tip' | 'market_update' | 'local_news' | 'agent_feature' | 'property_highlight'
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
          section_type: s.sectionType,
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
