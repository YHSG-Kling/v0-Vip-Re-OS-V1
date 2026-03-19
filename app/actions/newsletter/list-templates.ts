'use server'

import { createClient } from '@/lib/supabase/server'

export async function listTemplates(status?: string) {
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

  // If user has no brokerage, return empty array instead of throwing error
  if (!userData?.brokerage_id) {
    return []
  }

  let query = supabase
    .from('newsletter_brokers_templates')
    .select(
      `
      id,
      template_name,
      template_description,
      brand_colors,
      logo_url,
      approval_status,
      is_default,
      version_number,
      template_tags,
      created_by,
      created_at,
      updated_at,
      sections:newsletter_sections(
        id,
        section_name,
        section_type,
        section_order,
        is_dynamic
      )
    `,
    )
    .eq('brokerage_id', userData.brokerage_id)
    .order('created_at', { ascending: false })

  if (status) {
    query = query.eq('approval_status', status)
  }

  const { data, error } = await query

  if (error) throw new Error(`Failed to fetch templates: ${error.message}`)

  return data || []
}
