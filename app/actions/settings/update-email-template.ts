'use server';

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { resolveTenantAdmin } from '@/lib/auth/resolve-user-role';

export async function updateEmailTemplate(id: string, updates: any) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle();
  if (!userData?.brokerage_id) return { error: 'Unauthorized' };
  // Email templates are broker-level config — the create side gates by role, so
  // the update must too (this write uses the service client, RLS-bypassing, which
  // makes THIS gate the only gate).
  //
  // resolveTenantAdmin, not the sync predicate: this action is already async, and
  // "may this person administer this brokerage" is exactly the question
  // public.is_brokerage_admin() answers — which since m466 counts a tenant role
  // GRANT as well as users.user_type. Testing user_type alone refused the live
  // second seat (user_type 'agent' holding an admin grant on their own brokerage)
  // that RLS admits. The SESSION client is passed on purpose: RLS still applies to
  // the grant read, and user_role_assignments_select_own is what permits it.
  const admin = await resolveTenantAdmin(supabase, user.id, userData);
  // supabase-js RESOLVES a refused query. 'Forbidden' and 'we could not tell' are
  // different answers, and collapsing them tells an administrator they are not one.
  if (!admin.ok) return { error: `Could not resolve your permissions: ${admin.error}` };
  if (!admin.isTenantAdmin) return { error: 'Forbidden' };

  const svc = createServiceClient();

  // Verify the template row belongs to the caller's brokerage before mutating
  const { data: existing } = await svc
    .from('email_templates')
    .select('brokerage_id')
    .eq('id', id)
    .maybeSingle();
  if (!existing) return { error: 'Template not found' };
  if (existing.brokerage_id !== userData.brokerage_id) return { error: 'Forbidden' };

  const { data, error } = await svc
    .from('email_templates')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('brokerage_id', userData.brokerage_id)
    .select()
    .single();

  if (error) {
    console.error('[settings] Error updating email template:', error);
    return { error: 'Failed to update email template' };
  }

  return { data };
}
