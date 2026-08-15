'use server'

import { createClient } from '@/lib/supabase/server'

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

  // ── WHY THERE IS NO `sections` EMBED HERE ──────────────────────────────────
  // This select used to embed `sections:newsletter_sections(id, section_name,
  // section_type, section_order, is_dynamic)`. THREE of those five columns do
  // not exist — the live newsletter_sections is (id, newsletter_id, title,
  // content, order_index, created_at, target_personas, brokerage_id,
  // section_type, target_locations) — but renaming them would not have saved
  // the query, because the EMBED ITSELF is unresolvable:
  //
  //   newsletter_sections has exactly two foreign keys —
  //     newsletter_sections_newsletter_id_fkey -> newsletter_campaigns(id)
  //     newsletter_sections_brokerage_id_fkey  -> brokerages(id)
  //
  // There is no FK to newsletter_brokers_templates, no template_id column to
  // build one from, and no junction table referencing both. PostgREST resolves
  // embeds from that FK graph, so it answered this whole query with PGRST200
  // ("could not find a relationship") and the Template Builder screen loaded
  // ZERO templates and toasted "Failed to load newsletter templates" — for
  // every brokerage, always. Sections were never the missing part; the template
  // list was.
  //
  // A newsletter section belongs to a CAMPAIGN in this schema, not to a broker
  // template. So the honest fix is to drop the embed and let the surface
  // degrade (the template card no longer claims a section count) rather than
  // invent a relationship or hand back a fabricated empty array. Restoring the
  // capability needs a migration that gives newsletter_sections a
  // newsletter_template_id FK — see the note in create-template.ts, whose
  // INSERT writes exactly that non-existent column today.
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

  return data || []
}
