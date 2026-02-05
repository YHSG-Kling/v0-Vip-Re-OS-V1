'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export async function signUp(email: string, firstName: string, lastName: string, userType: string) {
  const supabase = await createClient();

  // Sign up with Supabase Auth (password-based for now, can be changed to magic link)
  const { data: authData, error: signUpError } = await supabase.auth.signUp({
    email,
    password: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2), // Random password
    options: {
      data: {
        first_name: firstName,
        last_name: lastName,
        user_type: userType,
      },
    },
  });

  if (signUpError) {
    return { error: signUpError.message };
  }

  if (!authData.user) {
    return { error: 'User creation failed' };
  }

  // Create user profile in public.users table
  const { error: profileError } = await supabase.from('users').insert([
    {
      id: authData.user.id,
      email,
      first_name: firstName,
      last_name: lastName,
      user_type: userType,
    },
  ]);

  if (profileError) {
    console.error('[v0] Failed to create user profile:', profileError);
    return { error: 'Failed to create user profile' };
  }

  // Send magic link for verification
  const { error: linkError } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
    },
  });

  if (linkError) {
    console.error('[v0] Failed to send magic link:', linkError);
    return { error: linkError.message };
  }

  return { success: true, message: 'Check your email for the magic link' };
}

export async function signIn(email: string) {
  const supabase = await createClient();

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/auth/callback`,
    },
  });

  if (error) {
    console.error('[v0] Magic link error:', error);
    return { error: error.message };
  }

  return { success: true, message: 'Check your email for the magic link' };
}

export async function signInWithPassword(email: string, password: string) {
  const supabase = await createClient();

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    console.error('[v0] Password login error:', error);
    return { error: error.message };
  }

  return { success: true };
}

export async function handleAuthCallback(code: string) {
  const supabase = await createClient();

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('[v0] Callback error:', error);
    return { error: error.message };
  }

  redirect('/dashboard');
}

export async function getUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
