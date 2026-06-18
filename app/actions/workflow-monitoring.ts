"use server"

import { createClient } from "@/lib/supabase/server"

// ---------------------------------------------------------------------------
// Schema-safety helper
// Returns `fallback` when the query fails because workflow tables don't exist
// (Postgres error code 42P01 = "undefined_table")
// ---------------------------------------------------------------------------
async function safeQuery<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err: any) {
    if (
      err?.code === "42P01" ||
      err?.message?.includes("does not exist") ||
      err?.message?.includes("relation") // covers "relation X does not exist"
    ) {
      console.warn("[workflow] Schema not ready — workflow tables may not exist. Run scripts/220-create-workflow-orchestration.sql")
      return fallback
    }
    throw err
  }
}

export async function getWorkflowExecutions(filters?: {
  status?: string
  workflowId?: string
  agentId?: string
  limit?: number
}) {
  const supabase = await createClient()

  return safeQuery(async () => {
    let query = supabase
      .from("workflow_executions")
      .select("*, workflow_step_executions(count)")
      .order("started_at", { ascending: false })

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
      return { success: false, error: error.message, executions: [] as any[] }
    }

    return { success: true, executions: data || [] }
  }, { success: false, error: "Workflow tables not yet created. Run scripts/220-create-workflow-orchestration.sql", executions: [] as any[] })
}

export async function getWorkflowExecutionDetails(executionId: string) {
  const supabase = await createClient()

  return safeQuery(async () => {
    const { data: execution, error: execError } = await supabase
      .from("workflow_executions")
      .select("*")
      .eq("id", executionId)
      .single()

    if (execError || !execution) {
      return { success: false, error: "Execution not found", execution: null, steps: [] as any[] }
    }

    const { data: steps, error: stepsError } = await supabase
      .from("workflow_step_executions")
      .select("*")
      .eq("execution_id", executionId)
      .order("started_at", { ascending: true })

    if (stepsError) {
      return { success: false, error: stepsError.message, execution: null, steps: [] as any[] }
    }

    return {
      success: true,
      execution,
      steps: steps || [],
    }
  }, { success: false, error: "Workflow tables not yet created. Run scripts/220-create-workflow-orchestration.sql", execution: null, steps: [] as any[] })
}

export async function retryWorkflowExecution(executionId: string) {
  const supabase = await createClient()

  return safeQuery(async () => {
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
  }, { success: false, error: "Workflow tables not yet created. Run scripts/220-create-workflow-orchestration.sql" })
}

export async function getWorkflowStats() {
  const supabase = await createClient()

  return safeQuery(async () => {
    const { data: executions } = await supabase
      .from("workflow_executions")
      .select("status, workflow_id, started_at")
      .gte("started_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

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
  }, {
    total: 0,
    completed: 0,
    failed: 0,
    running: 0,
    successRate: 0,
  })
}
