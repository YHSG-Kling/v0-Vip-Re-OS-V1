// lib/kernel/routes.ts
// Canonical component path registry and normalization contracts.
// Defines the single source of truth for component root resolution.
// Import from '@/lib/kernel' — never directly.
// No default exports.

// ─── CANONICAL COMPONENT ROOT ─────────────────────────────────────────────────

/** The only canonical component root for reusable shared UI. */
export const CANONICAL_COMPONENT_ROOT = "app/components" as const

/** Legacy parallel root that must not be used for new imports. */
export const LEGACY_COMPONENT_ROOT = "components" as const

// ─── CANONICAL PATH REGISTRY ──────────────────────────────────────────────────

/**
 * Maps each root-level component path to its canonical app/components equivalent.
 * Survivor = canonical app/components version with correct prop contracts.
 */
export const CANONICAL_COMPONENT_MAP = {
  // Brokerage
  "@/components/brokerage/agent-list": "@/components/brokerage/agent-list",
  "@/components/brokerage/revenue-chart": "@/components/brokerage/revenue-chart",
  "@/components/brokerage/compliance-overview": "@/components/brokerage/compliance-overview",
  // Coordinator
  "@/components/coordinator/transaction-list": "@/components/coordinator/transaction-list",
  "@/components/coordinator/deadline-tracking": "@/components/coordinator/deadline-tracking",
  "@/components/coordinator/milestone-queue": "@/components/coordinator/milestone-queue",
  "@/components/coordinator/health-overview": "@/components/coordinator/health-overview",
  // Onboarding
  "@/components/onboarding/AISetupAssistant": "@/components/onboarding/AISetupAssistant",
  // Shared
  "@/components/ApprovalsBanner": "@/components/ApprovalsBanner",
} as const

export type CanonicalComponentPath = keyof typeof CANONICAL_COMPONENT_MAP

// ─── AUDIT RESULT TYPES ───────────────────────────────────────────────────────

export type ComponentAuditStatus =
  | "canonical"      // Lives in app/components, correct props
  | "duplicate"      // Exists in both roots — root version is stale
  | "orphan"         // Only in root components/, needs migration
  | "dead"           // Not imported anywhere — safe to remove

export interface ComponentAuditEntry {
  path: string
  status: ComponentAuditStatus
  canonicalPath: string
  legacyPath?: string
  propMismatch: boolean
  importCount: number
  notes?: string
}

export interface ComponentAuditResult {
  timestamp: string
  totalComponents: number
  canonical: number
  duplicates: number
  orphans: number
  dead: number
  propMismatches: number
  entries: ComponentAuditEntry[]
  buildSafe: boolean
}

// ─── RESOLUTION RULES ─────────────────────────────────────────────────────────

/**
 * Survivor resolution rule:
 * - If both root and app/components versions exist, the app/components version wins.
 * - The app/components version MUST accept the props the page actually passes.
 * - Root components/ versions are legacy stubs — never overwrite app/components with them.
 */
export type SurvivorRule = "app_components_wins"
export const SURVIVOR_RULE: SurvivorRule = "app_components_wins"

// ─── IMPORT NORMALIZATION CONTRACT ────────────────────────────────────────────

export interface ImportNormalizationRule {
  /** The import alias to detect (e.g. "@/components/brokerage/...") */
  alias: string
  /** Where tsconfig resolves it to */
  resolvedRoot: "app/components"
  /** Whether this alias is currently safe (file exists in resolved location) */
  safe: boolean
}

