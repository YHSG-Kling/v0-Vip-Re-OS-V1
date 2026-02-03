'use server';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { DEMO_USERS, DEMO_CONFIG } from '@/app/constants/auth';

export async function demoSignIn(userEmail: string) {
  // Validate demo mode is enabled
  if (!DEMO_CONFIG.ENABLED) {
    return {
      success: false,
      error: 'Demo mode is not enabled',
    };
  }

  // Find user in demo users
  const demoUser = DEMO_USERS.find(
    (user) => user.email.toLowerCase() === userEmail.toLowerCase()
  );

  if (!demoUser) {
    return {
      success: false,
      error: 'Demo user not found. Check email and try again.',
      availableUsers: DEMO_USERS.map((u) => ({
        email: u.email,
        name: `${u.firstName} ${u.lastName}`,
        role: u.role,
      })),
    };
  }

  try {
    // Create Supabase client
    const cookieStore = cookies();
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

    // Sign in with demo user
    const { data, error } = await supabase.auth.signInWithPassword({
      email: demoUser.email,
      password: demoUser.password,
    });

    if (error) {
      // If user doesn't exist in Supabase yet, create them
      if (error.message.includes('Invalid login credentials')) {
        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
          email: demoUser.email,
          password: demoUser.password,
        });

        if (signUpError) {
          return {
            success: false,
            error: `Sign up failed: ${signUpError.message}`,
          };
        }

        // Store additional user data in custom table
        const { error: profileError } = await supabase
          .from('user_profiles')
          .upsert({
            id: signUpData.user?.id,
            email: demoUser.email,
            firstName: demoUser.firstName,
            lastName: demoUser.lastName,
            role: demoUser.role,
            agency: demoUser.agency,
            specialization: demoUser.specialization,
            state: demoUser.state,
            isDemo: true,
            createdAt: new Date().toISOString(),
          });

        if (profileError) {
          console.error('Profile creation error:', profileError);
        }

        return {
          success: true,
          user: {
            id: signUpData.user?.id,
            email: demoUser.email,
            firstName: demoUser.firstName,
            lastName: demoUser.lastName,
            role: demoUser.role,
          },
          message: 'Demo account created successfully',
        };
      }

      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: true,
      user: {
        id: data.user?.id,
        email: data.user?.email,
        firstName: demoUser.firstName,
        lastName: demoUser.lastName,
        role: demoUser.role,
      },
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Authentication failed',
    };
  }
}

export async function demoSignOut() {
  try {
    const cookieStore = cookies();
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
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Sign out failed',
    };
  }
}

export async function getDemoUsers() {
  if (!DEMO_CONFIG.ENABLED) {
    return [];
  }

  return DEMO_USERS.map((user) => ({
    email: user.email,
    name: `${user.firstName} ${user.lastName}`,
    role: user.role,
    agency: user.agency,
    specialization: user.specialization,
  }));
}
