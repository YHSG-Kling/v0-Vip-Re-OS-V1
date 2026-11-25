"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity/get-agent-context"

// ============================================================================
// SERVICE REGISTRY
// ============================================================================

const SERVICE_DEFAULTS = [
  {
    id: "gohighlevel",
    name: "GoHighLevel",
    type: "CRM & Communication",
    description: "SMS, calling, contact sync",
    config_keys: ["api_key", "location_id"],
    env_key: "GHL_API_KEY",
  },
  {
    id: "did",
    name: "D-ID",
    type: "AI Video Generation",
    description: "Generate personalized avatar / talking-head videos (platform engine; voice via ElevenLabs)",
    config_keys: ["api_key", "avatar_id"],
    env_key: "DID_API_KEY",
  },
  {
    id: "idx_broker",
    name: "IDX Broker",
    type: "Property Search",
    description: "MLS property listings and search",
    config_keys: ["api_key", "partner_key"],
    env_key: "IDXBROKER_API_KEY",
  },
  {
    id: "dotloop",
    name: "Dotloop",
    type: "Transaction Management",
    description: "Document storage and e-signatures",
    config_keys: ["api_key"],
    env_key: "DOTLOOP_API_KEY",
  },
  {
    id: "peopledatalabs",
    name: "PeopleDataLabs",
    type: "Contact Enrichment",
    description: "Person data enrichment",
    config_keys: ["api_key"],
    env_key: "PDL_API_KEY",
  },
  {
    id: "batchdata",
    name: "BatchData",
    type: "Property Data",
    description: "Property records and valuations",
    config_keys: ["api_key"],
    env_key: "BATCHDATA_API_KEY",
  },
]

export async function getServicesRegistry() {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  // Query brokerage_integrations for any registered integrations
  const { data: dbIntegrations } = brokerageId
    ? await supabase
        .from("brokerage_integrations")
        .select("provider_name, provider_type, status, last_health_check_at, last_error, metadata")
        .eq("brokerage_id", brokerageId)
    : { data: [] }

  // Wave 156 (156G): the platform's activation declaration, read at request time (server-side dynamic import — no static weight).
  const { PROVIDER_ACTIVATION } = await import("@/lib/ai-isa/property-lookup-rail")
  const DORMANT_STATE: Record<string, boolean> = { batchdata: PROVIDER_ACTIVATION.batchdata.state !== "active", peopledatalabs: PROVIDER_ACTIVATION.peopledata.state !== "active" }

  // Merge DB status with hardcoded defaults
  const services = SERVICE_DEFAULTS.map((svc) => {
    const dbRecord = (dbIntegrations ?? []).find(
      (r: any) => r.provider_name?.toLowerCase() === svc.name.toLowerCase()
    )
    return {
      id: svc.id,
      name: svc.name,
      type: svc.type,
      description: svc.description,
      // config_keys is deliberately NOT returned. The settings card used to
      // render a password input per key and discard whatever was typed; these
      // are platform-held env secrets with no per-brokerage store, so nothing
      // consumes the list. It stays on SERVICE_DEFAULTS as the ops record of
      // which env vars each integration needs.
      // Wave 156 (156G): a platform env key being SET is not a connection — it reads "configured" (never live-verified here),
      // and a provider the platform keeps DORMANT (PROVIDER_ACTIVATION — e.g. BatchData / PeopleData, owner ruling R9) reads
      // "dormant" whether or not a key is set: it is not in use, so it is never shown as connected.
      status: dbRecord?.status ?? (DORMANT_STATE[svc.id] ? "dormant" : process.env[svc.env_key] ? "configured" : "not_configured"),
      last_checked_at: dbRecord?.last_health_check_at ?? null,
      last_error: dbRecord?.last_error ?? null,
    }
  })

  return { services }
}

// ============================================================================
// AI AGENT TEMPLATES
// ============================================================================

/** Map an ai_agent_templates row to the flat shape the settings UI renders. The per-template AI config
 *  (agent_type/system_prompt/model/temperature/capabilities) lives in the template_config jsonb. */
function mapTemplateRow(t: any) {
  const c = (t?.template_config ?? {}) as Record<string, unknown>
  return {
    id: t.id,
    agent_name: t.template_name ?? "",
    active: !!t.is_active,
    agent_type: (c.agent_type as string) ?? "",
    system_prompt: (c.system_prompt as string) ?? "",
    model: (c.model as string) ?? "",
    temperature: typeof c.temperature === "number" ? c.temperature : 0.7,
    capabilities: Array.isArray(c.capabilities) ? c.capabilities : [],
  }
}