export const IMPORT_NORMALIZATION_RULES: ImportNormalizationRule[] = [
  { alias: "@/components/brokerage/agent-list", resolvedRoot: "app/components", safe: true },
  { alias: "@/components/brokerage/revenue-chart", resolvedRoot: "app/components", safe: true },
  { alias: "@/components/brokerage/compliance-overview", resolvedRoot: "app/components", safe: true },
  { alias: "@/components/coordinator/transaction-list", resolvedRoot: "app/components", safe: true },
  { alias: "@/components/coordinator/deadline-tracking", resolvedRoot: "app/components", safe: true },
  { alias: "@/components/coordinator/milestone-queue", resolvedRoot: "app/components", safe: true },
  { alias: "@/components/coordinator/health-overview", resolvedRoot: "app/components", safe: true },
  { alias: "@/components/onboarding/AISetupAssistant", resolvedRoot: "app/components", safe: true },
  { alias: "@/components/ApprovalsBanner", resolvedRoot: "app/components", safe: true },
]

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN COHERENCE COMMANDS — 8 Canonical Route Audit Operations
// ═══════════════════════════════════════════════════════════════════════════

export type RouteClassification =
  | "canonical"        // Single authoritative surface for this domain
  | "redirect_to"      // Should redirect to canonical — legacy URL kept for link compat
  | "remove"           // Duplicate with no unique value — safe to remove after audit
  | "supporting_child" // Child detail/edit page under a canonical parent

export type RouteAccessLevel =
  | "public"
  | "authenticated"
  | "agent"
  | "broker"
  | "superadmin"

export interface RouteEntry {
  id: string                      // sha-like hash: domain + path segment
  path: string                    // "/dashboard/admin/vendors"
  title: string                   // Human label
  domain: string                  // "vendors" | "billing" | "education" | etc.
  accessLevel: RouteAccessLevel
  kernelOwner: string             // "lib/kernel/vendors.ts"
  classification: RouteClassification
  redirectTarget?: string         // Only present when classification = "redirect_to"
  removalReason?: string          // Only present when classification = "remove"
  isPersonaSpecific: boolean      // true = legacy persona portal (must be migrated)
  verified: boolean               // Human-reviewed
}

export interface DuplicateSet {
  domain: string
  canonical: RouteEntry
  duplicates: RouteEntry[]
}

export interface CoherenceFinding {
  severity: "info" | "warning" | "critical"
  type:
    | "duplicate_manager"
    | "legacy_persona_route"
    | "dead_nav_link"
    | "contract_mismatch"
    | "bypass_kernel"
    | "stale_schema_column"
  message: string
  affected: string[]
  recommendation: string
}

export interface CoherenceReport {
  generatedAt: string
  totalRoutes: number
  canonicalCount: number
  redirectCount: number
  removeCount: number
  duplicateSets: DuplicateSet[]
  findings: CoherenceFinding[]
  overallStatus: "clean" | "needs_review" | "critical"
}

// ─── COMMAND 1: Enumerate Domain Routes ──────────────────────────────────────

/**
 * Input:  { includePersonaRoutes?: boolean }
 * Output: { routes: RouteEntry[], total: number, byDomain: Record<string, number> }
 *
 * Static enumeration of all known application routes with their domain,
 * kernel owner, access level, and classification. No filesystem scan —
 * this is the authoritative hand-maintained registry to avoid runtime fs access.
 */
export interface EnumerateRoutesInput {
  includePersonaRoutes?: boolean
}

export interface EnumerateRoutesOutput {
  routes: RouteEntry[]
  total: number
  byDomain: Record<string, number>
}

