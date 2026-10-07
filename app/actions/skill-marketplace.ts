"use server"

/**
 * app/actions/skill-marketplace.ts — the session-gated doors of the skill registry + marketplace (wave 108, lane 108A).
 *
 * Every export here is a public HTTP endpoint (CLAUDE.md §4): each one gates FIRST (session → tenant / role),
 * then hands the service client to lib/kernel/skill-marketplace.ts. Tenant comes from the SESSION, never an
 * argument. A tenant admin authors + decides its OWN tenant's skills; platform staff take third-party
 * submissions and decide third-party / platform listings. Impersonation never decides (a support grant walks
 * the account, it does not approve on its behalf).
 */
import { getAgentContext } from "@/lib/identity"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import { requirePlatformStaff } from "@/lib/auth/platform-guard"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { MANAGER_SKILLS, type SkillDeclaration } from "@/lib/kernel/skill-registry"
import {
  decideSkillListing, evaluateSkillListing, listPlatformSkillListings, listVisibleSkillListings, runSkill, submitSkillListing,
  type ListingResult, type RunSkillResult, type SkillDecision, type SkillListingRow,
} from "@/lib/kernel/skill-marketplace"

type TenantGate = { ok: true; brokerageId: string; userId: string; isTenantAdmin: boolean; impersonating: boolean } | { ok: false; error: string }

async function tenantGate(): Promise<TenantGate> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId) return { ok: false, error: "Not signed in." }
  if (!ctx.brokerageId) return { ok: false, error: "This account is not attached to a brokerage yet." }
  const svc = createServiceClient()
  const admin = await resolveTenantAdmin(svc as any, ctx.userId, { user_type: ctx.userType, brokerage_id: ctx.brokerageId })
  if (!admin.ok) return { ok: false, error: `Role check refused: ${admin.error}` } // fail closed
  return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId, isTenantAdmin: admin.isTenantAdmin, impersonating: !!ctx.isImpersonating }
}

export interface SkillRegistryView {
  ok: boolean
  error?: string
  builtin: readonly SkillDeclaration[]
  listings: SkillListingRow[]
  canManage: boolean
}

/** The registry a tenant sees: every built-in manager skill + published global listings + its own listings. */
export async function getSkillRegistry(): Promise<SkillRegistryView> {
  const gate = await tenantGate()
  if (!gate.ok) return { ok: false, error: gate.error, builtin: MANAGER_SKILLS, listings: [], canManage: false }
  const { listings, readRefused } = await listVisibleSkillListings(gate.brokerageId, createServiceClient())
  if (readRefused) return { ok: false, error: readRefused, builtin: MANAGER_SKILLS, listings, canManage: gate.isTenantAdmin }
  return { ok: true, builtin: MANAGER_SKILLS, listings, canManage: gate.isTenantAdmin }
}

/** A tenant admin submits a tenant-authored skill; it is evaluated at once (deterministic suite). */
export async function submitTenantSkill(declaration: SkillDeclaration): Promise<ListingResult> {
  const gate = await tenantGate()
  if (!gate.ok) return { ok: false, reason: gate.error }
  if (!gate.isTenantAdmin || gate.impersonating) return { ok: false, reason: "tenant_admin_only" }
  const svc = createServiceClient()
  const sub = await submitSkillListing({ publisher: "tenant", brokerageId: gate.brokerageId, submittedBy: gate.userId, declaration }, svc)
  if (!sub.ok) return sub
  return evaluateSkillListing({ listingId: sub.listing.id, actorBrokerageId: gate.brokerageId }, svc)
}

/** A tenant admin approves / publishes / revokes ITS OWN tenant's skill. */
export async function decideTenantSkill(listingId: string, decision: SkillDecision, reason?: string): Promise<ListingResult> {
  const gate = await tenantGate()
  if (!gate.ok) return { ok: false, reason: gate.error }
  if (gate.impersonating) return { ok: false, reason: "impersonation_never_decides" }
  return decideSkillListing({ listingId, decision, reason: reason ?? null, actor: { isPlatformStaff: false, isTenantAdmin: gate.isTenantAdmin, brokerageId: gate.brokerageId, userId: gate.userId } }, createServiceClient())
}

/** Platform staff take a THIRD-PARTY (or platform) submission into the marketplace and evaluate it. */
export async function submitThirdPartySkill(declaration: SkillDeclaration, publisherName: string, publisher: "third_party" | "platform" = "third_party"): Promise<ListingResult> {
  const staff = await requirePlatformStaff()
  if (!staff.ok) return { ok: false, reason: staff.error }
  if (publisher === "third_party" && !publisherName?.trim()) return { ok: false, reason: "publisher_name_required" }
  const svc = createServiceClient()
  const sub = await submitSkillListing({ publisher, brokerageId: null, submittedBy: staff.userId, publisherName: publisherName?.trim() || null, declaration }, svc)
  if (!sub.ok) return sub
  return evaluateSkillListing({ listingId: sub.listing.id, actorBrokerageId: null }, svc)
}

/** Platform staff read the third-party / platform approval queue (any status). */
export async function getPlatformSkillQueue(): Promise<{ ok: boolean; error?: string; listings: SkillListingRow[] }> {
  const staff = await requirePlatformStaff()
  if (!staff.ok) return { ok: false, error: staff.error, listings: [] }
  const { listings, readRefused } = await listPlatformSkillListings(createServiceClient())
  return readRefused ? { ok: false, error: readRefused, listings } : { ok: true, listings }
}

/** Platform staff approve / publish / revoke a third-party or platform listing. */
export async function decidePlatformSkill(listingId: string, decision: SkillDecision, reason?: string): Promise<ListingResult> {
  const staff = await requirePlatformStaff()
  if (!staff.ok) return { ok: false, reason: staff.error }
  return decideSkillListing({ listingId, decision, reason: reason ?? null, actor: { isPlatformStaff: true, isTenantAdmin: false, brokerageId: null, userId: staff.userId } }, createServiceClient())
}

/** A tenant admin asks a manager to run a skill (built-in or published marketplace) for this tenant. */
export async function runSkillForTenant(skill: string, requestingManager: ManagerKey, inputs: Record<string, unknown>, objective: string): Promise<RunSkillResult> {
  const gate = await tenantGate()
  if (!gate.ok) return { ok: false, reason: gate.error }
  if (!gate.isTenantAdmin || gate.impersonating) return { ok: false, reason: "tenant_admin_only" }
  if (!(requestingManager in MANAGERS)) return { ok: false, reason: `unknown_manager:${String(requestingManager)}` }
  return runSkill({ brokerageId: gate.brokerageId, skill, requestingManager, inputs: inputs ?? {}, objective }, createServiceClient())
}
