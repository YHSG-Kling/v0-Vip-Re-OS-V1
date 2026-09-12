'use server';

import { createServiceClient } from '@/lib/supabase/service';
import { resolveTenantAdmin } from '@/lib/auth/resolve-user-role';
// ★ ACT-AS WRITE SEAM ★ — effective (impersonated) identity for the gate;
// read_only impersonation refused before the service-client write.
import { resolveWriteContext } from '@/lib/platform/acting-context';

export async function updateEmailTemplate(id: string, updates: any) {
  const ctx = await resolveWriteContext();
  if (!ctx.ok) return { error: ctx.error };
  if (!ctx.brokerageId) return { error: 'Unauthorized' };
  // Email templates are broker-level config — the create side gates by role, so
  // the update must too (this write uses the service client, RLS-bypassing, which
  // makes THIS gate the only gate).
  //
  // resolveTenantAdmin, not the sync predicate: this action is already async, and
  // "may this person administer this brokerage" is exactly the question
  // public.is_brokerage_admin() answers — which since m466 counts a tenant role
  // GRANT as well as users.user_type. Testing user_type alone refused the live
  // second seat (user_type 'agent' holding an admin grant on their own brokerage)
  // that RLS admits. The ACTING db is passed on purpose: the cookie client for a
  // normal tenant user (RLS still applies to the grant read, via
  // user_role_assignments_select_own), the service client under act-as so the
  // IMPERSONATED identity's grants are readable — the gate is evaluated on that
  // identity, so the investigator never exceeds the seat's authority.
  const admin = await resolveTenantAdmin(ctx.db, ctx.userId, {
    user_type: ctx.userType,
    brokerage_id: ctx.brokerageId,
  });
  // supabase-js RESOLVES a refused query. 'Forbidden' and 'we could not tell' are
  // different answers, and collapsing them tells an administrator they are not one.
  if (!admin.ok) return { error: `Could not resolve your permissions: ${admin.error}` };
  if (!admin.isTenantAdmin) return { error: 'Forbidden' };

  const svc = createServiceClient();

  // Verify the template row belongs to the caller's brokerage before mutating
  const { data: existing, error: existingError } = await svc
    .from('email_templates')
    .select('brokerage_id')
    .eq('id', id)
    .maybeSingle();
  if (existingError) return { error: `Could not check that template: ${existingError.message}` };
  if (!existing) return { error: 'Template not found' };
  if (existing.brokerage_id !== ctx.brokerageId) return { error: 'Forbidden' };

  const { data, error } = await svc
    .from('email_templates')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('brokerage_id', ctx.brokerageId)
    .select()
    .single();

  if (error) {
    console.error('[settings] Error updating email template:', error);
    return { error: 'Failed to update email template' };
  }

  return { data };
}