export function enumerateDomainRoutes(input: EnumerateRoutesInput): EnumerateRoutesOutput {
  const all: RouteEntry[] = [
    // ── ADMIN ─────────────────────────────────────────────────────
    { id: "admin-root", path: "/dashboard/admin", title: "Admin Command Center", domain: "admin", accessLevel: "broker", kernelOwner: "lib/kernel/admin.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "admin-billing", path: "/dashboard/admin/billing", title: "Billing & Tiering", domain: "billing", accessLevel: "superadmin", kernelOwner: "lib/kernel/billing.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "admin-vendors", path: "/dashboard/admin/vendors", title: "Vendor Marketplace", domain: "vendors", accessLevel: "broker", kernelOwner: "lib/kernel/vendors.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "admin-forms", path: "/dashboard/admin/forms", title: "Forms Management", domain: "forms", accessLevel: "broker", kernelOwner: "lib/kernel/forms.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "admin-lead-magnets", path: "/dashboard/admin/lead-magnets", title: "Lead Magnets", domain: "lead_magnets", accessLevel: "broker", kernelOwner: "lib/kernel/lead-magnets.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "admin-education", path: "/dashboard/education", title: "Education Library", domain: "education", accessLevel: "broker", kernelOwner: "lib/kernel/education.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "admin-video", path: "/dashboard/video", title: "Video Studio", domain: "video", accessLevel: "broker", kernelOwner: "lib/kernel/video.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "admin-compliance", path: "/dashboard/admin/compliance", title: "Compliance", domain: "compliance", accessLevel: "broker", kernelOwner: "lib/kernel/communication-compliance.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "admin-domain-coherence", path: "/dashboard/admin/domain-coherence", title: "Domain Coherence", domain: "admin_tools", accessLevel: "superadmin", kernelOwner: "lib/kernel/routes.ts", classification: "canonical", isPersonaSpecific: false, verified: true },

    // ── PORTAL ────────────────────────────────────────────────────
    { id: "portal-root", path: "/portal/[contactId]", title: "Portal Home", domain: "portal", accessLevel: "authenticated", kernelOwner: "lib/kernel/portal.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "portal-journey", path: "/portal/[contactId]/journey", title: "My Journey", domain: "portal", accessLevel: "authenticated", kernelOwner: "lib/kernel/portal.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "portal-learn", path: "/portal/[contactId]/learn", title: "Learn", domain: "education", accessLevel: "authenticated", kernelOwner: "lib/kernel/education.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "portal-vendors", path: "/portal/[contactId]/vendors", title: "Vendors", domain: "vendors", accessLevel: "authenticated", kernelOwner: "lib/kernel/vendors.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "portal-documents", path: "/portal/[contactId]/documents", title: "Documents", domain: "documents", accessLevel: "authenticated", kernelOwner: "lib/kernel/forms.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "portal-messages", path: "/portal/[contactId]/messages", title: "Messages", domain: "communications", accessLevel: "authenticated", kernelOwner: "lib/kernel/communication-compliance.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "portal-search", path: "/portal/[contactId]/search", title: "Smart Search", domain: "listings", accessLevel: "authenticated", kernelOwner: "lib/kernel/listings.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "portal-offers", path: "/portal/[contactId]/offers", title: "Offers", domain: "transactions", accessLevel: "authenticated", kernelOwner: "lib/kernel/transactions.ts", classification: "canonical", isPersonaSpecific: false, verified: true },
    { id: "portal-help", path: "/portal/[contactId]/help", title: "Help", domain: "support", accessLevel: "authenticated", kernelOwner: "lib/kernel/portal.ts", classification: "canonical", isPersonaSpecific: false, verified: true },

    // ── LEGACY PERSONA PORTALS (must redirect) ───────────────────
    { id: "portal-persona-buyer", path: "/portal/[contactId]/dashboard/buyer", title: "Buyer Portal (legacy)", domain: "portal", accessLevel: "authenticated", kernelOwner: "lib/kernel/portal.ts", classification: "redirect_to", redirectTarget: "/portal/[contactId]", isPersonaSpecific: true, verified: true },
    { id: "portal-persona-seller", path: "/portal/[contactId]/dashboard/seller", title: "Seller Portal (legacy)", domain: "portal", accessLevel: "authenticated", kernelOwner: "lib/kernel/portal.ts", classification: "redirect_to", redirectTarget: "/portal/[contactId]", isPersonaSpecific: true, verified: true },
    { id: "portal-persona-lifetime", path: "/portal/[contactId]/dashboard/lifetime", title: "Lifetime Portal (legacy)", domain: "portal", accessLevel: "authenticated", kernelOwner: "lib/kernel/portal.ts", classification: "redirect_to", redirectTarget: "/portal/[contactId]", isPersonaSpecific: true, verified: true },
    { id: "portal-seller-home", path: "/portal/[contactId]/seller-home", title: "Seller Home (legacy)", domain: "portal", accessLevel: "authenticated", kernelOwner: "lib/kernel/portal.ts", classification: "redirect_to", redirectTarget: "/portal/[contactId]", isPersonaSpecific: true, verified: true },
    { id: "portal-lifetime-home", path: "/portal/[contactId]/lifetime-home", title: "Lifetime Home (legacy)", domain: "portal", accessLevel: "authenticated", kernelOwner: "lib/kernel/portal.ts", classification: "redirect_to", redirectTarget: "/portal/[contactId]", isPersonaSpecific: true, verified: true },
  ]

  const routes = input.includePersonaRoutes
    ? all
    : all.filter(r => !r.isPersonaSpecific)

  const byDomain: Record<string, number> = {}
  for (const r of routes) {
    byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1
  }

  return { routes, total: routes.length, byDomain }
}

// ─── COMMAND 2: Classify Route Ownership ─────────────────────────────────────

/**
 * Input:  { routes: RouteEntry[] }
 * Output: { canonical: RouteEntry[], redirects: RouteEntry[], toRemove: RouteEntry[], children: RouteEntry[] }
 */
export interface ClassifyOwnershipInput {
  routes: RouteEntry[]
}

export interface ClassifyOwnershipOutput {
  canonical: RouteEntry[]
  redirects: RouteEntry[]
  toRemove: RouteEntry[]
  children: RouteEntry[]
  unclassified: RouteEntry[]
}

export function classifyRouteOwnership(input: ClassifyOwnershipInput): ClassifyOwnershipOutput {
  const canonical = input.routes.filter(r => r.classification === "canonical")
  const redirects = input.routes.filter(r => r.classification === "redirect_to")
  const toRemove = input.routes.filter(r => r.classification === "remove")
  const children = input.routes.filter(r => r.classification === "supporting_child")
  const unclassified = input.routes.filter(r => !["canonical","redirect_to","remove","supporting_child"].includes(r.classification))
  return { canonical, redirects, toRemove, children, unclassified }
}

// ─── COMMAND 3: Validate Canonical Manager Usage ─────────────────────────────

/**
 * Input:  { kernelModules: string[] }
 * Output: { modules: { module: string, canonicalRouteCount: number, status: "verified" | "unverified" }[] }
 *
 * Cross-checks each kernel module against the route registry to verify
 * at least one canonical route claims that kernel as its owner.
 */
export interface ValidateManagerInput {
  kernelModules: string[]
}

export interface ValidateManagerOutput {
  modules: Array<{
    module: string
    canonicalRouteCount: number
    status: "verified" | "unverified"
  }>
  verified: number
  unverified: number
}

export function validateCanonicalManagerUsage(input: ValidateManagerInput): ValidateManagerOutput {
  const { routes } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const canonicals = routes.filter(r => r.classification === "canonical")

  const modules = input.kernelModules.map(mod => {
    const count = canonicals.filter(r => r.kernelOwner === mod).length
    return {
      module: mod,
      canonicalRouteCount: count,
      status: (count > 0 ? "verified" : "unverified") as "verified" | "unverified",
    }
  })

  return {
    modules,
    verified: modules.filter(m => m.status === "verified").length,
    unverified: modules.filter(m => m.status === "unverified").length,
  }
}

// ─── COMMAND 4: Detect Duplicate Manager Surfaces ────────────────────────────

/**
 * Input:  { routes: RouteEntry[] }
 * Output: { duplicateSets: DuplicateSet[], cleanDomains: string[] }
 *
 * Finds domains where more than one canonical route claims ownership.
 * These must be reviewed and one route marked redirect_to or remove.
 */
export interface DetectDuplicatesInput {
  routes: RouteEntry[]
}

export interface DetectDuplicatesOutput {
  duplicateSets: DuplicateSet[]
  cleanDomains: string[]
}

export function detectDuplicateManagerSurfaces(input: DetectDuplicatesInput): DetectDuplicatesOutput {
  const canonicals = input.routes.filter(r => r.classification === "canonical")

  // Group by domain
  const byDomain: Record<string, RouteEntry[]> = {}
  for (const r of canonicals) {
    if (!byDomain[r.domain]) byDomain[r.domain] = []
    byDomain[r.domain].push(r)
  }

  const duplicateSets: DuplicateSet[] = []
  const cleanDomains: string[] = []

  for (const [domain, domainRoutes] of Object.entries(byDomain)) {
    if (domainRoutes.length > 1) {
      // Sort by verified status — verified first is the canonical survivor
      const sorted = [...domainRoutes].sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0))
      duplicateSets.push({
        domain,
        canonical: sorted[0],
        duplicates: sorted.slice(1),
      })
    } else {
      cleanDomains.push(domain)
    }
  }

  return { duplicateSets, cleanDomains }
}

