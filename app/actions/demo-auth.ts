'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { DEMO_CONFIG, DEMO_USERS } from '@/app/constants/auth'

/**
 * One-click demo login - creates session for demo users without password
 * Demo users exist in public.users, we find their auth record and create a session
 */
export async function demoSignIn(email: string) {
  console.log('[v0] Demo sign in attempt for:', email)
  
  // Check if demo mode is enabled
  if (!DEMO_CONFIG.ENABLED) {
    console.log('[v0] Demo mode disabled')
    return redirect('/login?error=demo_disabled')
  }

  // Verify email is in demo users list
  const demoUser = DEMO_USERS.find((u) => u.email === email)
  if (!demoUser) {
    console.log('[v0] Email not in demo users list')
    return redirect('/login?error=invalid_demo_user')
  }

  try {
    const supabase = await createClient()

    // Get the user from public.users table
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('id, email, first_name, last_name')
      .eq('email', email)
      .single()

    if (userError || !userData) {
      console.log('[v0] User not found in public.users:', userError)
      return redirect('/login?error=user_not_found')
    }

    console.log('[v0] Found user in database:', userData.id)

    // Try to sign in with the demo password
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password: DEMO_CONFIG.DEMO_PASSWORD,
    })

    if (authError) {
      console.log('[v0] Auth error:', authError.message)
      return redirect(`/login?error=${encodeURIComponent(authError.message)}`)
    }

    if (!authData.session) {
      console.log('[v0] No session created')
      return redirect('/login?error=no_session')
    }

    console.log('[v0] Demo login successful for:', email)
    
    // Redirect to dashboard on success
    return redirect('/dashboard')
  } catch (error) {
    console.log('[v0] Unexpected error:', error)
    return redirect('/login?error=unexpected_error')
  }
}
