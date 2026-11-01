import { NextRequest, NextResponse } from 'next/server'
import { handleAuthCallback } from '@/app/actions/auth'
import { createServiceClient } from '@/lib/supabase/service'
import { acceptUserInvitationOnFirstLogin } from '@/lib/onboarding/state-machine'
import { toMagicLinkMessage, type MagicLinkMessage } from '@/app/types/auth'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')
  // `next` is set by invite emails to signal desired post-auth destination
  const next = searchParams.get('next')

  // Handle errors from Supabase.
  //
  // ANNOTATED, NOT INFERRED: this string is read back by app/login/page.tsx
  // through `toMagicLinkMessage`, which refuses anything outside the roster.
  // Before the reader existed nothing noticed a drifted spelling — the page
  // rendered nothing either way. Now a spelling that is not in the vocabulary
  // fails at type-check instead of silently going blank in front of a user.
  if (error) {
    const message: MagicLinkMessage = errorDescription?.includes('expired')
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
    // `result.error.code` is whatever supabase-js handed back ('otp_expired',
    // 'flow_state_not_found', …) — a provider vocabulary, not this rail's. Put
    // it through the same gate the reader uses so only a value the login page
    // can actually render reaches the URL; anything else degrades to 'error',
    // which at least says something true to the user.
    const message: MagicLinkMessage = toMagicLinkMessage(result.error?.code) ?? 'error'
    return NextResponse.redirect(
      new URL(`/login?message=${message}`, request.url)
    )
  }

  // ── Invitation acceptance hook ────────────────────────────────────────────
  // If this user has a pending user_invitations row (created by inviteUser),
  // mark it accepted now and advance the brokerage onboarding state machine.
  // Idempotent — no-ops on subsequent logins.
  try {
    const service = createServiceClient()
    const { data: { user } } = await service.auth.admin.getUserById(result.userId ?? '')
    if (user?.email) {
      const { data: profile } = await service
        .from('users')
        .select('brokerage_id')
        .eq('id', user.id)
        .maybeSingle()
      // A failed acceptance post-condition is REPORTED by the state machine itself (wave 148, lane 148A —
      // reportOperationOutcome `invitation`); the result is logged here so the request log carries it too.
      const accepted = await acceptUserInvitationOnFirstLogin({
        userId:      user.id,
        email:       user.email,
        brokerageId: profile?.brokerage_id ?? null,
      })
      if (accepted.error) console.error(`[auth/callback] invitation acceptance failed for ${user.id}: ${accepted.error}`)
    }
  } catch (err) {
    // Non-fatal for the redirect (the session already exists) — but never SILENT: an empty catch here hid every
    // first-login acceptance failure (wave 148, lane 148A). The state machine reports its own post-condition.
    console.error("[auth/callback] invitation acceptance hook threw:", (err as Error)?.message ?? String(err))
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
  } catch (err) {
    // Non-fatal — fall through to default dashboard route (which DETECTS an incomplete account and routes a visible
    // setup state). Logged, not silent (wave 148, lane 148A).
    console.warn("[auth/callback] onboarding redirect check failed — routing to /dashboard:", (err as Error)?.message ?? String(err))
  }

  // Default: role-based routing happens at /dashboard
  return NextResponse.redirect(new URL('/dashboard', request.url))
}
