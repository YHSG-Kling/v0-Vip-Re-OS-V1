import { createClient } from '@/lib/supabase/server'
import { resolveUserBrokerageId } from '@/lib/activities/activity-tenant'

/**
 * RBAC — Resource-level access control
 *
 * Uses users.user_type as the canonical role source.
 * Does not write to old *_access_control tables (they do not exist).
 * Relies on RLS for real data access enforcement.
 *
 * ── THE AUDIT WRITE HAD NEVER FIRED ─────────────────────────────────────────
 *
 * `logActivity()` used to be a VOID function whose whole body was
 *
 *     supabase.from('activities').insert({ … })
 *
 * with no `await` and no `.then()`. A supabase-js `PostgrestBuilder` is a
 * THENABLE, not a promise: it issues its HTTP request from `then()` and from
 * nowhere else. An expression statement never calls `then()`, so the request was
 * never sent. Six call sites in this file, zero rows ever written — confirmed
 * live: `select count(*) from activities where activity_type = 'permission_check'`
 * returned **0** on a database with 24 activities rows.
 *
 * ── OWNER RULING: LOG DENIALS ONLY ──────────────────────────────────────────
 *
 * The write now actually executes, and it fires ONLY where the permission check
 * fails. The three grant branches below log nothing at all. Rationale (owner's):
 * the denial is the forensically interesting event, and denial-only makes audit
 * volume proportional to attacks rather than to traffic. Do not "restore" the
 * grant logging — its absence is a decision, not an omission.
 *
 * ── WHY THE ROW IS STAMPED EXPLICITLY ───────────────────────────────────────
 *
 * `activities.brokerage_id` is NOT NULL with no default. The BEFORE-INSERT
 * trigger `activities_set_brokerage` does have an `agent_user_id → users` branch
 * that this row's anchor matches, so this is not a branch gap — but the trigger
 * is SECURITY INVOKER (`prosecdef = false`), so that lookup runs under the
 * INSERTING CALLER's RLS, and `users.brokerage_id` is NULLABLE besides. Either
 * hole leaves `NEW.brokerage_id` NULL, and NULL into a NOT NULL column is a
 * REFUSED insert (SQLSTATE 23502) that supabase-js resolves as success. So the
 * tenant is resolved through the record and stamped here, and `error` is
 * destructured and acted on. Resolver reused from `lib/activities/activity-tenant`
 * rather than written a fourth time.
 *
 * Where no tenant can be resolved, NO ROW IS ATTEMPTED and the refusal reason
 * goes to the console instead — the same posture as
 * `lib/lead-readiness/readiness-logger.ts`. A row we know will be refused is not
 * an audit trail; it is a log line that lies about having been persisted.
 */

export async function requirePermission(
  action: string,
  resourceType: string,
  resourceId: string
): Promise<void> {
  const supabase = await createClient()

  // 1. Get authenticated user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // 2. If no user, throw "Not authenticated"
  //
  // This IS a denial, and it is deliberately NOT written to `activities`: there
  // is no user, therefore no `users` row, therefore no resolvable tenant, and
  // `activities.brokerage_id` is NOT NULL. The console is the only honest place
  // for it. (Anonymous callers reaching a gated server action are also the class
  // of traffic most able to flood an audit table.)
  if (!user) {
    console.error(
      `[RBAC] DENIED (unauthenticated): ${action} ${resourceType} ${resourceId} — not recorded to activities, ` +
        `an anonymous caller has no users row and therefore no tenant to satisfy activities.brokerage_id NOT NULL`,
    )
    throw new Error('Not authenticated')
  }

  // 3. Query users table for user_type
  //
  // `error` is destructured because supabase-js RESOLVES a refused read: without
  // it, "you may not read this row" and "there is no such row" are the same
  // `undefined`, and the difference decides whether the denial below is a policy
  // outcome or a broken read. It is carried into the audit row rather than
  // guessed at.
  const { data: userData, error: userErr } = await supabase
    .from('users')
    .select('user_type')
    .eq('id', user.id)
    .maybeSingle()

  const userType = (userData as { user_type?: string } | null)?.user_type

  // 4. If user_type is 'broker' or 'admin', allow
  if (userType === 'broker' || userType === 'admin') return

  // 5. If user_type is 'compliance_officer' and action is 'read' and resourceType in allowed list, allow
  if (
    userType === 'compliance_officer' &&
    action === 'read' &&
    ['document', 'contact', 'transaction'].includes(resourceType)
  ) {
    return
  }

  // 6. If user_type is 'TC' and resourceType is 'transaction', allow
  if (userType === 'TC' && resourceType === 'transaction') return

  // 7. NOT GRANTED. Return without throwing and let RLS enforce real data access.
  //
  // This is the denial branch — the only one that writes. The function's
  // non-throwing contract is UNCHANGED: four call sites
  // (app/actions/lead-intelligence.ts x3, app/actions/ai-chat.ts x1) rely on
  // falling through to RLS, and turning this into a throw is a product decision
  // that was not made here.
  await writeDenialAudit(supabase, user.id, {
    action,
    resourceType,
    resourceId,
    user_type: userType ?? null,
    result: 'deferred_to_rls',
    // Named, not collapsed into the line above: a refused users read produces the
    // same `user_type: null` as a user genuinely missing a row, and only one of
    // those is a fact about the caller's permissions.
    user_type_read_refused: userErr ? userErr.message : null,
  })
}

