"use server"

import { createClient } from "@/lib/supabase/server"

export async function getWorkflowExecutions(filters?: {
  status?: string
  workflowId?: string
  agentId?: string
  limit?: number
}) {
  const supabase = await createClient()

  let query = supabase
    .from("workflow_executions")
    .select("*, workflow_step_executions(count)")
    .order("created_at", { ascending: false })

  if (filters?.status) {
    query = query.eq("status", filters.status)
  }
  if (filters?.workflowId) {
    query = query.eq("workflow_id", filters.workflowId)
  }
  if (filters?.agentId) {
    query = query.eq("agent_id", filters.agentId)
  }

  query = query.limit(filters?.limit || 50)

  const { data, error } = await query

  if (error) {
    console.error("[getWorkflowExecutions] Error:", error)
    return { success: false, error: error.message, executions: [] }
  }

  return { success: true, executions: data || [] }
}

export async function getWorkflowExecutionDetails(executionId: string) {
  const supabase = await createClient()

  const { data: execution, error: execError } = await supabase
    .from("workflow_executions")
    .select("*")
    .eq("id", executionId)
    .single()

  if (execError || !execution) {
    return { success: false, error: "Execution not found" }
  }

  const { data: steps, error: stepsError } = await supabase
    .from("workflow_step_executions")
    .select("*")
    .eq("execution_id", executionId)
    .order("created_at", { ascending: true })

  if (stepsError) {
    return { success: false, error: stepsError.message }
  }

  return {
    success: true,
    execution,
    steps: steps || [],
  }
}

export async function retryWorkflowExecution(executionId: string) {
  const supabase = await createClient()

  // Get the original execution
  const { data: execution } = await supabase.from("workflow_executions").select("*").eq("id", executionId).single()

  if (!execution) {
    return { success: false, error: "Execution not found" }
  }

  // Schedule immediate retry
  const { error } = await supabase.from("workflow_retries").insert({
    execution_id: executionId,
    workflow_config: {
      id: execution.workflow_id,
      name: execution.workflow_name,
      context: execution.context,
    },
    scheduled_for: new Date().toISOString(),
  })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, message: "Retry scheduled" }
}

export async function getWorkflowStats() {
  const supabase = await createClient()

  const { data: executions } = await supabase
    .from("workflow_executions")
    .select("status, workflow_id, created_at")
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

  if (!executions) {
    return {
      total: 0,
      completed: 0,
      failed: 0,
      running: 0,
      successRate: 0,
    }
  }

  const total = executions.length
  const completed = executions.filter((e) => e.status === "completed").length
  const failed = executions.filter((e) => e.status === "failed").length
  const running = executions.filter((e) => e.status === "running").length

  return {
    total,
    completed,
    failed,
    running,
    successRate: total > 0 ? Math.round((completed / total) * 100) : 0,
  }
}