// ─── COMMAND 5: Normalize Navigation Visibility ──────────────────────────────

/**
 * Input:  { userType: string, routes: RouteEntry[] }
 * Output: { visible: RouteEntry[], hidden: RouteEntry[] }
 *
 * Filters routes by access level for a given user type.
 * Ensures navigation never shows routes the user cannot access.
 */
export interface NormalizeNavInput {
  userType: "public" | "authenticated" | "agent" | "broker" | "superadmin"
  routes: RouteEntry[]
}

export interface NormalizeNavOutput {
  visible: RouteEntry[]
  hidden: RouteEntry[]
}

const ACCESS_HIERARCHY: Record<string, number> = {
  public: 0,
  authenticated: 1,
  agent: 2,
  broker: 3,
  superadmin: 4,
}

export function normalizeNavigationVisibility(input: NormalizeNavInput): NormalizeNavOutput {
  const userLevel = ACCESS_HIERARCHY[input.userType] ?? 0

  const visible: RouteEntry[] = []
  const hidden: RouteEntry[] = []

  for (const route of input.routes) {
    const requiredLevel = ACCESS_HIERARCHY[route.accessLevel] ?? 99
    if (userLevel >= requiredLevel && route.classification === "canonical") {
      visible.push(route)
    } else {
      hidden.push(route)
    }
  }

  return { visible, hidden }
}