export async function autoGrantAccess(
  resourceType: string,
  resourceId: string,
  userId: string,
  userType: string,
  permissions: {
    canEdit?: boolean
    canViewFinancials?: boolean
    canShare?: boolean
    accessLevel?: string
    roleInTransaction?: string
    grantedBy?: string
    expiresAt?: Date
  }
) {
  const supabase = await createClient()

  // Do not write to any access-control tables (they do not exist).
  //
  // This is NOT one of the permission-check grants the owner ruled unlogged —
  // it is an explicit ACL mutation, and `getResourceAccessList()` below reads
  // exactly these rows back. Dropping the write would leave that reader
  // permanently empty by construction.
  await writeAccessLedgerRow(supabase, userId, 'access_granted', {
    resourceType,
    resourceId,
    userId,
    userType,
    permissions,
  })
}

export async function revokeAccess(
  resourceType: string,
  resourceId: string,
  userId: string,
  revokedBy: string,
  reason?: string
) {
  const supabase = await createClient()

  await writeAccessLedgerRow(supabase, userId, 'access_revoked', {
    resourceType,
    resourceId,
    userId,
    revokedBy,
    reason: reason ?? 'Access revoked',
  })
}

export async function batchGrantAccess(
  resourceType: string,
  resourceId: string,
  userIds: string[],
  userType: string,
  permissions: {
    canEdit?: boolean
    canViewFinancials?: boolean
    accessLevel?: string
    roleInTransaction?: string
    grantedBy?: string
  }
) {
  // Call autoGrantAccess for each user
  for (const userId of userIds) {
    await autoGrantAccess(resourceType, resourceId, userId, userType, permissions)
  }
}

export async function getResourceAccessList(resourceType: string, resourceId: string) {
  const supabase = await createClient()

  try {
    // Return activities rows where activity_type = 'access_granted'
    // Filter by metadata.resourceType and metadata.resourceId
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .eq('activity_type', 'access_granted')
      .contains('metadata', { resourceType, resourceId })

    if (error) {
      console.error('[RBAC] Error fetching access list:', error)
      return []
    }

    return data ?? []
  } catch {
    // Return empty array on error
    return []
  }
}

/**
 * THE one `activities` insert in this file.
 *
 * Kept as a single site on purpose: `scripts/ai-insight-tenant-guard.ts` pins
 * this file at one activities write, and one write means one place where the
 * tenant stamp and the `error` check can be got wrong.
 *
 * `userId` is a **users.id** — the column it lands in is `agent_user_id`, which
 * FKs `users`. It is never an `agents.id`; those spaces are disjoint and nothing
 * here bridges them.
 *
 * Returns nothing, but is `async` and MUST be awaited by every caller. The whole
 * defect this replaces was a call that returned a thenable nobody awaited.
 */
async function writeAuditRow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  label: string,
  userId: string,
  activityType: string,
  title: string,
  metadata: Record<string, unknown>
): Promise<void> {
  // TENANT, resolved through the record (the acting user), before the write.
  // Resolved HERE rather than on the grant path so the extra round trip is paid
  // only where a row is actually about to be written — which, under the
  // denials-only ruling, is proportional to attacks rather than to traffic.
  const tenant = await resolveUserBrokerageId(supabase, userId)

  if (!tenant.ok || !tenant.brokerageId) {
    console.error(
      `[RBAC] ${label} for user ${userId} NOT recorded: ${
        tenant.ok ? 'user carries no brokerage_id' : tenant.reason
      } — refusing to attempt an insert that cannot satisfy activities.brokerage_id NOT NULL ` +
        `(${JSON.stringify(metadata)})`,
    )
    return
  }

  const { error } = await supabase.from('activities').insert({
    // Explicit stamp. activities_set_brokerage would match this row's
    // agent_user_id anchor, but it is SECURITY INVOKER and users.brokerage_id is
    // nullable, so the trigger is a best-effort net and not a guarantee.
    brokerage_id: tenant.brokerageId,
    agent_user_id: userId,
    activity_type: activityType,
    title,
    metadata,
    status: 'completed',
    created_at: new Date().toISOString(),
  })

  // Destructured and acted on. supabase-js RESOLVES a refused write, so without
  // this the function reports success over a row that was never written — which
  // is exactly how six call sites produced zero rows for the lifetime of this file.
  if (error) {
    console.error(`[RBAC] ${label} insert REFUSED for user ${userId}: ${error.message}`, metadata)
  }
}

/** Permission DENIED — the only outcome of a permission check that is recorded. */
function writeDenialAudit(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  return writeAuditRow(
    supabase,
    'permission denial',
    userId,
    'permission_check',
    `Permission denied: ${String(metadata.action)} ${String(metadata.resourceType)}`,
    metadata,
  )
}

/** Explicit ACL grant/revoke — read back by getResourceAccessList(). */
function writeAccessLedgerRow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  activityType: 'access_granted' | 'access_revoked',
  metadata: Record<string, unknown>
): Promise<void> {
  return writeAuditRow(
    supabase,
    activityType,
    userId,
    activityType,
    `${activityType === 'access_granted' ? 'Access granted' : 'Access revoked'}: ${String(
      metadata.resourceType,
    )}`,
    metadata,
  )
}
