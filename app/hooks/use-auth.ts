'use client';

import { useContext } from 'react';
import { AuthContext } from '@/app/context/auth-context';
import { createClient } from '@/lib/supabase/client';

export function useAuth() {
  const session = useContext(AuthContext);

  const signOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  };

  return {
    ...session,
    signOut,
  };
}
