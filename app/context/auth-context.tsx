'use client';

import React, { createContext, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { UserContext, AuthSession } from '@/app/types/roles';

export const AuthContext = createContext<AuthSession>({
  user: null as any,
  isAuthenticated: false,
  isLoading: true,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession>({
    user: null as any,
    isAuthenticated: false,
    isLoading: true,
  });

  const supabase = createClient();

  useEffect(() => {
    const loadSession = async () => {
      try {
        console.log('[v0] Loading auth session...');
        
        // Get auth user
        const {
          data: { user: authUser },
        } = await supabase.auth.getUser();

        if (!authUser) {
          console.log('[v0] No authenticated user found');
          setSession({
            user: null as any,
            isAuthenticated: false,
            isLoading: false,
          });
          return;
        }

        console.log('[v0] Auth user found, loading profile...');

        // Get user profile with all details
        const { data: userProfile, error } = await supabase
          .from('users')
          .select(
            'id, email, user_type, first_name, last_name, brokerage_id, team_id'
          )
          .eq('id', authUser.id)
          .single();

        if (error || !userProfile) {
          console.error('[v0] Error fetching user profile:', error);
          setSession({
            user: null as any,
            isAuthenticated: false,
            isLoading: false,
            error: 'Failed to load user profile',
          });
          return;
        }

        console.log('[v0] User profile loaded:', userProfile);

        const userContext: UserContext = {
          id: userProfile.id,
          email: userProfile.email,
          first_name: userProfile.first_name,
          last_name: userProfile.last_name,
          user_type: userProfile.user_type,
          brokerage_id: userProfile.brokerage_id,
          team_id: userProfile.team_id,
        };

        setSession({
          user: userContext,
          isAuthenticated: true,
          isLoading: false,
        });
      } catch (error) {
        console.error('[v0] Auth error:', error);
        setSession({
          user: null as any,
          isAuthenticated: false,
          isLoading: false,
          error: 'Authentication error',
        });
      }
    };

    loadSession();

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      console.log('[v0] Auth state changed:', event);
      
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        loadSession();
      } else if (event === 'SIGNED_OUT') {
        setSession({
          user: null as any,
          isAuthenticated: false,
          isLoading: false,
        });
      }
    });

    return () => {
      subscription?.unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={session}>
      {children}
    </AuthContext.Provider>
  );
}
