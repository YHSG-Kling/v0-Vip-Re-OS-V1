import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { declarableContactType } from '@/lib/lead-magnets/form-contact-types'

export const dynamic = 'force-dynamic'

/**
 * The columns a form admin may change through this door (wave 142, lane 142E). This PATCH used to apply the
 * request body VERBATIM (`.update(body)`) — a mass-assignment door that could rewrite agent_id, slug,
 * magnet_type, landing_content or clobber the settings bag (lifecycle / authoring / book) with one key. The
 * survivor builder (the lead-magnet workspace) writes through its own actions; this door stays resolving for
 * any remaining caller, allow-listed, with `settings` MERGED (only default_contact_type is settable here).
 */
const PATCHABLE = new Set(['name', 'fields', 'tcpa_disclosure_text', 'redirect_url', 'thank_you_message', 'is_active'])

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('users')
    .select('user_type, brokerage_id')
    .eq('id', user.id)
    .single()

  if (!profile || !isAdminOrBroker({ user_type: profile.user_type })) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json() as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body ?? {})) if (PATCHABLE.has(k)) patch[k] = v
  if (typeof patch.is_active !== 'undefined' && typeof patch.is_active !== 'boolean') delete patch.is_active

  if (body && typeof body.settings === 'object' && body.settings !== null) {
    const { data: cur, error: curErr } = await supabase
      .from('lead_capture_forms')
      .select('settings')
      .eq('id', id)
      .eq('brokerage_id', profile.brokerage_id)
      .maybeSingle()
    if (curErr) return NextResponse.json({ success: false, error: curErr.message }, { status: 500 })
    const { default_contact_type: _prior, ...rest } = (((cur as { settings?: Record<string, unknown> | null } | null)?.settings ?? {}) as Record<string, unknown>)
    const declared = declarableContactType((body.settings as { default_contact_type?: unknown }).default_contact_type)
    patch.settings = declared ? { ...rest, default_contact_type: declared } : rest
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ success: false, error: 'No patchable fields in the body' }, { status: 400 })
  patch.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from('lead_capture_forms')
    .update(patch)
    .eq('id', id)
    .eq('brokerage_id', profile.brokerage_id)
    .select('id')

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  // A zero-row match is a refusal, not a success (CLAUDE.md §3).
  if ((data ?? []).length !== 1) {
    return NextResponse.json({ success: false, error: 'Form not found in this brokerage' }, { status: 404 })
  }

  return NextResponse.json({ success: true })
}
