import { createClient } from '@/lib/supabase/server';
import { UserContext } from '@/app/types/roles';

export async function getSession() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
}

export async function getUserContext(): Promise<UserContext | null> {
  try {
    const supabase = await createClient();
    
    const {
      data: { user: authUser },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !authUser) {
      return null;
    }

    // Get user profile from public.users table
    const { data: userProfile, error: profileError } = await supabase
      .from('users')
      .select(
        'id, email, user_type, first_name, last_name, brokerage_id, team_id'
      )
      .eq('id', authUser.id)
      .single();

    if (profileError || !userProfile) {
      console.error('[v0] Failed to load user profile:', profileError);
      return null;
    }

    // Get brokerage if exists
    let brokerages = null;
    if (userProfile.brokerage_id) {
      const { data: brokerage } = await supabase
        .from('brokerages')
        .select('id, name')
        .eq('id', userProfile.brokerage_id)
        .single();
      if (brokerage) {
        brokerages = brokerage;
      }
    }

    // Get team if exists
    let teams = null;
    if (userProfile.team_id) {
      const { data: team } = await supabase
        .from('teams')
        .select('id, name')
        .eq('id', userProfile.team_id)
        .single();
      if (team) {
        teams = team;
      }
    }

    return {
      id: userProfile.id,
      email: userProfile.email,
      first_name: userProfile.first_name,
      last_name: userProfile.last_name,
      user_type: userProfile.user_type,
      brokerage_id: userProfile.brokerage_id,
      team_id: userProfile.team_id,
      brokerages,
      teams,
    };
  } catch (error) {
    console.error('[v0] Error getting user context:', error);
    return null;
  }
}
