/**
 * Canonical access scope resolver for Kernel OS architecture.
 * 
 * Ownership contract:
 * - superadmin: platform scope, NO brokerageId required
 * - brokerage users: brokerage scope with brokerageId
 * - team members: team scope with brokerageId + teamId (overlay inside brokerage)
 * - agents: agent scope with brokerageId + agentId + optional teamId
 * 
 * Auth identity: users.id
 * Agent identity: agents.id
 * Bridge: agents.user_id
 */

import { createClient } from '@/lib/supabase/server'

export type AccessScope =
  | { level: 'platform'; userId: string; role: 'superadmin' }
  | { level: 'brokerage'; userId: string; role: string; brokerageId: string }
  | { level: 'team'; userId: string; role: string; brokerageId: string; teamId: string }
  | { level: 'agent'; userId: string; role: string; brokerageId: string; agentId: string; teamId?: string }

/**
 * Resolve the access scope for a user.
 * 
 * Resolution order:
 * 1. Check if user is superadmin (platform_role = 'superadmin') → platform scope
 * 2. Check user_role_assignments for brokerage/team/agent roles
 * 3. Resolve agent via agents.user_id bridge
 * 4. Build scope with all available ownership identifiers
 * 
 * @throws Error if user is not superadmin but cannot resolve brokerageId
 */
export async function resolveAccessScope(userId: string): Promise<AccessScope> {
  const supabase = await createClient()

  // Step 1: Check if user is superadmin (platform scope)
  const { data: user } = await supabase
    .from('users')
    .select('platform_role')
    .eq('id', userId)
    .single()

  if (!user) {
    throw new Error(`[AccessScope] User not found: ${userId}`)
  }

  if (user.platform_role === 'superadmin') {
    return {
      level: 'platform',
      userId,
      role: 'superadmin',
    }
  }

  // Step 2: Get all role assignments for this user
  const { data: roleAssignments } = await supabase
    .from('user_role_assignments')
    .select('role, brokerage_id, team_id, agent_id')
    .eq('user_id', userId)

  if (!roleAssignments || roleAssignments.length === 0) {
    throw new Error(
      `[AccessScope] Non-superadmin user has no role assignments: ${userId}`
    )
  }

  // Step 3: Use first assignment to determine scope level
  // (users should typically have one primary assignment per context)
  const assignment = roleAssignments[0]

  if (!assignment.brokerage_id) {
    throw new Error(
      `[AccessScope] Non-superadmin user missing brokerageId: ${userId}`
    )
  }

  const baseScope = {
    userId,
    role: assignment.role,
    brokerageId: assignment.brokerage_id,
  }

  // Step 4: Determine scope level based on available identifiers
  if (assignment.agent_id) {
    // Agent-level scope (may also have teamId)
    return {
      level: 'agent',
      ...baseScope,
      agentId: assignment.agent_id,
      teamId: assignment.team_id || undefined,
    }
  }

  if (assignment.team_id) {
    // Team-level scope (team is overlay inside brokerage)
    return {
      level: 'team',
      ...baseScope,
      teamId: assignment.team_id,
    }
  }

  // Brokerage-level scope
  return {
    level: 'brokerage',
    ...baseScope,
  }
}

/**
 * Resolve agent ID for a user (auth identity → agent domain identity bridge).
 * 
 * @returns agentId if user is an agent, null if not
 */
export async function resolveAgentId(userId: string): Promise<string | null> {
  const supabase = await createClient()

  const { data: agent } = await supabase
    .from('agents')
    .select('id')
    .eq('user_id', userId)
    .single()

  return agent?.id || null
}

/**
 * Check if scope requires brokerageId.
 * Returns false only for platform scope.
 */
export function scopeRequiresBrokerage(scope: AccessScope): boolean {
  return scope.level !== 'platform'
}

/**
 * Extract brokerageId from scope.
 * Returns null for platform scope only.
 */
export function getScopeBrekerageId(
  scope: AccessScope
): string | null {
  if (scope.level === 'platform') {
    return null
  }
  return scope.brokerageId
}
