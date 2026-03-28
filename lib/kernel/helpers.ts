// lib/kernel/helpers.ts
// LAYER 0 — Shared kernel helpers used across every feature.
//
// Five capabilities surfaced here:
//   determineVisibleNavigation  — returns role-appropriate nav items
//   enforceLifecycle            — validates + executes a lifecycle transition
//   enforceCompliance           — runs the compliance gate for outbound content
//   emitLifecycleEvent          — writes to activities + lifecycle_events
//   resolvePageCapability       — returns what actions a user can perform on a route
//
// All functions handle missing rows gracefully (maybeSingle / try-catch).
// All DB writes use the server client from @/lib/supabase/server.
// NOTE: No "use server" directive here — these are plain utilities and async
// helpers, not Next.js Server Actions. Files that call createClient() are
// already running server-side via RSC / Route Handlers.

import { createClient } from "@/lib/supabase/server"
import { transitionLifecycle } from "./lifecycle"
import { evaluateOutbound } from "./compliance"
import { NAVIGATION_BY_ROLE } from "@/app/config/navigation-config"
import type { TransitionLifecycleParams, ComplianceResult } from "./types"
import type { UserContext } from "@/lib/security"

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface NavigationResult {
  sidebarItems: unknown[]
  topNavItems:  unknown[]
  mobileBottomNav: unknown[]
}

export interface LifecycleEnforcement {
  allowed:   boolean
  reason?:   string
  newStage?: string
}

export interface PageCapability {
  canView:   boolean
  canEdit:   boolean
  canCreate: boolean
  canDelete: boolean
  canApprove: boolean
  reason?:   string
}

export interface EmitEventParams {
  eventType:   string
  entityId:    string
  entityType:  string
  actorId:     string
  brokerageId: string
  metadata?:   Record<string, unknown>
  contactId?:  string
  transactionId?: string
}

// ─── STAFF ROLES ─────────────────────────────────────────────────────────────
// Roles that get the internal AI assistant and full dashboard navigation.
  const STAFF_ROLES = new Set([
  "agent", "broker", "broker_admin", "admin", "tc", "transaction_coordinator",
  "compliance_officer", "team_lead", "team_member", "lender", "vendor",
  "title", "superadmin", "isa",
  ])

// ─── ROUTE → REQUIRED ROLE MAP ───────────────────────────────────────────────
// Maps route prefix → minimum required role (checked against userContext.roles).
// This is a coarse guard — fine-grained RLS lives in Supabase.
const ROUTE_ROLE_REQUIREMENTS: Record<string, string[]> = {
  "/admin":                  ["superadmin", "admin"],
  "/dashboard/admin":        ["superadmin", "admin", "broker", "broker_admin"],
  "/dashboard/financials":   ["agent", "broker", "broker_admin", "admin", "superadmin"],
  "/dashboard/brokerage":    ["broker", "broker_admin", "admin", "superadmin"],
  "/dashboard/recruiting":   ["broker", "broker_admin", "admin", "superadmin"],
  "/dashboard/compliance":   ["broker", "broker_admin", "admin", "compliance_officer", "superadmin"],
  "/dashboard/transactions": ["agent", "tc", "transaction_coordinator", "broker", "broker_admin", "admin", "superadmin"],
  "/dashboard/isa":          ["isa", "broker", "broker_admin", "admin", "superadmin"],
  "/dashboard":              [...STAFF_ROLES],
  "/crm":                    ["agent", "broker", "broker_admin", "admin", "superadmin"],
  "/leads":                  ["isa", "broker", "broker_admin", "admin", "superadmin"],
  "/portal":                 ["contact", "buyer", "seller", "lifetime"],
}

// ─── determineVisibleNavigation ───────────────────────────────────────────────

/**
 * Returns the role-appropriate navigation config for the given UserContext.
 * Falls back to agent navigation if the role has no explicit config.
 */
export function determineVisibleNavigation(
  userContext: UserContext | null
): NavigationResult {
  if (!userContext) {
    return { sidebarItems: [], topNavItems: [], mobileBottomNav: [] }
  }

  const primaryRole = userContext.roles?.[0] ?? "agent"
  // NAVIGATION_BY_ROLE is a Record<UserRole, NavigationConfig>
  const config = (NAVIGATION_BY_ROLE as Record<string, unknown>)[primaryRole]
    ?? (NAVIGATION_BY_ROLE as Record<string, unknown>)["agent"]
    ?? { sidebarItems: [], topNavItems: [], mobileBottomNav: [] }

  const nav = config as { sidebarItems?: unknown[]; topNavItems?: unknown[]; mobileBottomNav?: unknown[] }
  return {
    sidebarItems:    nav.sidebarItems    ?? [],
    topNavItems:     nav.topNavItems     ?? [],
    mobileBottomNav: nav.mobileBottomNav ?? [],
  }
}

/**
 * Returns true when the given role string belongs to a staff member
 * (agent/broker/admin/tc/lender/vendor/title/superadmin).
 * Used by app-shell to gate the InternalAIAssistant.
 */
export function isStaffRole(role: string): boolean {
  return STAFF_ROLES.has(role)
}

// ─── enforceLifecycle ─────────────────────────────────────────────────────────

/**
 * Validates and executes a lifecycle transition.
 * Wraps transitionLifecycle() with a pre-flight check so callers get a clean
 * { allowed, reason, newStage } result instead of a throw.
 *
 * Does NOT emit compliance events — call enforceCompliance separately for outbound.
 */
