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

  // Verify template belongs to user's brokerage — and read the fields the
  // version bump below compares against.
  const { data: template } = await supabase
    .from('newsletter_brokers_templates')
    .select('id, version_number, brand_colors, logo_url')
    .eq('id', input.templateId)
    .eq('brokerage_id', userData.brokerage_id)
    .single()

  if (!template) throw new Error('Template not found or access denied')

  // Version bump (2026-09-01): the UI renders "v{version_number}" badges
  // (template-builder.tsx:581, marketing-studio-client.tsx:4746) but nothing
  // ever incremented the column — every template read "v1" forever. Same rule
  // as the platform contract precedent (app/actions/superadmin/
  // subscription-contracts.ts:125): a CONTENT revision bumps the version;
  // metadata (name, description, tags, default flag) does not — the badge
  // tells the reader "the rendered template changed", not "someone renamed it".
  const contentChanged =
    (input.brandColors !== undefined &&
      JSON.stringify(input.brandColors) !== JSON.stringify(template.brand_colors ?? null)) ||
    (input.logoUrl !== undefined && input.logoUrl !== (template.logo_url ?? undefined))
  const nextVersion = (template.version_number ?? 1) + (contentChanged ? 1 : 0)

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
      version_number: nextVersion,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.templateId)

  if (updateError) throw new Error(`Failed to update template: ${updateError.message}`)

  return {
    success: true,
    message: 'Template updated successfully',
  }
}