// ─── COMMAND 6: Validate Provider-Backed Features ────────────────────────────

/**
 * Input:  { domains: string[] }
 * Output: { results: { domain: string, kernelOwner: string, hasCanonicalRoute: boolean }[] }
 *
 * Verifies that each business domain with provider backing
 * has a canonical route classified in the registry.
 */
export interface ValidateProvidersInput {
  domains: string[]
}

export interface ValidateProvidersOutput {
  results: Array<{
    domain: string
    kernelOwner: string | null
    hasCanonicalRoute: boolean
  }>
}

export function validateProviderBackedFeatures(input: ValidateProvidersInput): ValidateProvidersOutput {
  const { routes } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const canonicals = routes.filter(r => r.classification === "canonical")

  const results = input.domains.map(domain => {
    const match = canonicals.find(r => r.domain === domain)
    return {
      domain,
      kernelOwner: match?.kernelOwner ?? null,
      hasCanonicalRoute: !!match,
    }
  })

  return { results }
}

// ─── COMMAND 7: Validate Contract Integrity ──────────────────────────────────

/**
 * Input:  { routes: RouteEntry[] }
 * Output: { findings: CoherenceFinding[] }
 *
 * Checks the route registry for:
 * - Persona-specific routes that are not redirect_to
 * - Redirect routes that have no redirectTarget
 * - Routes with "remove" classification and no removalReason
 */
export interface ValidateContractsInput {
  routes: RouteEntry[]
}

export interface ValidateContractsOutput {
  findings: CoherenceFinding[]
  valid: number
  invalid: number
}

