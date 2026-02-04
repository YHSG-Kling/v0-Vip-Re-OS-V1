'use server'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

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
      error: 'An unexpected error occurred during login',
    }
  }
}

export async function handleAuthCallback(code: string) {
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

    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (error) {
      return {
        success: false,
        error: error.message,
      }
    }

    return {
      success: true,
      user: data.user,
    }
  } catch (error) {
    return {
      success: false,
      error: 'Failed to handle auth callback',
    }
  }
}

export async function signOut() {
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

    await supabase.auth.signOut()

    return {
      success: true,
    }
  } catch (error) {
    return {
      success: false,
      error: 'Failed to sign out',
    }
  }
}

export async function getCurrentUser() {
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

    const {
      data: { user },
    } = await supabase.auth.getUser()

    return user
  } catch (error) {
    return null
  }
}

export async function registerUser(
  email: string,
  password: string,
  firstName: string,
  lastName: string
) {
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

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName,
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
      user: data.user,
    }
  } catch (error) {
    return {
      success: false,
      error: 'An unexpected error occurred during registration',
    }
  }
}
