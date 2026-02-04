'use server'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function loginUser(email: string, password: string) {
  try {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
      {
        cookies: {
          get: (name) => cookieStore.get(name)?.value,
          set: (name, value, options) => {
            cookieStore.set(name, value, options)
          },
          remove: (name, options) => {
            cookieStore.delete(name)
          },
        },
      }
    )

    // Attempt to sign in
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      return {
        success: false,
        error: error.message,
      }
    }

    if (!data.user || !data.session) {
      return {
        success: false,
        error: 'Login failed. No user data returned.',
      }
    }

    return {
      success: true,
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    }
  } catch (error) {
    return {
      success: false,
      error: 'An unexpected error occurred',
    }
  }
}

// Helper function
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email) && email.length <= 254
}
