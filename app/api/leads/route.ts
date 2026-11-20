import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/kernel/api-auth'
import { resolveLeadVisibility, applyLeadRowScope } from '@/lib/auth/lead-visibility'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // Auth guard — agentId and brokerageId always from session
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(request.url)
  const leadStage = searchParams.get('leadStage')
  const motivationType = searchParams.get('motivationType')
  const limit = parseInt(searchParams.get('limit') || '50')

  // TOMBSTONE (lead-visibility consolidation): the inline `leadVisibleRoles`
  // array that stood here is DELETED. The survivor is
  // lib/auth/lead-visibility.ts:resolveLeadVisibility, which answers admission
  // and ROW SCOPE together.
  //
  // WHAT CHANGED, AND WHY EACH PIECE MOVED:
  //   · team_lead ADMITTED. Owner ruling: "if team tier subscriptions, they
  //     don't have a broker in the subscription so the team lead can see leads."
  //     The comment that used to sit here claimed the exclusion was deliberate;
  //     it is now superseded. The admission is NOT brokerage-wide — the scope
  //     the resolver returns pins a team lead to their own team's rows, and
  //     collapses to brokerage scope only when their team IS the whole tenant.
  //   · 'superadmin' REMOVED as a user_type comparison. Measured: 0 live rows
  //     hold it; the platform's one superadmin is
  //     (user_type='admin', platform_role='superadmin'). Platform staff are now
  //     admitted through isPlatformStaffIdentity inside the resolver, which
  //     reads the column that can hold the answer.
  //   · 'support' REMOVED as a user_type comparison, same reason in reverse: it
  //     is a legal TENANT user_type unconnected to platform employment, so the
  //     entry admitted the wrong people while missing platform support entirely.
  //   · 'broker_admin' REMOVED. It is not a storable user_type (it canonicalizes
  //     to `broker`), so comparing against it here could only ever match
  //     nothing. It survives ONLY inside the roster's input-spelling half.
  const vis = await resolveLeadVisibility(supabase, {
    userId: auth.userId,
    userType: auth.userType,
    platformRole: auth.platformRole,
    brokerageId: auth.brokerageId,
  })
  if (!vis.allowed) {
    // 'unresolved' is NOT 'forbidden': a gate that could not run must refuse
    // loudly rather than silently deny (CLAUDE.md §4).
    return NextResponse.json(
      { error: vis.status === 'forbidden' ? 'forbidden' : vis.reason },
      { status: vis.status === 'forbidden' ? 403 : 500 },
    )
  }

  let query = applyLeadRowScope(
    supabase
      .from('leads')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(limit),
    vis.scope,
  )

  if (leadStage) query = query.eq('lead_stage', leadStage)
  if (motivationType) query = query.eq('motivation_type', motivationType)

  const { data: leads, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    leads: leads || [],
    count: leads?.length || 0,
  })
}
