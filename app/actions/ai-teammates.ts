"use server"

/**
 * app/actions/ai-teammates.ts
 *
 * TENANT AI-TEAMMATE CRUD — the tenant names and charters their OWN AI
 * teammates on top of the built-in manager bench ("Maya — Luxury Listings
 * Concierge" on the Marketing Manager). Tier-parity principal-gated (the same
 * isTenancyPrincipal rule the Earned Autonomy + QBR actions use: broker/admin
 * always; a solo agent IS their own broker; a team lead governs a team
 * signup). Tenant-scoped by the caller's brokerage — never a client-supplied
 * brokerage id.
 *
 * The AUTONOMY CLAMP is enforced HERE, against the real earned-autonomy
 * policy source: the grant ledgers the autonomy ratchet writes on
 * managed_agents.config (deal_coordinator.doc_kernel_grants /
 * campaign_orchestrator.marketing_grants — lib/documents/autonomy-ratchet.ts).
 * A requested 'autonomous' is silently-honestly clamped to 'approved_send'
 * (with the reason returned) unless the tenancy has at least one earned grant
 * in the base manager's domain. Editing can therefore RAISE autonomy only as
 * far as the ledger allows — naming a teammate never loosens an ungranted gate.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { isTenancyPrincipal } from "@/lib/kernel/tenancy-principal"
import { loadGrantsFor } from "@/lib/documents/autonomy-ratchet"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import {
  validateTeammateInput,
  clampTeammateAutonomy,
  grantLedgerForManager,
  teammateLimitForTier,
  type TeammateInput,
  type TeammateAutonomy,
  type TeammateStatus,
} from "@/lib/kernel/ai-teammates"

const COMMAND_CENTER_PATH = "/dashboard/admin/command-center"

export interface AiTeammateView {
  id: string
  name: string
  roleTitle: string
  baseManagerKey: string
  baseManagerLabel: string
  charter: string
  focusTags: string[]
  autonomy: TeammateAutonomy
  status: TeammateStatus
  createdAt: string | null
}

interface Principal {
  userId: string
  brokerageId: string
}

/** Tier-parity principal gate — the repo's governance-action idiom. */
async function requireTeammatePrincipal(): Promise<Principal | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }
  const { data: me } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  const brokerageId = (me as any)?.brokerage_id as string | null
  if (!brokerageId) return { error: "No brokerage on your account — contact your admin" }
  // user_type, never legacy users.role — PRINCIPAL_ROLES is user_type vocabulary.
  const role = String((me as any)?.user_type ?? "")
  const svc = createServiceClient()
  const principal = await isTenancyPrincipal(svc, { userId: user.id, brokerageId, role })
  if (!principal) return { error: "Only the tenancy principal (broker/admin, solo agent, or team lead) can manage AI teammates" }
  return { userId: user.id, brokerageId }
}

function rowToView(row: Record<string, any>): AiTeammateView {
  const key = String(row.base_manager_key ?? "")
  return {
    id: row.id,
    name: row.name ?? "",
    roleTitle: row.role_title ?? "",
    baseManagerKey: key,
    baseManagerLabel: key in MANAGERS ? MANAGERS[key as ManagerKey].label : key,
    charter: row.charter ?? "",
    focusTags: Array.isArray(row.focus_tags) ? row.focus_tags.map(String) : [],
    autonomy: (row.autonomy ?? "draft_only") as TeammateAutonomy,
    status: (row.status ?? "active") as TeammateStatus,
    createdAt: row.created_at ?? null,
  }
}

/** Earned shapes on the base manager's grant ledger — 0 when the manager has
 *  no ratchetable domain. Fail CLOSED (no ledger read → no autonomous act). */
async function countEarnedShapes(brokerageId: string, baseManagerKey: ManagerKey): Promise<number> {
  const ledger = grantLedgerForManager(baseManagerKey)
  if (!ledger) return 0
  const svc = createServiceClient()
  const shapes = await loadGrantsFor(svc, brokerageId, ledger.agentKind, ledger.configKey)
  return shapes.size
}

// ─── LIST ────────────────────────────────────────────────────────────────────

export async function listAiTeammatesAction(): Promise<
  | {
      ok: true
      teammates: AiTeammateView[]
      /** null = unlimited on this tier. */
      limit: number | null
      tier: string
      /** Base manager keys where 'autonomous' is currently unlockable (≥1 earned grant). */
      autonomousUnlocked: string[]
    }
  | { ok: false; error: string }
> {
  const actor = await requireTeammatePrincipal()
  if ("error" in actor) return { ok: false, error: actor.error }
  const svc = createServiceClient()

  const [{ data: rows, error }, { data: brk }] = await Promise.all([
    svc.from("tenant_ai_teammates")
      .select("id, name, role_title, base_manager_key, charter, focus_tags, autonomy, status, created_at")
      .eq("brokerage_id", actor.brokerageId)
      .neq("status", "retired")
      .order("created_at", { ascending: true })
      .limit(50),
    svc.from("brokerages").select("plan_tier").eq("id", actor.brokerageId).maybeSingle(),
  ])
  if (error) return { ok: false, error: error.message }

  const tier = String((brk as any)?.plan_tier ?? "solo_agent")

  // Which domains have EARNED autonomy available right now (for honest UI copy).
  const [dealGrants, mktGrants] = await Promise.all([
    loadGrantsFor(svc, actor.brokerageId, "deal_coordinator", "doc_kernel_grants"),
    loadGrantsFor(svc, actor.brokerageId, "campaign_orchestrator", "marketing_grants"),
  ])
  const autonomousUnlocked: string[] = []
  if (dealGrants.size > 0) autonomousUnlocked.push("deal_coordinator")
  if (mktGrants.size > 0) autonomousUnlocked.push("campaign_orchestrator", "marketing_agent")

  return {
    ok: true,
    teammates: ((rows ?? []) as Record<string, any>[]).map(rowToView),
    limit: teammateLimitForTier(tier),
    tier,
    autonomousUnlocked,
  }
}

