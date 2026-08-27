"use server"

/**
 * app/actions/direct-mail-size-prefs.ts
 *
 * Wave 36 — server actions for the per-persona × use_kind size
 * preference matrix. Read + save against the resolved scope row
 * (agent / team / brokerage), gated by resolvePolicyScopeAccess so
 * each tier only writes its own jsonb column.
 *
 * Shape stored:
 *   { "<use_kind>:<persona>": "4x6" | "6x9", ... }
 *
 * The UI omits keys for cells the subscriber hasn't explicitly
 * overridden — the resolver then falls through to the next tier or
 * to the platform recommendation. This keeps the jsonb small and
 * makes "reset to default" a delete operation, not an explicit
 * null write.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { revalidatePath } from "next/cache"
import type { Persona } from "@/lib/kernel/types"
import { getPlatformRecommendation, type DirectMailUseKind, type PostcardSize } from "@/lib/direct-mail/resolve-size-pref"

export type ScopeType = "agent" | "team" | "brokerage"

// TOMBSTONE (§1.3, 2026-08-27): `SizePrefMatrix` deleted — a restatement of the
// matrix that nothing referenced. The matrix contract's one spelling is
// getSizePrefsMatrix's explicit return type below (scopeId + sparse overrides +
// resolved cells), which is what the settings client actually consumes.

export interface SizePrefCell {
  use_kind:        DirectMailUseKind
  persona:         Persona
  /** What WILL ship (after the cascade). */
  effective_size:  PostcardSize
  /** Where it came from. */
  source:          "agent" | "team" | "brokerage" | "platform_recommendation" | "platform_default"
  /** Platform recommendation (the "Recommended:" hint). */
  recommendation:  PostcardSize
}

/** Resolve the scope ID for the requested tier, returning null when
 *  the caller can't edit that tier. */
function pickScope(access: Awaited<ReturnType<typeof resolvePolicyScopeAccess>>, scopeType: ScopeType, teamHint?: string): string | null {
  if (scopeType === "agent")     return access.canEditAgent     ? access.agentScopeId     : null
  if (scopeType === "team")      return access.canEditTeam      ? (teamHint ?? access.teamScopeIds[0] ?? null) : null
  if (scopeType === "brokerage") return access.canEditBrokerage ? access.brokerageScopeId : null
  return null
}

const USE_KINDS: DirectMailUseKind[] = ["farm_mail", "welcome_kit", "sphere_outreach"]
const PERSONAS:  Persona[] = [
  "first_time", "relocated", "luxury", "fsbo", "probate",
  "upsize", "downsize", "military", "divorce", "senior",
  "expired", "foreclosure", "other",
]

