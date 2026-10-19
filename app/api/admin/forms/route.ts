import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { createLeadMagnet, defaultFieldsForType, type LeadMagnetField } from '@/lib/kernel/lead-magnets'
import { declarableContactType } from '@/lib/lead-magnets/form-contact-types'

export const dynamic = 'force-dynamic'

/**
 * TOMBSTONE (wave 142, lane 142E — orphan doctrine §1.1): this door used to be a SECOND WRITER of
 * lead_capture_forms — a raw insert (no magnet_type, is_active true on create, no lifecycle / authoring record,
 * no audit echo) behind the retired admin Forms Manager builder. SURVIVOR: lib/kernel/lead-magnets.ts
 * createLeadMagnet (the ONE writer; the lead-magnet workspace is the builder). The route stays resolving as a
 * THIN DOOR onto that command for any caller that still posts here: tenant and actor from the SESSION (never
 * the body's brokerage_id), the body's fields mapped onto the kernel's field shape, the declared persona onto
 * settings.default_contact_type. Created LIVE (the caller is the approver), as this door always did.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
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
  if (!profile.brokerage_id) return NextResponse.json({ success: false, error: 'No brokerage on this account' }, { status: 403 })

  // lead_capture_forms.agent_id is agents.id (disjoint from users.id, CLAUDE.md §3).
  const { data: agentRow, error: agentErr } = await supabase
    .from('agents')
    .select('id')
    .eq('user_id', user.id)
    .eq('brokerage_id', profile.brokerage_id)
    .maybeSingle()
  if (agentErr) return NextResponse.json({ success: false, error: `agent record unreadable: ${agentErr.message}` }, { status: 500 })
  if (!agentRow?.id) return NextResponse.json({ success: false, error: 'No agent profile for this user — complete onboarding to create forms.' }, { status: 403 })

  const body = await req.json() as {
    name: string
    fields?: unknown
    tcpa_disclosure_text?: string
    redirect_url?: string
    thank_you_message?: string
    settings?: { default_contact_type?: string | null } | null
  }
  if (!body?.name?.trim()) return NextResponse.json({ success: false, error: 'name required' }, { status: 400 })

  // The old builder's field shape ({ key, label, type, required, options, placeholder }) onto the kernel's
  // ({ name, … }); the canonical identity fields are always present (never removed by a caller's list).
  const canonical = defaultFieldsForType('generic_form')
  const supplied: LeadMagnetField[] = Array.isArray(body.fields)
    ? (body.fields as Array<Record<string, unknown>>)
        .map((f) => ({
          name: String(f.name ?? f.key ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40),
          label: String(f.label ?? '').trim().slice(0, 80),
          type: String(f.type ?? 'text'),
          required: f.required === true,
          ...(Array.isArray(f.options) ? { options: (f.options as unknown[]).map(String).slice(0, 8) } : {}),
          ...(typeof f.placeholder === 'string' && f.placeholder ? { placeholder: f.placeholder.slice(0, 80) } : {}),
        }))
        .filter((f) => f.name && f.label)
    : []
  const extras = supplied.filter((f) => !canonical.some((c) => c.name === f.name))
  const declared = declarableContactType(body.settings?.default_contact_type)

  const result = await createLeadMagnet({
    title: body.name.trim(),
    description: '',
    magnetType: 'generic_form',
    brokerageId: profile.brokerage_id,
    agentId: agentRow.id,
    createdBy: user.id,
    fields: [...canonical, ...extras],
    tcpaDisclosureText: body.tcpa_disclosure_text || undefined,
    redirectUrl: body.redirect_url || undefined,
    thankYouMessage: body.thank_you_message || undefined,
    publishState: 'live',
    settings: {
      authoring: { by: 'human', requested_by: user.id, generated_at: new Date().toISOString(), from_ai_copy: false, door: 'api/admin/forms' },
      ...(declared ? { default_contact_type: declared } : {}),
    },
  })
  if (!result.success || !result.magnetId) {
    return NextResponse.json({ success: false, error: result.error ?? 'Create refused' }, { status: 500 })
  }

  const { data: form, error } = await supabase
    .from('lead_capture_forms')
    .select('id, name, slug, is_active, submission_count, created_at, fields, tcpa_disclosure_text, redirect_url, thank_you_message, settings')
    .eq('id', result.magnetId)
    .eq('brokerage_id', profile.brokerage_id)
    .maybeSingle()
  if (error || !form) {
    return NextResponse.json({ success: true, form: { id: result.magnetId, slug: result.slug, name: body.name.trim() } })
  }
  return NextResponse.json({ success: true, form })
}