// ─── CREATE ──────────────────────────────────────────────────────────────────

export async function createAiTeammateAction(input: TeammateInput): Promise<
  | { ok: true; teammate: AiTeammateView; autonomyNote: string | null }
  | { ok: false; error: string }
> {
  const actor = await requireTeammatePrincipal()
  if ("error" in actor) return { ok: false, error: actor.error }

  const v = validateTeammateInput(input)
  if (!v.ok) return { ok: false, error: v.errors.join(" ") }

  const svc = createServiceClient()

  // Tier cap — counted over non-retired teammates (a retired charter frees its slot).
  const { data: brk } = await svc.from("brokerages").select("plan_tier").eq("id", actor.brokerageId).maybeSingle()
  const tier = String((brk as any)?.plan_tier ?? "solo_agent")
  const limit = teammateLimitForTier(tier)
  if (limit !== null) {
    const { count } = await svc.from("tenant_ai_teammates")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", actor.brokerageId)
      .neq("status", "retired")
    if ((count ?? 0) >= limit) {
      return {
        ok: false,
        error: `Your plan includes ${limit} custom AI teammate${limit === 1 ? "" : "s"} — retire one or upgrade to add more.`,
      }
    }
  }

  // THE CLAMP — requested autonomy never exceeds what the tenancy has earned.
  const earned = await countEarnedShapes(actor.brokerageId, v.value.baseManagerKey)
  const clamp = clampTeammateAutonomy(v.value.autonomy, v.value.baseManagerKey, earned)

  const { data: row, error } = await svc.from("tenant_ai_teammates")
    .insert({
      brokerage_id: actor.brokerageId,
      name: v.value.name,
      role_title: v.value.roleTitle,
      base_manager_key: v.value.baseManagerKey,
      charter: v.value.charter,
      focus_tags: v.value.focusTags,
      autonomy: clamp.autonomy,
      status: "active",
      created_by: actor.userId,
    })
    .select("id, name, role_title, base_manager_key, charter, focus_tags, autonomy, status, created_at")
    .single()
  if (error) return { ok: false, error: error.message }

  revalidatePath(COMMAND_CENTER_PATH)
  return { ok: true, teammate: rowToView(row as Record<string, any>), autonomyNote: clamp.reason }
}

// ─── UPDATE ──────────────────────────────────────────────────────────────────

export async function updateAiTeammateAction(params: { id: string } & TeammateInput): Promise<
  | { ok: true; teammate: AiTeammateView; autonomyNote: string | null }
  | { ok: false; error: string }
> {
  const actor = await requireTeammatePrincipal()
  if ("error" in actor) return { ok: false, error: actor.error }

  const v = validateTeammateInput(params)
  if (!v.ok) return { ok: false, error: v.errors.join(" ") }

  const svc = createServiceClient()
  const { data: existing } = await svc.from("tenant_ai_teammates")
    .select("id, status")
    .eq("id", params.id)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()
  if (!existing) return { ok: false, error: "Teammate not found in your brokerage" }
  if ((existing as any).status === "retired") return { ok: false, error: "A retired teammate can't be edited" }

  const earned = await countEarnedShapes(actor.brokerageId, v.value.baseManagerKey)
  const clamp = clampTeammateAutonomy(v.value.autonomy, v.value.baseManagerKey, earned)

  const { data: row, error } = await svc.from("tenant_ai_teammates")
    .update({
      name: v.value.name,
      role_title: v.value.roleTitle,
      base_manager_key: v.value.baseManagerKey,
      charter: v.value.charter,
      focus_tags: v.value.focusTags,
      autonomy: clamp.autonomy,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id)
    .eq("brokerage_id", actor.brokerageId)
    .select("id, name, role_title, base_manager_key, charter, focus_tags, autonomy, status, created_at")
    .single()
  if (error) return { ok: false, error: error.message }

  revalidatePath(COMMAND_CENTER_PATH)
  return { ok: true, teammate: rowToView(row as Record<string, any>), autonomyNote: clamp.reason }
}

// ─── STATUS (pause / reactivate / retire) ────────────────────────────────────

export async function setAiTeammateStatusAction(params: { id: string; status: TeammateStatus }): Promise<
  | { ok: true; teammate: AiTeammateView }
  | { ok: false; error: string }
> {
  const actor = await requireTeammatePrincipal()
  if ("error" in actor) return { ok: false, error: actor.error }
  if (!["active", "paused", "retired"].includes(params.status)) {
    return { ok: false, error: "Invalid status" }
  }

  const svc = createServiceClient()
  const { data: row, error } = await svc.from("tenant_ai_teammates")
    .update({ status: params.status, updated_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("brokerage_id", actor.brokerageId)
    .select("id, name, role_title, base_manager_key, charter, focus_tags, autonomy, status, created_at")
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!row) return { ok: false, error: "Teammate not found in your brokerage" }

  revalidatePath(COMMAND_CENTER_PATH)
  return { ok: true, teammate: rowToView(row as Record<string, any>) }
}
