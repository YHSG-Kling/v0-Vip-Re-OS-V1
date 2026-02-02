'use server'

import { createClient } from '@/lib/supabase/server'
import { DEMO_CONFIG, DEMO_USERS } from '@/app/constants/auth'
import { SignInResponse } from '@/app/types/auth'

/**
 * Demo sign in using password auth
 * Works with your existing Supabase users that have password_hash
 */
export async function demoSignIn(email: string): Promise<SignInResponse> {
  // Check if demo mode is enabled
  if (!DEMO_CONFIG.ENABLED) {
    return {
      success: false,
      error: {
        message: 'Demo mode is not enabled',
        code: 'demo_disabled',
      },
    }
  }

  // Verify email is in demo users list
  const demoUser = DEMO_USERS.find((u) => u.email === email)

  if (!demoUser) {
    return {
      success: false,
      error: {
        message: 'Invalid demo user email',
        code: 'invalid_demo_user',
      },
    }
  }

  try {
    const supabase = await createClient()

    // Use the password that's stored in the database
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email,
      password: DEMO_CONFIG.DEMO_PASSWORD,
    })

    if (error) {
      return {
        success: false,
        error: {
          message: `Authentication failed: ${error.message}`,
          code: error.name,
        },
      }
    }

    if (!data.user) {
      return {
        success: false,
        error: {
          message: 'No user returned from authentication',
          code: 'no_user',
        },
      }
    }

    return {
      success: true,
      data: {
        user: data.user,
        session: data.session,
      },
    }
  } catch (error) {
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        code: 'unexpected_error',
      },
    }
  }
}
