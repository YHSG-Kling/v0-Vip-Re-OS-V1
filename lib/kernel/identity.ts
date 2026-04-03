// lib/kernel/identity.ts
// LAYER 0 — Canonical identity resolution for all server actions and pages.
//
// Single export: resolveWriteContext()
//
// Wraps getAgentContext() and adds:
//   • FK-correct agentId (via agents.user_id lookup, not users.id)
//   • ActorContext shape for compliance/lifecycle calls
//   • Hard redirect guards (returns null when not authenticated)
//
// Rule: every Server Action that writes data MUST call resolveWriteContext()
// first and abort when the result is null.
//
// Import from '@/lib/kernel' — never import this file directly outside the kernel.

"use server"

import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { createClient } from "@/lib/supabase/server"
import type { ActorContext, ActorRole } from "./types"

// ─── TYPES ────────────────────────────────────────────────────────────────────

/**
 * Full write context resolved from the current session.
 * All fields are guaranteed non-null when isAuthenticated = true.
 */
export interface WriteContext {
  /** auth.users.id */
  userId: string
  /** agents.id — null only for non-agent roles (broker, admin, tc…) */
  agentId: string | null
  /** users.brokerage_id */
  brokerageId: string
  /** users.user_type (canonical) — never use .role outside the kernel */
  userType: string
  /** Shape required by evaluateOutbound() and enforceLifecycle() */
  actorContext: ActorContext
  isAuthenticated: true
}

/**
 * Returned when the session is missing or the user row doesn't exist.
 * Callers should redirect to /login when this is returned.
 */
export interface UnauthenticatedWriteContext {
  isAuthenticated: false
}

export type WriteContextResult = WriteContext | UnauthenticatedWriteContext

// ─── INTERNAL HELPERS ────────────────────────────────────────────────────────

const VALID_ACTOR_ROLES = new Set<ActorRole>([
  "superadmin", "broker", "admin", "team_lead", "agent",
  "isa", "tc", "compliance_officer", "vendor", "lender", "title_agent",
  "contact", "system",
])

function toActorRole(raw: string): ActorRole {
  return VALID_ACTOR_ROLES.has(raw as ActorRole)
    ? (raw as ActorRole)
    : "agent"
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * resolveWriteContext
 *
 * Resolves the full write context for the current authenticated session.
 * Returns null-safe UnauthenticatedWriteContext when not signed in.
 *
 * FK safety guarantees:
 *   • agentId is resolved via agents.user_id — never set to users.id directly
 *   • brokerageId falls back to first available brokerage for superadmins
 *
 * Usage in a Server Action:
 * ```ts
 * const ctx = await resolveWriteContext()
 * if (!ctx.isAuthenticated) return { error: "Unauthenticated" }
 * // ctx.userId, ctx.agentId, ctx.brokerageId, ctx.actorContext are safe to use
 * ```
 */
export async function resolveWriteContext(): Promise<WriteContextResult> {
  try {
    // Step 1: get base context from identity layer
    const context = await getAgentContext()
    if (!context.isAuthenticated || !context.userId) {
      return { isAuthenticated: false }
    }

    const supabase = await createClient()

    // Step 2: resolve correct agentId via FK-safe lookup (agents.user_id = users.id)
    // getAgentContext already does this for agent-type users, but we re-confirm here
    // so all other roles (broker, tc, admin) also get null correctly.
    let agentId: string | null = context.agentId
    if (!agentId && context.userType === "agent") {
      agentId = await resolveAgentId(supabase, context.userId)
    }

    // Step 3: resolve brokerageId — superadmins may have null brokerage_id in users row.
    // For superadmins without a brokerage, fall back to the first available brokerage.
    let brokerageId = context.brokerageId
    if (!brokerageId) {
      const { data: firstBrokerage } = await supabase
        .from("brokerages")
        .select("id")
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()
      brokerageId = firstBrokerage?.id ?? null
    }

    // If still no brokerage — context is unusable for writes
    if (!brokerageId) {
      return { isAuthenticated: false }
    }

    // Step 4: build ActorContext for compliance/lifecycle calls
    const actorContext: ActorContext = {
      userId:      context.userId,
      role:        toActorRole(context.userType),
      brokerageId: brokerageId,
    }

    return {
      isAuthenticated: true,
      userId:      context.userId,
      agentId,
      brokerageId,
      userType:    context.userType,
      actorContext,
    }
  } catch {
    return { isAuthenticated: false }
  }
}
export function buildActorContext(input: {
  userId: string
  brokerageId: string
  role?: string
  teamId?: string
}): ActorContext {
  const validRoles: ActorRole[] = [
    "superadmin",
    "broker",
    "admin",
    "team_lead",
    "agent",
    "isa",
    "tc",
    "compliance_officer",
    "vendor",
    "lender",
    "title_agent",
    "contact",
    "system",
  ]

  const role = validRoles.includes(input.role as ActorRole)
    ? (input.role as ActorRole)
    : "agent"

  return {
    userId: input.userId,
    brokerageId: input.brokerageId,
    role,
    teamId: input.teamId,
  }
}
/**
 * requireWriteContext
 *
 * Convenience variant that throws a standardized error when not authenticated.
 * Use in Server Actions where you want Next.js to surface a 401 automatically.
 */
export async function requireWriteContext(): Promise<WriteContext> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) {
    throw new Error("Unauthenticated: sign in required")
  }
  return ctx
}
