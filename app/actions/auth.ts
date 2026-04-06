'use server'

import { createClient } from '@/lib/supabase/server'

type AuthUserSummary = {
  id: string
  email: string | null
}

type AuthActionResult =
  | { success: true; user: AuthUserSummary }
  | { success: false; error: string }

type RegisterActionResult =
  | {
      success: true
      user: {
        id: string
        email: string | null
      } | null
      needsEmailConfirmation: boolean
    }
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

export async function getCurrentUser(): Promise<AuthUserSummary | null> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser()

    if (error || !user) {
      return null
    }

    return {
      id: user.id,
      email: user.email ?? null,
    }
  } catch (error) {
    console.error('[auth.getCurrentUser] unexpected error:', error)
    return null
  }
}

export async function registerUser(
  email: string,
  password: string,
  firstName: string,
  lastName: string
): Promise<RegisterActionResult> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
        },
      },
    })

    if (error) {
      return {
        success: false,
        error: error.message,
      }
    }

    return {
      success: true,
      user: data.user
        ? {
            id: data.user.id,
            email: data.user.email ?? null,
          }
        : null,
      needsEmailConfirmation: !data.session,
    }
  } catch (error) {
    console.error('[auth.registerUser] unexpected error:', error)
    return {
      success: false,
      error: 'An unexpected error occurred during registration.',
    }
  }
}
