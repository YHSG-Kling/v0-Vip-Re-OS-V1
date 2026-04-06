'use server'

import { createClient } from '@/lib/supabase/server'
import { getAgentContext } from '@/lib/identity/get-agent-context'
import { AUTH_MESSAGES } from '@/app/constants/auth'

type ActionError = {
  message: string
  code?: string
}

type LoginResult =
  | { success: true; user: { id: string; email: string | null }; role: string; brokerageId: string | null }
  | { success: false; error: ActionError }

type CallbackResult =
  | { success: true; userId: string; email: string | null }
  | { success: false; error: ActionError }

type RegisterResult =
  | { success: true; user: { id: string; email: string | null }; needsEmailConfirmation: boolean }
  | { success: false; error: ActionError }

function normalizeAuthError(error: unknown, fallbackMessage: string): ActionError {
  if (error && typeof error === 'object' && 'message' in error) {
    const e = error as { message?: string; code?: string }
    return {
      message: e.message || fallbackMessage,
      code: e.code,
    }
  }

  return { message: fallbackMessage }
}

export async function loginUser(email: string, password: string): Promise<LoginResult> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      return {
        success: false,
        error: normalizeAuthError(error, AUTH_MESSAGES.SIGN_IN_ERROR),
      }
    }

    if (!data.user) {
      return {
        success: false,
        error: { message: AUTH_MESSAGES.SIGN_IN_ERROR },
      }
    }

    const ctx = await getAgentContext()

    return {
      success: true,
      user: {
        id: data.user.id,
        email: data.user.email ?? null,
      },
      role: ctx.isAuthenticated ? ctx.userType : ((data.user.user_metadata?.user_type as string | undefined) ?? 'agent'),
      brokerageId: ctx.isAuthenticated ? ctx.brokerageId : ((data.user.user_metadata?.brokerage_id as string | undefined) ?? null),
    }
  } catch (error) {
    return {
      success: false,
      error: normalizeAuthError(error, 'An unexpected error occurred during login'),
    }
  }
}

export async function handleAuthCallback(code: string): Promise<CallbackResult> {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (error) {
      return {
        success: false,
        error: normalizeAuthError(error, 'Failed to exchange auth code for session'),
      }
    }

    if (!data.user) {
      return {
        success: false,
        error: { message: 'No authenticated user returned from callback', code: 'no_user' },
      }
    }

    return {
      success: true,
      userId: data.user.id,
      email: data.user.email ?? null,
    }
  } catch (error) {
    return {
      success: false,
      error: normalizeAuthError(error, 'Failed to handle auth callback'),
    }
  }
}

export async function signOut(): Promise<{ success: boolean; error?: ActionError }> {
  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.signOut()

    if (error) {
      return {
        success: false,
        error: normalizeAuthError(error, AUTH_MESSAGES.SIGN_OUT_ERROR),
      }
    }

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: normalizeAuthError(error, 'Failed to sign out'),
    }
  }
}

export async function getCurrentUser() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser()

    if (error) return null
    return user ?? null
  } catch {
    return null
  }
}

export async function registerUser(
  email: string,
  password: string,
  firstName: string,
  lastName: string
): Promise<RegisterResult> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName,
          full_name: `${firstName} ${lastName}`.trim(),
        },
      },
    })

    if (error) {
      return {
        success: false,
        error: normalizeAuthError(error, AUTH_MESSAGES.SIGN_UP_ERROR),
      }
    }

    if (!data.user) {
      return {
        success: false,
        error: { message: AUTH_MESSAGES.SIGN_UP_ERROR },
      }
    }

    return {
      success: true,
      user: {
        id: data.user.id,
        email: data.user.email ?? null,
      },
      needsEmailConfirmation: !data.session,
    }
  } catch (error) {
    return {
      success: false,
      error: normalizeAuthError(error, 'An unexpected error occurred during registration'),
    }
  }
}