export async function getSizePrefsMatrix(args: {
  scopeType: ScopeType
  teamId?:   string
}): Promise<{
  success: true
  scopeId: string
  overrides: Record<string, PostcardSize>
  cells: SizePrefCell[]
  scopeOptions: { agent: boolean; team: { id: string; name: string }[]; brokerage: boolean }
} | { success: false; error: string }> {
  const access = await resolvePolicyScopeAccess()
  const scopeId = pickScope(access, args.scopeType, args.teamId)
  if (!scopeId) return { success: false, error: `Cannot edit ${args.scopeType} scope` }

  const svc = createServiceClient()
  const table = args.scopeType === "agent" ? "agents"
              : args.scopeType === "team"  ? "teams"
              : "brokerages"
  const idColumn = args.scopeType === "agent" ? "user_id" : "id"
  // For agents, the access scope returns the AGENTS.id, but the resolver
  // reads by user_id. We need to map agents.id → user_id for the read.
  let lookupId = scopeId
  if (args.scopeType === "agent") {
    const { data } = await svc.from("agents").select("user_id").eq("id", scopeId).maybeSingle()
    lookupId = (data?.user_id as string | undefined) ?? scopeId
  }

  const { data: row } = await svc
    .from(table)
    .select("direct_mail_size_prefs")
    .eq(idColumn, lookupId)
    .maybeSingle()
  const overrides = (row?.direct_mail_size_prefs ?? {}) as Record<string, PostcardSize>

  // Build the 13×3 effective grid — what ships if the subscriber doesn't
  // change anything. We need agent + team + brokerage rows together to
  // compute the cascade for any single cell.
  const [agentRow, teamRow, brokerageRow] = await Promise.all([
    access.agentScopeId
      ? svc.from("agents").select("user_id, direct_mail_size_prefs").eq("id", access.agentScopeId).maybeSingle()
      : Promise.resolve({ data: null }),
    args.teamId
      ? svc.from("teams").select("direct_mail_size_prefs").eq("id", args.teamId).maybeSingle()
      : access.teamScopeIds.length > 0
        ? svc.from("teams").select("direct_mail_size_prefs").eq("id", access.teamScopeIds[0]).maybeSingle()
        : Promise.resolve({ data: null }),
    access.brokerageScopeId
      ? svc.from("brokerages").select("direct_mail_size_prefs").eq("id", access.brokerageScopeId).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const agentPrefs     = (agentRow.data as { direct_mail_size_prefs?: Record<string, PostcardSize> } | null)?.direct_mail_size_prefs ?? {}
  const teamPrefs      = (teamRow.data  as { direct_mail_size_prefs?: Record<string, PostcardSize> } | null)?.direct_mail_size_prefs ?? {}
  const brokeragePrefs = (brokerageRow.data as { direct_mail_size_prefs?: Record<string, PostcardSize> } | null)?.direct_mail_size_prefs ?? {}

  const cells: SizePrefCell[] = []
  for (const useKind of USE_KINDS) {
    for (const persona of PERSONAS) {
      const key = `${useKind}:${persona}`
      const recommendation = getPlatformRecommendation(useKind, persona)
      let effective: PostcardSize = recommendation
      let source: SizePrefCell["source"] = "platform_recommendation"
      if (agentPrefs[key])     { effective = agentPrefs[key];     source = "agent" }
      else if (teamPrefs[key]) { effective = teamPrefs[key];      source = "team" }
      else if (brokeragePrefs[key]) { effective = brokeragePrefs[key]; source = "brokerage" }
      cells.push({ use_kind: useKind, persona, effective_size: effective, source, recommendation })
    }
  }

  // For the scope picker — what tiers can the caller edit?
  // (Pre-resolved team names so the UI doesn't need another round-trip.)
  let teamOptions: Array<{ id: string; name: string }> = []
  if (access.canEditTeam && access.teamScopeIds.length > 0) {
    const { data: teams } = await svc.from("teams").select("id, name").in("id", access.teamScopeIds)
    teamOptions = ((teams ?? []) as Array<{ id: string; name: string | null }>).map((t) => ({ id: t.id, name: t.name ?? "Unnamed team" }))
  }

  return {
    success: true,
    scopeId,
    overrides,
    cells,
    scopeOptions: {
      agent:     access.canEditAgent,
      team:      teamOptions,
      brokerage: access.canEditBrokerage,
    },
  }
}

export async function saveSizePrefCell(args: {
  scopeType: ScopeType
  teamId?:   string
  useKind:   DirectMailUseKind
  persona:   Persona
  /** "reset" deletes the override so the cascade re-takes over. */
  size:      PostcardSize | "reset"
}): Promise<{ success: boolean; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  const scopeId = pickScope(access, args.scopeType, args.teamId)
  if (!scopeId) return { success: false, error: `Cannot edit ${args.scopeType} scope` }

  const svc = createServiceClient()
  const table = args.scopeType === "agent" ? "agents"
              : args.scopeType === "team"  ? "teams"
              : "brokerages"
  const idColumn = args.scopeType === "agent" ? "user_id" : "id"
  let lookupId = scopeId
  if (args.scopeType === "agent") {
    const { data } = await svc.from("agents").select("user_id").eq("id", scopeId).maybeSingle()
    lookupId = (data?.user_id as string | undefined) ?? scopeId
  }

  // Read-modify-write the jsonb. Concurrent writes from two browsers
  // would race, but the matrix UI's per-cell save is naturally serial
  // from a single user — and a stale write at worst loses one cell
  // that the next save would recover.
  const { data: row } = await svc
    .from(table)
    .select("direct_mail_size_prefs")
    .eq(idColumn, lookupId)
    .maybeSingle()
  const prefs = ((row?.direct_mail_size_prefs ?? {}) as Record<string, PostcardSize>)
  const key = `${args.useKind}:${args.persona}`
  if (args.size === "reset") delete prefs[key]
  else                        prefs[key] = args.size

  const { error } = await svc
    .from(table)
    .update({ direct_mail_size_prefs: prefs })
    .eq(idColumn, lookupId)
  if (error) return { success: false, error: error.message }

  revalidatePath("/settings/direct-mail/size-prefs")
  return { success: true }
}
