'use server'

/**
 * READER (orphan doctrine §1.2) for tenant_transition_log — the immutable
 * cross-tenant audit log (migration 038) that app/api/recruiting/provision-agent
 * writes on every provisioning outcome (allowed AND denied-cross-brokerage AND
 * denied-email-collision) and nothing ever read back. Six columns
 * (action, actor_user_id, entity_id, entity_type, row_count_moved, metadata —
 * schema-snapshot.ts:638) were write-only.
 *
 * Platform-only by construction, matching the table's own shape: it has no
 * single brokerage_id (from_brokerage_id/to_brokerage_id instead — a
 * cross-tenant event has no one tenant to scope a reader to), so this reads
 * the same way listSuperadminAuditLogAction reads superadmin_audit_log —
 * gated on the 'staff' platform capability, never a brokerage session.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { requirePlatformCapability } from '@/lib/platform/require-capability'

export interface TenantTransitionLogRow {
  id: string
  action: string
  entityType: string
  entityId: string
  actorUserId: string | null
  fromBrokerageId: string | null
  toBrokerageId: string | null
  rowCountMoved: number | null
  metadata: Record<string, unknown>
  at: string
}

export async function listTenantTransitionLogAction(limit = 200): Promise<
  | { ok: true; rows: TenantTransitionLogRow[] }
  | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability('staff')
  if (!gate.ok) return { ok: false, error: 'Forbidden — platform staff only' }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from('tenant_transition_log')
    .select('id, action, entity_type, entity_id, actor_user_id, from_brokerage_id, to_brokerage_id, row_count_moved, metadata, at')
    .order('at', { ascending: false })
    .limit(Math.min(limit, 500))
  if (error) return { ok: false, error: error.message }

  return {
    ok: true,
    rows: ((data ?? []) as Array<{
      id: string; action: string; entity_type: string; entity_id: string
      actor_user_id: string | null; from_brokerage_id: string | null; to_brokerage_id: string | null
      row_count_moved: number | null; metadata: Record<string, unknown> | null; at: string
    }>).map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      actorUserId: r.actor_user_id,
      fromBrokerageId: r.from_brokerage_id,
      toBrokerageId: r.to_brokerage_id,
      rowCountMoved: r.row_count_moved,
      metadata: r.metadata ?? {},
      at: r.at,
    })),
  }
}

// recruiting_manager's own row_count_moved confirmation lives INLINE at the
// write site (app/api/recruiting/provision-agent/route.ts, immediately after
// the tenant_transition_log insert) — the same request that wrote the row
// reads it straight back via .select(), which is a tighter confirmation than
// a second round-trip through this action could offer. No second reader
// built here (§1.3 — the functionality already lives at the write site).
