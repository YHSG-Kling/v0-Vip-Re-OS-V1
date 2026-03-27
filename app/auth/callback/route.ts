import { NextRequest, NextResponse } from 'next/server'
import { handleAuthCallback } from '@/app/actions/auth'
import { AUTH_ROUTES } from '@/app/constants/auth'
import { createServiceClient } from '@/lib/supabase/service'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')
  // `next` is set by invite emails to signal desired post-auth destination
  const next = searchParams.get('next')

  // Handle errors from Supabase
  if (error) {
    const message = errorDescription?.includes('expired')
      ? 'link-expired'
      : errorDescription?.includes('used')
      ? 'link-used'
      : 'error'

    return NextResponse.redirect(
      new URL(`/login?message=${message}`, request.url)
    )
  }

  // No code provided
  if (!code) {
    return NextResponse.redirect(new URL('/login?message=error', request.url))
  }

  // Exchange code for session
  const result = await handleAuthCallback(code)

  if (!result.success) {
    const message = result.error?.code || 'error'
    return NextResponse.redirect(
      new URL(`/login?message=${message}`, request.url)
    )
  }

  // ── First-login onboarding redirect ────────────────────────────────────────
  // If the invite email included ?next=/dashboard/onboarding, honour it
  // directly — this is the primary mechanism for new broker/admin accounts.
  if (next && next.startsWith('/')) {
    return NextResponse.redirect(new URL(next, request.url))
  }

  // Secondary safety net: if the signed-in user is an admin/broker with a
  // not_started onboarding record, send them to onboarding regardless of how
  // they arrived (e.g. old invite link missing the `next` param).
  try {
    const service = createServiceClient()
    const { data: { user } } = await service.auth.admin.getUserById(result.userId ?? '')
    if (user) {
      const { data: profile } = await service
        .from('users')
        .select('user_type')
        .eq('id', user.id)
        .maybeSingle()

      if (profile?.user_type === 'admin' || profile?.user_type === 'broker') {
        const { data: onboarding } = await service
          .from('agent_onboarding')
          .select('status, completion_percentage')
          .eq('user_id', user.id)
          .maybeSingle()

        if (
          !onboarding ||
          onboarding.status === 'not_started' ||
          (onboarding.completion_percentage ?? 0) === 0
        ) {
          return NextResponse.redirect(new URL('/dashboard/onboarding', request.url))
        }
      }
    }
  } catch {
    // Non-fatal — fall through to default dashboard route
  }

  // Default: role-based routing happens at /dashboard
  return NextResponse.redirect(new URL('/dashboard', request.url))
}