export async function getAIAgentTemplates() {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  // AI agent templates live in ai_agent_templates — NOT the human `agents` table (that was the bug:
  // this screen listed/inserted human agents). Show the brokerage's own templates + any global ones.
  let query = supabase.from("ai_agent_templates").select("*").order("created_at", { ascending: true })
  if (brokerageId) query = query.or(`brokerage_id.eq.${brokerageId},is_global.eq.true`)
  else query = query.eq("is_global", true)
  const { data, error } = await query

  if (error) {
    console.error("Error fetching AI agent templates:", error)
    return { agents: [] }
  }

  return { agents: (data || []).map(mapTemplateRow) }
}

export async function createAIAgentTemplate(params: {
  agent_name: string
  agent_type: string
  system_prompt: string
  model: string
  temperature: number
  capabilities: string[]
}) {
  const supabase = await createClient()
  const { brokerageId, userId } = await getAgentContext()
  if (!brokerageId) return { success: false as const, error: "Not authenticated" }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return ledgerSessionAction({ brokerageId: brokerageId, action: "services.ai_agent_template.create", actor: { type: "user", userId: userId }, subject: { type: "brokerage", id: brokerageId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, async () => {

  // Flat config fields go into the template_config jsonb; identity into template_name/is_active.
  const { data, error } = await supabase
    .from("ai_agent_templates")
    .insert({
      brokerage_id: brokerageId,
      template_name: params.agent_name,
      description: params.agent_type,
      template_config: {
        agent_type: params.agent_type,
        system_prompt: params.system_prompt,
        model: params.model,
        temperature: params.temperature,
        capabilities: params.capabilities,
      },
      is_active: true,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/settings/services")
  return { success: true as const, agent: mapTemplateRow(data) }
  }).then((r) => ("agent" in r ? r : { success: false as const, error: r.error ?? "Not run" }))
}

/**
 * The ONE AI-agent-template toggle.
 *
 * Absorbed `toggleAIAgentTemplateStatus`, which was a second, unwired copy of
 * this with no `getAgentContext()` check and no brokerage scope — and which
 * could never have worked anyway: it wrote a column named `enabled`, and
 * `ai_agent_templates` has no such column (the live column is `is_active`,
 * verified against the database). Its only genuine difference was returning
 * the updated row, which is ported here as an additive `template` field.
 */
export async function toggleAIAgentTemplate(agentId: string, active: boolean) {
  const supabase = await createClient()
  const { brokerageId, userId } = await getAgentContext()
  if (!brokerageId) return { success: false as const, error: "Not authenticated" }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return ledgerSessionAction({ brokerageId: brokerageId, action: "services.ai_agent_template.toggle", actor: { type: "user", userId: userId }, subject: { type: "ai_agent_template", id: agentId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { is_active: active } }, async () => {

  // Brokerage-scoped so a user can only toggle their own templates (global templates stay read-only here).
  const { data, error } = await supabase
    .from("ai_agent_templates")
    .update({ is_active: active, updated_at: new Date().toISOString() })
    .eq("id", agentId)
    .eq("brokerage_id", brokerageId)
    .select()
    .maybeSingle()

  if (error) throw error

  revalidatePath("/settings/services")
  return { success: true as const, template: data ?? null }
  }).then((r) => ("template" in r ? r : { success: false as const, error: r.error ?? "Not run" }))
}

// ============================================================================
// PLAYBOOKS
// ============================================================================

export async function getPlaybooks() {
  const supabase = await createClient()

  const { data, error } = await supabase.from("plan_tasks").select("*").order("usage_count", { ascending: false })

  if (error) {
    console.error("Error fetching playbooks:", error)
    return { playbooks: [] }
  }

  return { playbooks: data || [] }
}

/**
 * Create a playbook.
 *
 * STAMPED (was not) — this is the root cause `togglePlaybook` below was pointing at.
 * A playbook is unambiguously tenant configuration, and every live `plan_tasks` policy
 * (select/insert-check/update-both-clauses/delete, all granted to `authenticated`) reads
 * `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`. A NULL
 * brokerage_id SATISFIES that predicate for EVERY tenant, so an unstamped playbook was
 * published to — and editable and deletable by — every signed-in user of every other
 * brokerage. The column is nullable, so the write always succeeded and nothing surfaced.
 *
 * The tenant comes from the SESSION via `getAgentContext()`, never from a parameter:
 * this is a `"use server"` export, so any argument is caller-chosen.
 */
export async function createPlaybook(params: {
  playbook_name: string
  trigger_type: string
  steps: any[]
  target_persona_ids: string[]
}) {
  const supabase = await createClient()
  const { brokerageId, userId } = await getAgentContext()
  // Refuse rather than write untenanted — a NULL stamp publishes the playbook platform-wide.
  if (!brokerageId) return { success: false as const, error: "Not authenticated" }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return ledgerSessionAction({ brokerageId: brokerageId, action: "services.playbook.create", actor: { type: "user", userId: userId }, subject: { type: "brokerage", id: brokerageId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, async () => {

  const { data, error } = await supabase
    .from("plan_tasks")
    .insert({
      brokerage_id: brokerageId,
      // plan_tasks is a MERGED table (copilot plan tasks + playbooks) and
      // `task_description` is NOT NULL with no default and no trigger. This
      // writer never set it, so every call raised a not-null violation and hit
      // `throw error` below — createPlaybook has never once created a row, which
      // is why plan_tasks is empty. Mirroring the name is the convention its
      // sibling already uses: academy.ts:cloneTemplate writes the same value to
      // both columns.
      task_description: params.playbook_name,
      playbook_name: params.playbook_name,
      trigger_type: params.trigger_type,
      steps: params.steps,
      target_persona_ids: params.target_persona_ids,
      active: true,
      usage_count: 0,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/settings/services")
  return { success: true, playbook: data }
  }).then((r) => ("playbook" in r ? r : { success: false as const, error: r.error ?? "Not run" }))
}

/**
 * The ONE playbook toggle.
 *
 * Absorbed `togglePlaybookStatus`, an unwired byte-for-byte sibling whose only
 * difference was returning the updated row — ported here as `playbook`.
 *
 * The `getAgentContext()` check is NEW and is the point of the merge. Neither
 * copy authenticated, and this is a `"use server"` export, so both were
 * reachable anonymously. RLS was the only thing standing behind them, and the
 * live `plan_tasks_tenant_update` policy is
 * `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()` — that
 * first clause hands every NULL-tenant row to anon. Requiring a session closes
 * the anonymous path without narrowing which rows a signed-in user may toggle,
 * so nothing that works today stops working.
 *
 * ROOT CAUSE NOW CLOSED AT THE WRITER: `createPlaybook` above stamps
 * `brokerage_id` from the session, so new playbooks no longer land in that
 * permissive `brokerage_id IS NULL` branch — the same RLS predicate that used to
 * publish them now scopes them. No `.eq("brokerage_id", …)` is added here on top
 * of that: `plan_tasks_tenant_update` already carries the brokerage test in both
 * its USING and WITH CHECK clauses, so a stamped row is only toggleable by its
 * own tenant. `plan_tasks` held zero rows when the writer was fixed (verified
 * live), so there is no NULL-tenant backlog to backfill and nothing that works
 * today stops working.
 */
export async function togglePlaybook(playbookId: string, active: boolean) {
  const supabase = await createClient()
  const { brokerageId, userId } = await getAgentContext()
  if (!brokerageId) return { success: false as const, error: "Not authenticated" }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return ledgerSessionAction({ brokerageId: brokerageId, action: "services.playbook.toggle", actor: { type: "user", userId: userId }, subject: { type: "plan_task", id: playbookId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { active } }, async () => {

  const { data, error } = await supabase
    .from("plan_tasks")
    .update({ active })
    .eq("id", playbookId)
    .select()
    .maybeSingle()

  if (error) throw error

  revalidatePath("/settings/services")
  return { success: true as const, playbook: data ?? null }
  }).then((r) => ("playbook" in r ? r : { success: false as const, error: r.error ?? "Not run" }))
}

// ============================================================================
// STAGE RULES
// ============================================================================

export async function getStageRules() {
  const supabase = await createClient()

  const { data, error } = await supabase.from("compliance_rules").select("*").order("rule_type", { ascending: true })

  if (error) {
    console.error("Error fetching stage rules:", error)
    return { rules: [] }
  }

  return { rules: data || [] }
}

/**
 * WAVE 155 (lane 155S1, P0) — WHO MAY WRITE THE STAGE-RULE CATALOGUE.
 *
 * `compliance_rules` is a PLATFORM catalogue, not a tenant's data: it has NO tenant column (scripts/schema-snapshot.ts — no
 * brokerage_id), every reader reads it whole (getStageRules above; its select policy is USING (TRUE)), m471 classifies it with
 * the other catalogues ("a catalogue is not a tenant's data"), and its write policies admit public.is_platform_admin() only
 * (063 cr_ins_p / cr_upd_p / cr_del_p), which reads `platform_role = 'superadmin'` (m780). createStageRule / deleteStageRule
 * had NO session gate at all and inserted the CALLER'S params into that global table — one tenant's rule would steer every
 * tenant's stage transitions, if the row policy were ever missing or the client ever the service role.
 *
 * So the app now says what the database says, FIRST: platform superadmin (lib/platform/platform-staff-roster.ts
 * isPlatformSuperadminIdentity — the one total-control test, the app mirror of is_platform_admin()). WHAT A TENANT MAY DO:
 * read the catalogue (getStageRules, unchanged); a tenant-specific rule needs a tenant column this table does not have —
 * that is a product / schema decision, not a gate to loosen. A gate that cannot run refuses.
 */
async function requireStageRuleAuthor(): Promise<{ ok: true; userId: string; brokerageId: string | null } | { ok: false; error: string }> {
  const { resolveCallerIdentity } = await import("@/lib/auth/require-caller")
  const caller = await resolveCallerIdentity()
  if (!caller.ok) return { ok: false, error: caller.reason === "unauthenticated" ? "Not authenticated" : caller.error }
  const { isPlatformSuperadminIdentity } = await import("@/lib/platform/platform-staff-roster")
  if (!isPlatformSuperadminIdentity(caller.userType, caller.platformRole)) {
    return { ok: false, error: "Stage rules are a platform-wide catalogue — only platform staff can change them. Your brokerage can view them." }
  }
  return { ok: true, userId: caller.userId, brokerageId: caller.brokerageId }
}

export async function createStageRule(params: {
  rule_type: string
  from_stage: string
  to_stage: string
  required_conditions: any[]
  auto_transition: boolean
  actions_on_transition: any[]
}) {
  // A refusal THROWS, like this export's own write failure always has: its one caller (app/settings/services/services-content.tsx)
  // treats a resolved call as success and closes the dialog, so a returned refusal would render as a saved rule.
  const gate = await requireStageRuleAuthor()
  if (!gate.ok) throw new Error(gate.error)
  const supabase = await createClient()
  const { brokerageId, userId } = gate
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const ledgered = async () => {

  // Only the catalogue's own columns travel — never an arbitrary caller key (a PGRST204 would refuse the whole row, §3).
  const row = { rule_type: params.rule_type, from_stage: params.from_stage, to_stage: params.to_stage, required_conditions: params.required_conditions, auto_transition: params.auto_transition, actions_on_transition: params.actions_on_transition }
  const { data, error } = await supabase.from("compliance_rules").insert(row).select().single()

  if (error) throw error

  revalidatePath("/settings/services")
  return { success: true, rule: data }
  }
  return brokerageId ? ledgerSessionAction({ brokerageId: brokerageId, action: "services.stage_rule.create", actor: { type: "user", userId: userId }, subject: { type: "brokerage", id: brokerageId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { rule_type: params.rule_type } }, ledgered) : ledgered()
}

export async function deleteStageRule(ruleId: string) {
  const gate = await requireStageRuleAuthor()
  if (!gate.ok) throw new Error(gate.error) // throws, like its own write failure (see createStageRule)
  const supabase = await createClient()
  const { brokerageId, userId } = gate
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const ledgered = async () => {

  // §3: a DELETE that matches nothing resolves exactly like one that worked — count what came back.
  const { data: removed, error } = await supabase.from("compliance_rules").delete().eq("id", ruleId).select("id")

  if (error) throw error
  if ((removed ?? []).length === 0) throw new Error("That stage rule was not found — it may already have been removed.")

  revalidatePath("/settings/services")
  return { success: true }
  }
  return brokerageId ? ledgerSessionAction({ brokerageId: brokerageId, action: "services.stage_rule.delete", actor: { type: "user", userId: userId }, subject: { type: "compliance_rule", id: ruleId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, ledgered) : ledgered()
}

// toggleAIAgentTemplateStatus and togglePlaybookStatus were REMOVED here, AFTER
// merging — not because nothing called them.
//
// Both were second copies of a toggle that already exists above:
//   toggleAIAgentTemplateStatus → survivor toggleAIAgentTemplate
//   togglePlaybookStatus        → survivor togglePlaybook
//
// What each loser carried that its survivor did not, and where it went:
//   · "returns the updated row" — a real, if small, capability. PORTED onto
//     both survivors as an additive `template` / `playbook` field, so no
//     existing caller's return shape breaks.
//   · toggleAIAgentTemplateStatus additionally wrote a column named `enabled`.
//     That is NOT a capability, it is a bug: `ai_agent_templates` has no
//     `enabled` column (live schema — the flag is `is_active`), so PostgREST
//     would refuse the write and the `if (error) throw error` right below it
//     would throw. This function could never have succeeded. Nothing to port.
//
// What they carried that was worth deleting rather than keeping: neither
// authenticated and neither scoped by tenant, while both were exported from a
// `"use server"` module — i.e. two anonymously reachable write endpoints onto
// another tenant's AI agents and playbooks. The surviving pair authenticates.