export async function enforceLifecycle(
  params: TransitionLifecycleParams
): Promise<LifecycleEnforcement> {
  try {
    const result = await transitionLifecycle(params)
    if (!result.success) {
      return { allowed: false, reason: result.reason ?? "Transition not allowed" }
    }
    return { allowed: true, newStage: result.newStage as string | undefined }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Lifecycle enforcement failed"
    return { allowed: false, reason: message }
  }
}

// ─── enforceCompliance ────────────────────────────────────────────────────────

/**
 * Runs the full compliance gate for outbound content.
 * Delegates to evaluateOutbound() in lib/kernel/compliance.ts.
 * Returns a ComplianceResult. Never throws — returns allowed:false on error.
 */
export async function enforceCompliance(
  content: string,
  contentType: string,
  brokerageId: string,
  actorUserId: string,
  contactId?: string,
  channel?: string
): Promise<ComplianceResult> {
  try {
    return await evaluateOutbound({
      content,
      contentType: contentType as "email" | "sms" | "social" | "voice" | "letter",
      brokerageId,
      actorUserId,
      contactId,
      channel: channel as "email" | "sms" | "social" | "voice" | "letter" | undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Compliance check failed"
    return {
      allowed: false,
      reason: message,
      violations: [],
      correctedContent: content,
      blockedByGate: "enforcement_error",
    }
  }
}

// ─── emitLifecycleEvent ───────────────────────────────────────────────────────

/**
 * Writes a lifecycle event to both `activities` and `lifecycle_events`.
 * Always non-throwing — silently logs on DB errors.
 *
 * Schema:
 *   activities:      activity_type, entity_type, entity_id(=contact_id), agent_id, brokerage_id, title, description, status, created_at
 *   lifecycle_events: event_type, entity_type, entity_id, actor_user_id, brokerage_id, metadata, created_at
 */
export async function emitLifecycleEvent(params: EmitEventParams): Promise<void> {
  try {
    const supabase = await createClient()
    const now = new Date().toISOString()

    // Parallel writes — one to activities, one to lifecycle_events.
    // Guard: uuid columns must not receive empty strings — use null for anonymous actors.
    const actorUuid  = params.actorId?.trim()    || null
    const entityUuid = params.entityId?.trim()   || null
    const brokerUuid = params.brokerageId?.trim() || null

    await Promise.all([
      supabase.from("activities").insert({
        activity_type:  params.eventType,
        entity_type:    params.entityType,
        contact_id:     params.contactId     ?? null,
        transaction_id: params.transactionId ?? null,
        agent_id:       actorUuid,
        brokerage_id:   brokerUuid,
        title:          params.eventType.replace(/_/g, " ").toLowerCase(),
        description:    JSON.stringify(params.metadata ?? {}),
        status:         "completed",
        created_at:     now,
      }),
      supabase.from("lifecycle_events").insert({
        event_type:    params.eventType,
        entity_type:   params.entityType,
        entity_id:     entityUuid,
        actor_user_id: actorUuid,
        brokerage_id:  brokerUuid,
        metadata:      params.metadata ?? {},
        created_at:    now,
      }),
    ])
  } catch (err) {
    // Non-fatal — telemetry failures must never break the calling flow.
    console.error("[kernel/helpers] emitLifecycleEvent failed:", err)
  }
}

// ─── resolvePageCapability ────────────────────────────────────────────────────

/**
 * Returns the CRUD capabilities a user has on a given route.
 * Based on role RBAC only — does not check row-level ownership (RLS does that).
 *
 * Used by page components to show/hide action buttons without making extra DB calls.
 */
export function resolvePageCapability(
  route: string,
  userContext: UserContext | null
): PageCapability {
  if (!userContext) {
    return { canView: false, canEdit: false, canCreate: false, canDelete: false, canApprove: false, reason: "Unauthenticated" }
  }

  const roles: string[] = userContext.roles ?? []

  // Find the most-specific matching route prefix
  const matchingEntry = Object.entries(ROUTE_ROLE_REQUIREMENTS)
    .sort((a, b) => b[0].length - a[0].length) // longest prefix wins
    .find(([prefix]) => route.startsWith(prefix))

  if (matchingEntry) {
    const [, allowedRoles] = matchingEntry
    const hasAccess = roles.some(r => allowedRoles.includes(r))
    if (!hasAccess) {
      return {
        canView:    false,
        canEdit:    false,
        canCreate:  false,
        canDelete:  false,
        canApprove: false,
        reason:     `Role "${roles[0]}" is not permitted on ${route}`,
      }
    }
  }

  // Role-based capability matrix
  const isSuperadmin    = roles.includes("superadmin")
  const isBrokerOrAdmin = roles.some(r => ["broker", "broker_admin", "admin"].includes(r))
  const isAgent         = roles.some(r => ["agent", "team_lead", "team_member"].includes(r))
  const isCompliance    = roles.includes("compliance_officer")
  const isTC            = roles.some(r => ["tc", "transaction_coordinator"].includes(r))

  return {
    canView:    true,
    canEdit:    isSuperadmin || isBrokerOrAdmin || isAgent || isTC,
    canCreate:  isSuperadmin || isBrokerOrAdmin || isAgent,
    canDelete:  isSuperadmin || isBrokerOrAdmin,
    canApprove: isSuperadmin || isBrokerOrAdmin || isCompliance,
  }
}
