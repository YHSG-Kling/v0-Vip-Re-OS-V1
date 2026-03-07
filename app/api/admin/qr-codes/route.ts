import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

function generateSlug(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const suffix = Math.random().toString(36).slice(2, 7)
  return `${base}-${suffix}`
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const supabaseAuth = await createClient()
    const { data: { user } } = await supabaseAuth.auth.getUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await req.json()) as {
      label: string
      purpose: string
      agentUserId: string
      brokerageId: string
    }

    const { label, purpose, agentUserId, brokerageId } = body
    if (!label || !brokerageId) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }

    const supabase = createServiceClient()
    const slug = generateSlug(label)

    const { data: qrCode, error } = await supabase
      .from('qr_codes')
      .insert({
        slug,
        label,
        purpose,
        agent_user_id: agentUserId,
        brokerage_id: brokerageId,
        is_active: true,
        scan_count: 0,
        lead_count: 0,
      })
      .select('id, slug, label, purpose, scan_count, lead_count, is_active, created_at')
      .single()

    if (error || !qrCode) {
      return NextResponse.json({ success: false, error: error?.message ?? 'Failed to create QR code' }, { status: 500 })
    }

    return NextResponse.json({ success: true, qrCode })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
