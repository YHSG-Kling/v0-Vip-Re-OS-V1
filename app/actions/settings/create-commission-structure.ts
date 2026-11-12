'use server';

import { createServiceClient } from '@/lib/supabase/service';
// ★ ACT-AS WRITE SEAM ★ — the gate resolves the EFFECTIVE identity (the
// impersonated seat under an active FULL grant) instead of the raw auth user's
// row, which under act-as is the staff row (NULL brokerage) and refused every
// call. read_only impersonation is refused before the service-client write,
// which this gate alone protects. The role predicate (user_type) is unchanged
// and is evaluated on the IMPERSONATED identity.
import { resolveWriteContext } from '@/lib/platform/acting-context';

const CREATE_ROLES = ['broker', 'broker_owner', 'admin', 'superadmin'];

export async function createCommissionStructure(structure: any) {
  const ctx = await resolveWriteContext();
  if (!ctx.ok) return { error: ctx.error };
  if (!ctx.brokerageId) return { error: 'Unauthorized' };
  if (!CREATE_ROLES.includes(ctx.userType ?? '')) return { error: 'Forbidden' };

  // Strip any caller-supplied brokerage_id and stamp from session
  const { id: _droppedId, brokerage_id: _droppedBrokerage, ...safeStructure } = structure ?? {};

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('commission_structures')
    .insert({
      ...safeStructure,
      brokerage_id: ctx.brokerageId,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    console.error('[settings] Error creating commission structure:', error);
    return { error: 'Failed to create commission structure' };
  }

  return { data };
}
