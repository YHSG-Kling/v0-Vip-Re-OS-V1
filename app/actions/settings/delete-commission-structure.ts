'use server';

import { createServiceClient } from '@/lib/supabase/service';
// ★ ACT-AS WRITE SEAM ★ — see create-commission-structure.ts: effective
// (impersonated) identity for the gate, read_only refused before the
// service-client delete, role predicate unchanged.
import { resolveWriteContext } from '@/lib/platform/acting-context';

// Role gate roster, tested against the EFFECTIVE identity's users.user_type
// (ctx.userType below — the impersonated seat's own user_type under act-as).
const DELETE_ROLES = ['broker', 'broker_owner', 'admin', 'superadmin'];

export async function deleteCommissionStructure(id: string) {
  const ctx = await resolveWriteContext();
  if (!ctx.ok) return { error: ctx.error };
  if (!ctx.brokerageId) return { error: 'Unauthorized' };
  if (!DELETE_ROLES.includes(ctx.userType ?? '')) return { error: 'Forbidden' };

  const svc = createServiceClient();

  // Verify the commission structure belongs to the caller's brokerage before deleting
  const { data: existing, error: existingError } = await svc
    .from('commission_structures')
    .select('brokerage_id')
    .eq('id', id)
    .maybeSingle();
  if (existingError) return { error: `Could not check that structure: ${existingError.message}` };
  if (!existing) return { error: 'Commission structure not found' };
  if (existing.brokerage_id !== ctx.brokerageId) return { error: 'Forbidden' };

  // Zero rows deleted is a refusal, not success — count what actually happened.
  const { data: deleted, error } = await svc
    .from('commission_structures')
    .delete()
    .eq('id', id)
    .eq('brokerage_id', ctx.brokerageId)
    .select('id');

  if (error) {
    console.error('[settings] Error deleting commission structure:', error);
    return { error: 'Failed to delete commission structure' };
  }
  if (!deleted || deleted.length === 0) {
    return { error: 'Commission structure not found in your brokerage' };
  }

  return { success: true };
}
