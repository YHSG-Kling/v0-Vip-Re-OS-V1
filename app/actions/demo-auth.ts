// app/actions/demo-auth.ts
// Server actions for demo user authentication

'use server';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { DEMO_USERS, DEMO_CONFIG, AUTH_MESSAGES } from '@/app/constants/auth';

/**
 * Sign in with demo user email
 */
export async function demoSignIn(userEmail: string) {
  if (!DEMO_CONFIG.ENABLED) {
    return {
      success: false,
      error: 'Demo mode is not enabled',
    };
  }

  // Find demo user
  const demoUser = DEMO_USERS.find(
    (user) => user.email.toLowerCase() === userEmail.toLowerCase()
  );

  if (!demoUser) {
    return {
      success: false,
      error: 'Demo user not found',
    };
  }

  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value;
          },
          set(name: string, value: string, options: any) {
            cookieStore.set(name, value, options);
          },
          remove(name: string, options: any) {
            cookieStore.delete(name);
          },
        },
      }
    );

    // Try to sign in
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: demoUser.email,
      password: demoUser.password,
    });

    if (!signInError && signInData.user) {
      // Sign in successful
      return {
        success: true,
        user: {
          id: signInData.user.id,
          email: signInData.user.email,
          firstName: demoUser.firstName,
          lastName: demoUser.lastName,
          role: demoUser.role,
        },
      };
    }

    // User might not exist, try to create them
    if (signInError && signInError.message.includes('Invalid login credentials')) {
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: demoUser.email,
        password: demoUser.password,
      });

      if (signUpError) {
        return {
          success: false,
          error: `Failed to create demo account: ${signUpError.message}`,
        };
      }

      if (!signUpData.user) {
        return {
          success: false,
          error: 'Failed to create user account',
        };
      }

      // Store demo user profile
      const { error: profileError } = await supabase
        .from('user_profiles')
        .upsert(
          {
            id: signUpData.user.id,
            email: demoUser.email,
            first_name: demoUser.firstName,
            last_name: demoUser.lastName,
            role: demoUser.role,
            agency: demoUser.agency,
            specialization: demoUser.specialization,
            state: demoUser.state,
            is_demo: true,
            created_at: new Date().toISOString(),
          },
          { onConflict: 'id' }
        );

      if (profileError) {
        console.error('Profile creation error:', profileError);
      }

      return {
        success: true,
        user: {
          id: signUpData.user.id,
          email: demoUser.email,
          firstName: demoUser.firstName,
          lastName: demoUser.lastName,
          role: demoUser.role,
        },
        isNewAccount: true,
      };
    }

    return {
      success: false,
      error: signInError?.message || 'Authentication failed',
    };
  } catch (error: any) {
    console.error('Demo sign in error:', error);
    return {
      success: false,
      error: error.message || AUTH_MESSAGES.SIGN_IN_ERROR,
    };
  }
}

/**
 * Sign out current user
 */
export async function demoSignOut() {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value;
          },
          set(name: string, value: string, options: any) {
            cookieStore.set(name, value, options);
          },
          remove(name: string, options: any) {
            cookieStore.delete(name);
          },
        },
      }
    );

    const { error } = await supabase.auth.signOut();

    if (error) {
      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: true,
      message: AUTH_MESSAGES.SIGN_OUT_SUCCESS,
    };
  } catch (error: any) {
    console.error('Demo sign out error:', error);
    return {
      success: false,
      error: error.message || 'Sign out failed',
    };
  }
}

/**
 * Get all demo users (for demo selection UI)
 */
export async function getDemoUsers() {
  if (!DEMO_CONFIG.ENABLED) {
    return [];
  }

  return DEMO_USERS.map((user) => ({
    id: user.id,
    email: user.email,
    name: `${user.firstName} ${user.lastName}`,
    role: user.role,
    agency: user.agency,
    specialization: user.specialization,
    state: user.state,
  }));
}

/**
 * Get demo users grouped by role
 */
export async function getDemoUsersByRole() {
  if (!DEMO_CONFIG.ENABLED) {
    return {};
  }

  const grouped: Record<string, typeof DEMO_USERS> = {};

  DEMO_USERS.forEach((user) => {
    if (!grouped[user.role]) {
      grouped[user.role] = [];
    }
    grouped[user.role].push(user);
  });

  return grouped;
}

/**
 * Validate demo credentials (for testing)
 */
export async function validateDemoCredentials(email: string, password: string) {
  const user = DEMO_USERS.find(
    (u) => u.email.toLowerCase() === email.toLowerCase()
  );

  if (!user) {
    return { valid: false, reason: 'User not found' };
  }

  if (user.password !== password) {
    return { valid: false, reason: 'Invalid password' };
  }

  return {
    valid: true,
    user: {
      id: user.id,
      email: user.email,
      name: `${user.firstName} ${user.lastName}`,
      role: user.role,
    },
  };
}