export function validateContractIntegrity(input: ValidateContractsInput): ValidateContractsOutput {
  const findings: CoherenceFinding[] = []
  let valid = 0

  for (const route of input.routes) {
    let routeValid = true

    // Persona-specific routes must be redirect_to, not canonical
    if (route.isPersonaSpecific && route.classification === "canonical") {
      findings.push({
        severity: "critical",
        type: "legacy_persona_route",
        message: `Persona-specific route "${route.path}" is classified as canonical — must be redirect_to.`,
        affected: [route.path],
        recommendation: `Change classification to "redirect_to" pointing to /portal/[contactId]`,
      })
      routeValid = false
    }

    // redirect_to routes must have a redirectTarget
    if (route.classification === "redirect_to" && !route.redirectTarget) {
      findings.push({
        severity: "critical",
        type: "dead_nav_link",
        message: `Route "${route.path}" is classified redirect_to but has no redirectTarget.`,
        affected: [route.path],
        recommendation: `Add redirectTarget field to this route entry.`,
      })
      routeValid = false
    }

    // remove routes must have a removalReason
    if (route.classification === "remove" && !route.removalReason) {
      findings.push({
        severity: "warning",
        type: "duplicate_manager",
        message: `Route "${route.path}" is marked for removal but has no removalReason.`,
        affected: [route.path],
        recommendation: `Add removalReason explaining why this route is a duplicate.`,
      })
      routeValid = false
    }

    if (routeValid) valid++
  }

  return { findings, valid, invalid: input.routes.length - valid }
}

// ─── COMMAND 8: Generate Domain Coherence Report ─────────────────────────────

/**
 * Input:  { includeRecommendations?: boolean }
 * Output: CoherenceReport
 *
 * Synthesizes all 7 commands into a single actionable report.
 * This is the top-level kernel command consumed by the admin UI.
 */
export interface GenerateReportInput {
  includeRecommendations?: boolean
}

export function generateDomainCoherenceReport(input: GenerateReportInput): CoherenceReport {
  const KERNEL_MODULES = [
    "lib/kernel/portal.ts",
    "lib/kernel/billing.ts",
    "lib/kernel/vendors.ts",
    "lib/kernel/education.ts",
    "lib/kernel/video.ts",
    "lib/kernel/lead-magnets.ts",
    "lib/kernel/communication-compliance.ts",
    "lib/kernel/forms.ts",
    "lib/kernel/routes.ts",
    "lib/kernel/transactions.ts",
    "lib/kernel/listings.ts",
  ]

  const PROVIDER_DOMAINS = [
    "portal", "billing", "vendors", "education", "video",
    "lead_magnets", "compliance", "forms", "transactions", "listings",
  ]

  const { routes, total } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const classification = classifyRouteOwnership({ routes })
  const { duplicateSets, cleanDomains } = detectDuplicateManagerSurfaces({ routes })
  const managerValidation = validateCanonicalManagerUsage({ kernelModules: KERNEL_MODULES })
  const contractValidation = validateContractIntegrity({ routes })

  const findings: CoherenceFinding[] = [...contractValidation.findings]

  // Flag unverified kernel modules
  for (const mod of managerValidation.modules) {
    if (mod.status === "unverified") {
      findings.push({
        severity: "warning",
        type: "bypass_kernel",
        message: `Kernel module "${mod.module}" has no canonical route claiming it as owner.`,
        affected: [mod.module],
        recommendation: `Add a canonical route entry in enumerateDomainRoutes() for this module.`,
      })
    }
  }

  // Flag duplicate manager surfaces
  for (const set of duplicateSets) {
    findings.push({
      severity: "warning",
      type: "duplicate_manager",
      message: `Domain "${set.domain}" has ${set.duplicates.length + 1} canonical routes. Only one should be canonical.`,
      affected: [set.canonical.path, ...set.duplicates.map(d => d.path)],
      recommendation: `Keep "${set.canonical.path}" as canonical. Mark others as redirect_to or remove.`,
    })
  }

  const criticalCount = findings.filter(f => f.severity === "critical").length
  const warningCount = findings.filter(f => f.severity === "warning").length

  const overallStatus: CoherenceReport["overallStatus"] =
    criticalCount > 0 ? "critical" :
    warningCount > 0 ? "needs_review" :
    "clean"

  return {
    generatedAt: new Date().toISOString(),
    totalRoutes: total,
    canonicalCount: classification.canonical.length,
    redirectCount: classification.redirects.length,
    removeCount: classification.toRemove.length,
    duplicateSets,
    findings,
    overallStatus,
  }
}
