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
