'use server'

import { createClient } from '@/lib/supabase/server'

export interface UpdateTemplateInput {
  templateId: string
  templateName?: string
  templateDescription?: string
  brandColors?: {
    primary: string
    secondary: string
    accent: string
  }
  logoUrl?: string
  isDefault?: boolean
  templateTags?: string[]
}

export async function updateTemplate(input: UpdateTemplateInput) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Verify template belongs to user's brokerage
  const { data: template } = await supabase
    .from('newsletter_brokers_templates')
    .select('id')
    .eq('id', input.templateId)
    .eq('brokerage_id', userData.brokerage_id)
    .single()

  if (!template) throw new Error('Template not found or access denied')

  // Update template
  const { error: updateError } = await supabase
    .from('newsletter_brokers_templates')
    .update({
      template_name: input.templateName,
      template_description: input.templateDescription,
      brand_colors: input.brandColors,
      logo_url: input.logoUrl,
      is_default: input.isDefault,
      template_tags: input.templateTags,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.templateId)

  if (updateError) throw new Error(`Failed to update template: ${updateError.message}`)

  return {
    success: true,
    message: 'Template updated successfully',
  }
}
