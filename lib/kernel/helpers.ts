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
import { bestEffort } from "@/lib/db/best-effort"
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
  "agent", "broker", "broker_admin", "broker_owner", "admin", "tc", "transaction_coordinator",
  "compliance_officer", "team_lead", "team_member", "lender", "vendor",
  "title", "superadmin", "isa",
  ])

// ─── ROUTE → REQUIRED ROLE MAP ───────────────────────────────────────────────
// Maps route prefix → minimum required role (checked against userContext.roles).
// This is a coarse guard — fine-grained RLS lives in Supabase.
// CLIENT-METADATA vocabulary, not users.user_type: UserContext.roles mixes demo
// and auth-metadata fallbacks, which can carry "superadmin" — it stays here even
// though it is dead as a user_type, or platform demo seats lose their nav.
const ROUTE_ROLE_REQUIREMENTS: Record<string, string[]> = {
  "/admin":                  ["superadmin", "admin"],
  "/dashboard/admin":        ["superadmin", "admin", "broker", "broker_admin", "broker_owner"],
  "/dashboard/financials":   ["agent", "broker", "broker_admin", "broker_owner", "admin", "superadmin"],
  "/dashboard/brokerage":    ["broker", "broker_admin", "broker_owner", "admin", "superadmin"],
  "/dashboard/recruiting":   ["broker", "broker_admin", "broker_owner", "admin", "superadmin"],
  "/dashboard/compliance":   ["broker", "broker_admin", "broker_owner", "admin", "compliance_officer", "superadmin"],
  "/dashboard/transactions": ["agent", "tc", "transaction_coordinator", "broker", "broker_admin", "broker_owner", "admin", "superadmin"],
  "/dashboard/isa":          ["isa", "broker", "broker_admin", "broker_owner", "admin", "superadmin"],
  "/dashboard":              [...STAFF_ROLES],
  "/crm":                    ["agent", "broker", "broker_admin", "broker_owner", "admin", "superadmin"],
  "/leads":                  ["isa", "broker", "broker_admin", "broker_owner", "admin", "superadmin"],
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
      return { allowed: false, reason: result.error ?? "Transition not allowed" }
    }
    return { allowed: true, newStage: (result as Record<string, unknown>).newStage as string | undefined }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Lifecycle enforcement failed"
    return { allowed: false, reason: message }
  }
}

// ─── enforceCompliance ────────────────────────────────────────────────────────

/**
 * Convenience wrapper around evaluateOutbound().
 * Accepts flat params used by server actions/pages — builds the full
 * EvaluateOutboundParams shape internally using safe defaults for fields
 * that simple callers don't have (journeyType, persona, contact shape).
 *
 * For full compliance evaluation with real contact data, call evaluateOutbound
 * directly with the complete EvaluateOutboundParams shape.
 *
 * Returns a ComplianceResult. Never throws.
 */
export async function enforceCompliance(
  content: string,
  messageType: string,
  brokerageId: string,
  actorUserId: string,
  contactId?: string,
  actorRole?: string
): Promise<ComplianceResult> {
  try {
    // Build the EvaluateOutboundParams shape from the convenience params.
    // Use safe defaults for required union fields that callers don't supply.
    const safeMessageType = (
      ["email", "sms", "social", "phone", "in_app", "ai", "direct_mail"].includes(messageType)
        ? messageType
        : "email"
    ) as import("./types").MessageType

    const safeRole = (
      ["superadmin","broker","admin","team_lead","agent","isa","tc",
       "compliance_officer","vendor","lender","title_agent","contact","system"]
        .includes(actorRole ?? "")
        ? actorRole
        : "agent"
    ) as import("./types").ActorRole

    return await evaluateOutbound({
      actorContext: {
        userId:      actorUserId,
        role:        safeRole,
        brokerageId: brokerageId,
      },
      journeyType: "buyer",  // safe default — callers that know the journey should call evaluateOutbound directly
      persona:     "other",  // safe default
      messageType: safeMessageType,
      content,
      contact: {
        id:            contactId ?? "",
        first_name:    "",
        last_name:     "",
        contact_type:  "buyer",
        tcpa_consent:  true,   // conservative default — real enforcement happens in Gate 2 via DB lookup
        isa_reengage_allowed: false,
        dnc_status:    false,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Compliance check failed"
    return {
      allowed:    false,
      violations: [message],
      blockedReason: message,
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
 *
 * ONE VOCABULARY (2026-09-03): the lifecycle_events half goes through
 * `emitKernelEvent` (lib/kernel/emit.ts) — this was the FIFTH spelling of "fire
 * a kernel event", and it never reached the reactor. A typed KernelEvent passed
 * here now fans out (staff bell / sequences / portal); a free-form audit string
 * (the AI-ISA outreach telemetry that is this helper's main traffic) is still
 * persisted and stops there — the emit gates on the KernelEvent enum. The
 * `activities` mirror is unchanged. The emit is loaded at call time because it
 * is `server-only` and this module is imported by simulators under plain tsx.
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

    // Declared non-fatal — but the try/catch below could never see a rejected
    // write (supabase-js resolves), so telemetry that silently stopped landing
    // would look identical to telemetry that worked. bestEffort keeps it
    // non-fatal AND logs, which is what "must never break the calling flow"
    // was meant to buy.
    const { emitKernelEvent } = await import("./emit")
    const [, emitted] = await Promise.all([
      bestEffort(supabase.from("activities").insert({
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
      }), "lifecycle activity mirror"),
      emitKernelEvent({
        event:         params.eventType,
        entityType:    params.entityType,
        entityId:      entityUuid ?? "",
        actorUserId:   actorUuid,
        brokerageId:   brokerUuid,
        contactId:     params.contactId,
        transactionId: params.transactionId,
        metadata:      params.metadata ?? {},
        createdAt:     now,
      }),
    ])
    if (emitted.error) {
      console.error(`[kernel/helpers] lifecycle_events row refused for ${params.eventType}: ${emitted.error}`)
    }
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
  const isBrokerOrAdmin = roles.some(r => ["broker", "broker_admin", "broker_owner", "admin"].includes(r))
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
