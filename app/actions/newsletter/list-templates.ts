'use server'

import { createClient } from '@/lib/supabase/server'
import { parseTemplateBlueprint } from '@/lib/kernel/newsletter/template-blueprint'

export async function listTemplates(status?: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // supabase-js RESOLVES a refused read, so `const { data }` alone reports an
  // RLS denial as "this user has no brokerage" and the caller shows an empty
  // template list. That is a different statement from the truth and must not be
  // silent.
  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (userError) throw new Error(`Failed to resolve brokerage: ${userError.message}`)

  // If user has no brokerage, return empty array instead of throwing error
  if (!userData?.brokerage_id) {
    return []
  }

  // ── WHY SECTIONS ARE NOT AN EMBED HERE ─────────────────────────────────────
  // A template's sections are not rows in the per-section table and cannot be:
  // that table's parent column is NOT NULL and its only foreign key targets
  // newsletter campaigns, so PostgREST has no relationship to embed across and
  // answered an embedded select with PGRST200 — which failed the WHOLE query
  // and left the Template Builder showing zero templates for every brokerage.
  //
  // The sections live on the template row's own `content` column as a
  // discriminated JSON blueprint (see create-template.ts and
  // lib/kernel/newsletter/template-blueprint.ts). So they are selected as an
  // ordinary column and decoded below — no relationship required.
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
      content,
      created_by,
      created_at,
      updated_at
    `,
    )
    .eq('brokerage_id', userData.brokerage_id)
    .order('created_at', { ascending: false })

  if (status) {
    query = query.eq('approval_status', status)
  }

  const { data, error } = await query

  if (error) throw new Error(`Failed to fetch templates: ${error.message}`)

  // `sections` is null — not [] — for a template whose content is prose or was
  // written by another producer. Null means "this template has no blueprint to
  // show"; an empty array would claim it was authored with zero sections. The
  // UI must be able to tell those apart instead of printing a made-up 0.
  return (data || []).map(({ content, ...template }) => ({
    ...template,
    sections: parseTemplateBlueprint(content),
  }))
}
