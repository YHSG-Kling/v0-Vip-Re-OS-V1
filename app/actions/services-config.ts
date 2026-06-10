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
      config_keys: svc.config_keys,
      status: dbRecord?.status ?? (process.env[svc.env_key] ? "connected" : "not_configured"),
      last_checked_at: dbRecord?.last_health_check_at ?? null,
      last_error: dbRecord?.last_error ?? null,
    }
  })

  return { services }
}

// ============================================================================
// AI AGENT TEMPLATES
// ============================================================================

export async function getAIAgentTemplates() {
  const supabase = await createClient()

  const { data, error } = await supabase.from("agents").select("*").order("created_at", { ascending: true })

  if (error) {
    console.error("Error fetching AI agent templates:", error)
    return { agents: [] }
  }

  return { agents: data || [] }
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

  const { data, error } = await supabase
    .from("agents")
    .insert({
      agent_name: params.agent_name,
      agent_type: params.agent_type,
      system_prompt: params.system_prompt,
      model: params.model,
      temperature: params.temperature,
      capabilities: params.capabilities,
      active: true,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/settings/services")
  return { success: true, agent: data }
}

export async function toggleAIAgentTemplate(agentId: string, active: boolean) {
  const supabase = await createClient()

  const { error } = await supabase.from("agents").update({ active }).eq("id", agentId)

  if (error) throw error

  revalidatePath("/settings/services")
  return { success: true }
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

export async function createPlaybook(params: {
  playbook_name: string
  trigger_type: string
  steps: any[]
  target_persona_ids: string[]
}) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("plan_tasks")
    .insert({
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
}

export async function togglePlaybook(playbookId: string, active: boolean) {
  const supabase = await createClient()

  const { error } = await supabase.from("plan_tasks").update({ active }).eq("id", playbookId)

  if (error) throw error

  revalidatePath("/settings/services")
  return { success: true }
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

export async function createStageRule(params: {
  rule_type: string
  from_stage: string
  to_stage: string
  required_conditions: any[]
  auto_transition: boolean
  actions_on_transition: any[]
}) {
  const supabase = await createClient()

  const { data, error } = await supabase.from("compliance_rules").insert(params).select().single()

  if (error) throw error

  revalidatePath("/settings/services")
  return { success: true, rule: data }
}

export async function deleteStageRule(ruleId: string) {
  const supabase = await createClient()

  const { error } = await supabase.from("compliance_rules").delete().eq("id", ruleId)

  if (error) throw error

  revalidatePath("/settings/services")
  return { success: true }
}

export async function toggleAIAgentTemplateStatus(templateId: string, enabled: boolean) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("ai_agent_templates")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", templateId)
    .select()
    .single()

  if (error) throw error

  revalidatePath("/settings/services")
  return { success: true, template: data }
}

export async function togglePlaybookStatus(playbookId: string, enabled: boolean) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("plan_tasks")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", playbookId)
    .select()
    .single()

  if (error) throw error

  revalidatePath("/settings/services")
  return { success: true, playbook: data }
}
