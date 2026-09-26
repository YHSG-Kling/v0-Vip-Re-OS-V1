'use server'

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Deactivation gate — reads the SAME users.status flag that the tenant admin
 * edit form (updateUser) and the superadmin suspend action
 * (setTenantUserStatusAction) write. A 'suspended' user is signed back out and
 * denied a session. Row is keyed by the just-authenticated auth uid.
 */
async function rejectIfSuspended(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<boolean> {
  const svc = createServiceClient()
  const { data: row, error } = await svc
    .from('users')
    .select('status')
    .eq('id', userId)
    .maybeSingle()
  if (error) {
    // Read failure is logged, not fatal — matches existing login resilience.
    console.error('[auth.rejectIfSuspended] status read failed:', error.message)
    return false
  }
  if (row?.status === 'suspended') {
    await supabase.auth.signOut()
    return true
  }
  return false
}

type AuthUserSummary = {
  id: string
  email: string | null
}

type AuthActionResult =
  | { success: true; user: AuthUserSummary }
  | { success: false; error: string }

type CallbackActionResult =
  | { success: true; userId: string; user: AuthUserSummary }
  | {
      success: false
      error: {
        code: string
        message: string
      }
    }

export async function loginUser(
  email: string,
  password: string
): Promise<AuthActionResult> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    if (error) {
      return {
        success: false,
        error: error.message,
      }
    }

    if (!data.user) {
      return {
        success: false,
        error: 'Login failed. No user returned.',
      }
    }

    if (await rejectIfSuspended(supabase, data.user.id)) {
      return {
        success: false,
        error: 'This account has been deactivated. Contact your brokerage administrator.',
      }
    }

    return {
      success: true,
      user: {
        id: data.user.id,
        email: data.user.email ?? null,
      },
    }
  } catch (error) {
    console.error('[auth.loginUser] unexpected error:', error)
    return {
      success: false,
      error: 'An unexpected error occurred during login.',
    }
  }
}

export async function handleAuthCallback(
  code: string
): Promise<CallbackActionResult> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (error) {
      return {
        success: false,
        error: {
          code: error.code ?? 'auth_callback_failed',
          message: error.message,
        },
      }
    }

    if (!data.user) {
      return {
        success: false,
        error: {
          code: 'auth_callback_no_user',
          message: 'No user was returned after exchanging the auth code.',
        },
      }
    }

    if (await rejectIfSuspended(supabase, data.user.id)) {
      return {
        success: false,
        error: {
          code: 'account_suspended',
          message: 'This account has been deactivated. Contact your brokerage administrator.',
        },
      }
    }

    return {
      success: true,
      userId: data.user.id,
      user: {
        id: data.user.id,
        email: data.user.email ?? null,
      },
    }
  } catch (error) {
    console.error('[auth.handleAuthCallback] unexpected error:', error)
    return {
      success: false,
      error: {
        code: 'auth_callback_unexpected',
        message: 'Failed to handle auth callback.',
      },
    }
  }
}

export async function signOut(): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.signOut()

    if (error) {
      return {
        success: false,
        error: error.message,
      }
    }

    return { success: true }
  } catch (error) {
    console.error('[auth.signOut] unexpected error:', error)
    return {
      success: false,
      error: 'Failed to sign out.',
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TWO EXPORTS REMOVED HERE — both collapsed into a NAMED, MORE COMPLETE SURVIVOR.
//
// `getCurrentUser()` returned `{ id, email }` from `supabase.auth.getUser()` and
// nothing else. Both of its would-be callers already have a strict superset:
//   · server side — `lib/auth/permissions.ts:getCurrentUserContext()` returns the
//     same id + email PLUS brokerageId, brokerageName, roleName and capabilities,
//     resolved from the canonical `users` row and `user_role_assignments`.
//   · client side — `lib/auth/useAuth.ts:useAuth()` (imported as
//     "@/lib/auth/client"), which the file's own header names the CANONICAL
//     client-side auth hook and which app-shell, the CRM and the settings
//     sidebar already use.
// Nothing was merged forward: neither survivor was missing anything this held.
//
// `registerUser()` was a bare `supabase.auth.signUp({ email, password })`. The
// platform does not create accounts that way. Every real account is provisioned
// through `app/actions/auth/signup-brokerage.ts:signupBrokerageAction` →
// `provisionTenantOwner`, which creates the auth user FIRST so
// `public.users.id === auth.users.id`, pins the brokerage, creates the teams row
// for a team tenant, gives a solo/team owner their `agents` row, opens the trial
// subscription and sends the magic-link invite. Staff and vendors come in via
// `auth.admin.inviteUserByEmail` (lib/kernel/users.ts, platform-staff.ts,
// vendor-invite.ts). A signUp with none of that produces an auth user whose
// `users` row has no brokerage — untenanted, and therefore invisible to every
// `.eq("brokerage_id", …)` read in the product. `"use server"` also made it a
// public unauthenticated POST endpoint, so it was a way to create accounts that
// skipped the trial funnel, attribution and provisioning entirely.
// Nothing was merged forward: the survivor is a superset in every respect.
// ─────────────────────────────────────────────────────────────────────────────
