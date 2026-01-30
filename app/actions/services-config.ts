"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

// ============================================================================
// SERVICE REGISTRY
// ============================================================================

export async function getServicesRegistry() {
  const supabase = await createClient()

  // Return hardcoded service configurations
  // In production, these could be stored in a services table
  return {
    services: [
      {
        id: "gohighlevel",
        name: "GoHighLevel",
        type: "CRM & Communication",
        status: process.env.GHL_API_KEY ? "connected" : "not_configured",
        description: "SMS, calling, contact sync",
        config_keys: ["api_key", "location_id"],
      },
      {
        id: "heygen",
        name: "HeyGen",
        type: "AI Video Generation",
        status: process.env.HEYGEN_API_KEY ? "connected" : "not_configured",
        description: "Generate personalized videos with agent avatar",
        config_keys: ["api_key", "avatar_id"],
      },
      {
        id: "idx_broker",
        name: "IDX Broker",
        type: "Property Search",
        status: process.env.IDXBROKER_API_KEY ? "connected" : "not_configured",
        description: "MLS property listings and search",
        config_keys: ["api_key", "partner_key"],
      },
      {
        id: "dotloop",
        name: "Dotloop",
        type: "Transaction Management",
        status: process.env.DOTLOOP_API_KEY ? "connected" : "not_configured",
        description: "Document storage and e-signatures",
        config_keys: ["api_key"],
      },
      {
        id: "peopledatalabs",
        name: "PeopleDataLabs",
        type: "Contact Enrichment",
        status: process.env.PDL_API_KEY ? "connected" : "not_configured",
        description: "Person data enrichment",
        config_keys: ["api_key"],
      },
      {
        id: "batchdata",
        name: "BatchData",
        type: "Property Data",
        status: process.env.BATCHDATA_API_KEY ? "connected" : "not_configured",
        description: "Property records and valuations",
        config_keys: ["api_key"],
      },
    ],
  }
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

  const { data, error } = await supabase.from("compliance_rules").select("*").order("entity_type", { ascending: true })

  if (error) {
    console.error("Error fetching stage rules:", error)
    return { rules: [] }
  }

  return { rules: data || [] }
}

export async function createStageRule(params: {
  entity_type: string
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
