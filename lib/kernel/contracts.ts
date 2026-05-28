// lib/kernel/contracts.ts
// Normalized payload contracts for all parent→child component bindings.
// Every component rendered with data from a Server Component must match
// the exact input contract defined here.
// Import from '@/lib/kernel' — never directly.
// No default exports.

// ─── BROKERAGE COMPONENT CONTRACTS ────────────────────────────────────────────

export interface BrokerageAgentContract {
  /** Agent identifier — FK to users.id */
  id: string
  name?: string
  first_name?: string
  last_name?: string
  email: string
  avatar_url?: string
  status?: string
  /** YTD closed deal count */
  deals_ytd?: number
  /** YTD sales volume in USD */
  volume_ytd?: number
  trend?: "up" | "down" | "stable"
  active_listings?: number
  closed_transactions?: number
  revenue?: number
}

export interface BrokerageAgentListInput {
  agents: BrokerageAgentContract[]
  brokerageId?: string
}

export interface BrokerageRevenueInput {
  forecast?: Array<{
    month?: string
    period?: string
    projected_gci?: number
    actual_gci?: number
    deal_count?: number
  }> | null
  totalGCI: number
  pendingCommissions: number
}

export interface BrokerageComplianceInput {
  brokerageId?: string
  complianceRate: number
}

// ─── COORDINATOR COMPONENT CONTRACTS ──────────────────────────────────────────

export interface CoordinatorTransactionContract {
  id: string
  property_address: string
  close_date?: string
  status: string
  stage?: string
  purchase_price?: number
  health_score?: number
  deal_health?: {
    overall_score: number
    risk_level: string
    flags: string[]
    previous_score?: number
    score_delta?: number
    ai_narrative?: string
  }
  agent_id?: string
}

export interface CoordinatorTransactionListInput {
  transactions: CoordinatorTransactionContract[]
}

export interface CoordinatorDeadlineContract {
  id: string
  deadline_type: string
  deadline_date: string
  status: string
  notes?: string
  transaction_id: string
  transactions?: { property_address: string }
}

export interface DeadlineTrackingInput {
  deadlines: CoordinatorDeadlineContract[]
}

export interface CoordinatorMilestoneContract {
  id: string
  milestone_name: string
  status: string
  target_date?: string
  transaction_id: string
  transactions?: { property_address: string }
}

export interface MilestoneQueueInput {
  milestones: CoordinatorMilestoneContract[]
}

export interface CoordinatorHealthScoreContract {
  transaction_id: string
  overall_score: number
  risk_level: string
  flags: string[]
  previous_score?: number
  score_delta?: number
  ai_narrative?: string
}

export interface HealthOverviewInput {
  transactions: CoordinatorTransactionContract[]
  healthScores: CoordinatorHealthScoreContract[]
}

// ─── KERNEL COMMAND STUBS ─────────────────────────────────────────────────────
// These are the canonical audit commands referenced in the kernel spec.
// Full implementations live in scripts or admin tooling, not at runtime.

export interface ComponentImportAuditInput {
  rootDir: string
  canonicalRoot: "app/components"
}

export interface ComponentImportAuditOutput {
  success: boolean
  errors: string[]
  warnings: string[]
  duplicates: Array<{ path: string; locations: string[] }>
  orphans: string[]
}

/**
 * auditComponentImports — enumerate all import paths across the project and
 * flag any that resolve outside app/components.
 * Runtime implementation: scripts/audit-component-imports.ts
 */
export type AuditComponentImports = (input: ComponentImportAuditInput) => Promise<ComponentImportAuditOutput>

/**
 * resolveCanonicalComponentPath — given a legacy import path, return the
 * normalized canonical path that tsconfig will resolve correctly.
 */
export function resolveCanonicalComponentPath(importPath: string): string {
  // Normalize @/components/* → canonical (tsconfig already maps this correctly)
  // Relative ../../components/* → warn: convert to @/components/*
  if (importPath.startsWith("@/components/")) return importPath
  if (importPath.includes("/components/")) {
    const idx = importPath.lastIndexOf("/components/")
    return `@/components/${importPath.slice(idx + "/components/".length)}`
  }
  return importPath
}

/**
 * validateUiSurfaceIntegrity — returns a structured pass/fail for the UI layer.
 * Checks that every @/components/* import resolves to an existing file in app/components.
 */
export interface UiSurfaceIntegrityReport {
  passed: boolean
  missingFiles: string[]
  propMismatches: string[]
  summary: string
}

export function buildIntegrityReport(
  missingFiles: string[],
  propMismatches: string[],
): UiSurfaceIntegrityReport {
  const passed = missingFiles.length === 0 && propMismatches.length === 0
  return {
    passed,
    missingFiles,
    propMismatches,
    summary: passed
      ? "UI surface integrity verified. All @/components/* imports resolve correctly."
      : `UI surface integrity FAILED. Missing: ${missingFiles.length}, Prop mismatches: ${propMismatches.length}.`,
  }
}
