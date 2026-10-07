"use server"

/**
 * app/actions/skill-marketplace.ts — the session-gated doors of the skill registry + ONE extension lifecycle +
 * tenant extension control (wave 108 lane 108A; wave 137 lane 137D).
 *
 * Every export here is a public HTTP endpoint (CLAUDE.md §4): each one gates FIRST (session → tenant / role),
 * then hands the service client to lib/kernel/skill-marketplace.ts. Tenant comes from the SESSION, never an
 * argument. A tenant admin authors + decides its OWN tenant's extensions and opts its tenant in / out of enabled
 * global ones; platform staff take third-party submissions, decide global listings and hold the kill switch on
 * every listing. Impersonation never decides (a support grant walks the account, it does not approve on its behalf).
 */
import { getAgentContext } from "@/lib/identity"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import { requirePlatformStaff } from "@/lib/auth/platform-guard"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { MANAGER_SKILLS, type CustomManagerDeclaration, type SkillDeclaration } from "@/lib/kernel/skill-registry"
import {
  decideSkillListing, evaluateSkillListing, listPlatformSkillListings, listTenantExtensions, listVisibleSkillListings,
  runCustomManagerCapability, runSkill, setTenantExtensionEnabled, submitSkillListing,
  type ExtensionListingRow, type ListingResult, type RunCustomManagerResult, type RunSkillResult, type SkillDecision, type TenantExtensionView,
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

/** The extension kinds a door accepts a declaration for — the kinds whose contract this lane owns. */
type AuthoredKind = "skill" | "custom_manager"
const authoredKind = (k: unknown): AuthoredKind => (k === "custom_manager" ? "custom_manager" : "skill")

export interface SkillRegistryView {
  ok: boolean
  error?: string
  builtin: readonly SkillDeclaration[]
  listings: ExtensionListingRow[]
  canManage: boolean
}

/** The registry a tenant sees: every built-in manager skill + enabled global listings + its own listings. */
export async function getSkillRegistry(): Promise<SkillRegistryView> {
  const gate = await tenantGate()
  if (!gate.ok) return { ok: false, error: gate.error, builtin: MANAGER_SKILLS, listings: [], canManage: false }
  const { listings, readRefused } = await listVisibleSkillListings(gate.brokerageId, createServiceClient())
  if (readRefused) return { ok: false, error: readRefused, builtin: MANAGER_SKILLS, listings, canManage: gate.isTenantAdmin }
  return { ok: true, builtin: MANAGER_SKILLS, listings, canManage: gate.isTenantAdmin }
}

/** A tenant admin submits a tenant-authored skill or custom manager; it is evaluated at once (deterministic suite). */
export async function submitTenantSkill(declaration: SkillDeclaration | CustomManagerDeclaration, kind?: AuthoredKind): Promise<ListingResult> {
  const gate = await tenantGate()
  if (!gate.ok) return { ok: false, reason: gate.error }
  if (!gate.isTenantAdmin || gate.impersonating) return { ok: false, reason: "tenant_admin_only" }
  const svc = createServiceClient()
  const sub = await submitSkillListing({ kind: authoredKind(kind), publisher: "tenant", brokerageId: gate.brokerageId, submittedBy: gate.userId, declaration }, svc)
  if (!sub.ok) return sub
  return evaluateSkillListing({ listingId: sub.listing.id, actorBrokerageId: gate.brokerageId }, svc)
}

/** A tenant admin moves ITS OWN tenant's extension through the lifecycle (approve / enable / suspend / resume /
 *  deprecate / disable). */
export async function decideTenantSkill(listingId: string, decision: SkillDecision, reason?: string): Promise<ListingResult> {
  const gate = await tenantGate()
  if (!gate.ok) return { ok: false, reason: gate.error }
  if (gate.impersonating) return { ok: false, reason: "impersonation_never_decides" }
  return decideSkillListing({ listingId, decision, reason: reason ?? null, actor: { isPlatformStaff: false, isTenantAdmin: gate.isTenantAdmin, brokerageId: gate.brokerageId, userId: gate.userId } }, createServiceClient())
}

/** Platform staff take a THIRD-PARTY (or platform) submission into the lifecycle and evaluate it. */
export async function submitThirdPartySkill(declaration: SkillDeclaration | CustomManagerDeclaration, publisherName: string, publisher: "third_party" | "platform" = "third_party", kind?: AuthoredKind): Promise<ListingResult> {
  const staff = await requirePlatformStaff()
  if (!staff.ok) return { ok: false, reason: staff.error }
  if (publisher === "third_party" && !publisherName?.trim()) return { ok: false, reason: "publisher_name_required" }
  const svc = createServiceClient()
  const sub = await submitSkillListing({ kind: authoredKind(kind), publisher, brokerageId: null, submittedBy: staff.userId, publisherName: publisherName?.trim() || null, declaration }, svc)
  if (!sub.ok) return sub
  return evaluateSkillListing({ listingId: sub.listing.id, actorBrokerageId: null }, svc)
}

/** Platform staff read the third-party / platform approval queue (any status). */
export async function getPlatformSkillQueue(): Promise<{ ok: boolean; error?: string; listings: ExtensionListingRow[] }> {
  const staff = await requirePlatformStaff()
  if (!staff.ok) return { ok: false, error: staff.error, listings: [] }
  const { listings, readRefused } = await listPlatformSkillListings(createServiceClient())
  return readRefused ? { ok: false, error: readRefused, listings } : { ok: true, listings }
}

/** Platform staff move a third-party or platform listing through the lifecycle (and hold the kill switch). */
export async function decidePlatformSkill(listingId: string, decision: SkillDecision, reason?: string): Promise<ListingResult> {
  const staff = await requirePlatformStaff()
  if (!staff.ok) return { ok: false, reason: staff.error }
  return decideSkillListing({ listingId, decision, reason: reason ?? null, actor: { isPlatformStaff: true, isTenantAdmin: false, brokerageId: null, userId: staff.userId } }, createServiceClient())
}

/** A tenant admin asks a manager to run a skill (built-in or an executable marketplace one) for this tenant. */
export async function runSkillForTenant(skill: string, requestingManager: ManagerKey, inputs: Record<string, unknown>, objective: string): Promise<RunSkillResult> {
  const gate = await tenantGate()
  if (!gate.ok) return { ok: false, reason: gate.error }
  if (!gate.isTenantAdmin || gate.impersonating) return { ok: false, reason: "tenant_admin_only" }
  if (!(requestingManager in MANAGERS)) return { ok: false, reason: `unknown_manager:${String(requestingManager)}` }
  return runSkill({ brokerageId: gate.brokerageId, skill, requestingManager, inputs: inputs ?? {}, objective }, createServiceClient())
}

/** TENANT EXTENSION CONTROL — the extensions visible to this tenant, whether each runs here and who controls it. */
export async function getTenantExtensions(): Promise<{ ok: boolean; error?: string; extensions: TenantExtensionView[]; canManage: boolean }> {
  const gate = await tenantGate()
  if (!gate.ok) return { ok: false, error: gate.error, extensions: [], canManage: false }
  const { extensions, readRefused } = await listTenantExtensions(gate.brokerageId, createServiceClient())
  return { ok: !readRefused, error: readRefused ?? undefined, extensions, canManage: gate.isTenantAdmin && !gate.impersonating }
}

/** A tenant admin enables / disables an ENABLED global extension for THIS tenant (versioned tenant policy). */
export async function setTenantExtension(listingId: string, enable: boolean): Promise<{ ok: true; enabled: boolean } | { ok: false; reason: string }> {
  const gate = await tenantGate()
  if (!gate.ok) return { ok: false, reason: gate.error }
  if (gate.impersonating) return { ok: false, reason: "impersonation_never_decides" }
  return setTenantExtensionEnabled({ brokerageId: gate.brokerageId, listingId, enable: enable === true, actor: { userId: gate.userId, isTenantAdmin: gate.isTenantAdmin } }, createServiceClient())
}

/** A tenant admin asks an ENABLED custom manager to request ONE of its allowed capabilities. */
export async function runCustomManagerForTenant(customManager: string, capability: string, inputs: Record<string, unknown>, objective: string): Promise<RunCustomManagerResult> {
  const gate = await tenantGate()
  if (!gate.ok) return { ok: false, reason: gate.error }
  if (!gate.isTenantAdmin || gate.impersonating) return { ok: false, reason: "tenant_admin_only" }
  return runCustomManagerCapability({ brokerageId: gate.brokerageId, customManager, capability, inputs: inputs ?? {}, objective }, createServiceClient())
}
