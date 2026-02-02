'use server'

import { createServerAuthClient } from '@/lib/supabase/server'
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
    const supabase = await createServerAuthClient()

    // Sign in using password (your demo users use 'DEMO_USER' as password)
    const { data, error } = await supabase.auth.signInWithPassword({
      email: demoUser.email,
      password: DEMO_CONFIG.DEMO_PASSWORD,
    })

    if (error) {
      console.error('Demo sign in error:', error)
      return {
        success: false,
        error: {
          message: error.message || 'Demo login failed',
          code: error.code || 'auth_error',
        },
      }
    }

    if (!data.user) {
      return {
        success: false,
        error: {
          message: 'No user returned from auth',
          code: 'no_user',
        },
      }
    }

    return {
      success: true,
      message: `Demo login as ${demoUser.role}`,
    }
  } catch (err) {
    console.error('Demo sign in error:', err)
    return {
      success: false,
      error: {
        message: 'Demo login failed',
        code: 'demo_error',
      },
    }
  }
}

/**
 * Get all demo users (for demo user selector)
 */
export function getDemoUsers() {
  if (!DEMO_CONFIG.ENABLED) {
    return []
  }

  return DEMO_USERS.map((user) => ({
    email: user.email,
    name: user.name,
    role: user.role,
    description: user.description,
  }))
}
