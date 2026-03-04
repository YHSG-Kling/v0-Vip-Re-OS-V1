import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('user_type, brokerage_id')
    .eq('user_id', user.id)
    .single()

  if (!profile || !['admin', 'broker', 'superadmin'].includes(profile.user_type)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json() as {
    name: string
    slug: string
    fields: unknown
    tcpa_disclosure_text: string
    redirect_url?: string
    thank_you_message?: string
  }

  const { data: form, error } = await supabase
    .from('lead_capture_forms')
    .insert({
      brokerage_id: profile.brokerage_id,
      name: body.name,
      slug: body.slug,
      fields: body.fields,
      tcpa_disclosure_text: body.tcpa_disclosure_text,
      redirect_url: body.redirect_url || null,
      thank_you_message: body.thank_you_message || null,
      is_active: true,
      submission_count: 0,
    })
    .select('id, name, slug, is_active, submission_count, created_at, fields, tcpa_disclosure_text, redirect_url, thank_you_message')
    .single()

  if (error || !form) {
    return NextResponse.json({ success: false, error: error?.message ?? 'Insert failed' }, { status: 500 })
  }

  return NextResponse.json({ success: true, form })
}
