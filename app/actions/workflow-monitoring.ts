"use server"

import { createClient } from "@/lib/supabase/server"

// ---------------------------------------------------------------------------
// WORKFLOW MONITOR — reads the CANONICAL workflow engine (lib/workflow-orchestrator:
// workflow_runs / workflow_run_steps). The legacy Engine A (workflow_executions /
// workflow_step_executions) was vestigial (no live trigger) and has been retired;
// this monitor now surfaces the REAL chain runs (ISA appointment prep, compliance
// auto-create, etc.). Return shapes are unchanged so the client renders as-is:
// a "run" is mapped to the execution shape (workflow_id/workflow_name ← chain_key,
// step rows ← workflow_run_steps).
// ---------------------------------------------------------------------------
async function safeQuery<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err: any) {
    if (
      err?.code === "42P01" ||
      err?.message?.includes("does not exist") ||
      err?.message?.includes("relation")
    ) {
      console.warn("[workflow] Schema not ready — workflow_runs may not exist yet.")
      return fallback
    }
    throw err
  }
}

/** Buckets Engine B's run statuses into the monitor's running/completed/failed view. */
function isRunning(status: string | null): boolean {
  return !["completed", "failed", "cancelled", "canceled"].includes(String(status))
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
      .from("workflow_runs")
      .select("id, chain_key, status, started_at, completed_at, agent_user_id, error_message, workflow_run_steps(count)")
      .order("started_at", { ascending: false })

    if (filters?.status) query = query.eq("status", filters.status)
    if (filters?.workflowId) query = query.eq("chain_key", filters.workflowId)
    if (filters?.agentId) query = query.eq("agent_user_id", filters.agentId)
    query = query.limit(filters?.limit || 50)

    const { data, error } = await query
    if (error) {
      console.error("[getWorkflowExecutions] Error:", error)
      return { success: false, error: error.message, executions: [] as any[] }
    }

    // Map runs → the execution shape the client already renders.
    const executions = (data || []).map((r: any) => ({
      id: r.id,
      workflow_id: r.chain_key,
      workflow_name: r.chain_key,
      status: r.status,
      started_at: r.started_at,
      completed_at: r.completed_at,
      agent_id: r.agent_user_id,
      error_message: r.error_message,
      workflow_step_executions: r.workflow_run_steps ?? [],
    }))
    return { success: true, executions }
  }, { success: false, error: "Workflow runs not available", executions: [] as any[] })
}

export async function getWorkflowExecutionDetails(executionId: string) {
  const supabase = await createClient()

  return safeQuery(async () => {
    const { data: run, error: runError } = await supabase
      .from("workflow_runs")
      .select("id, chain_key, status, started_at, completed_at, error_message, current_step_index")
      .eq("id", executionId)
      .single()

    if (runError || !run) {
      return { success: false, error: "Run not found", execution: null, steps: [] as any[] }
    }

    const { data: steps, error: stepsError } = await supabase
      .from("workflow_run_steps")
      .select("*")
      .eq("run_id", executionId)
      .order("step_index", { ascending: true })

    if (stepsError) {
      return { success: false, error: stepsError.message, execution: null, steps: [] as any[] }
    }

    return {
      success: true,
      execution: {
        id: (run as any).id,
        workflow_id: (run as any).chain_key,
        workflow_name: (run as any).chain_key,
        status: (run as any).status,
        started_at: (run as any).started_at,
        completed_at: (run as any).completed_at,
        error_message: (run as any).error_message,
      },
      // Map step rows to the shape the client renders (name ← step_label).
      steps: (steps || []).map((s: any) => ({
        id: s.id,
        name: s.step_label ?? s.step_key,
        step_name: s.step_label ?? s.step_key,
        status: s.status,
        started_at: s.started_at,
        completed_at: s.completed_at,
        error_message: s.error_message,
      })),
    }
  }, { success: false, error: "Workflow runs not available", execution: null, steps: [] as any[] })
}

export async function retryWorkflowExecution(executionId: string) {
  const supabase = await createClient()

  return safeQuery(async () => {
    // Engine B advances a run through its own idempotent step-retry — re-drive it.
    const { data: run } = await supabase.from("workflow_runs").select("id").eq("id", executionId).single()
    if (!run) return { success: false, error: "Run not found" }
    const { advanceRun } = await import("@/lib/workflow-orchestrator/engine")
    await advanceRun(executionId)
    return { success: true, message: "Run re-driven" }
  }, { success: false, error: "Workflow runs not available" })
}

export async function getWorkflowStats() {
  const supabase = await createClient()

  return safeQuery(async () => {
    const { data: runs } = await supabase
      .from("workflow_runs")
      .select("status, chain_key, started_at")
      .gte("started_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

    if (!runs) return { total: 0, completed: 0, failed: 0, running: 0, successRate: 0 }

    const total = runs.length
    const completed = runs.filter((e) => e.status === "completed").length
    const failed = runs.filter((e) => e.status === "failed").length
    const running = runs.filter((e) => isRunning(e.status)).length

    return {
      total,
      completed,
      failed,
      running,
      successRate: total > 0 ? Math.round((completed / total) * 100) : 0,
    }
  }, { total: 0, completed: 0, failed: 0, running: 0, successRate: 0 })
}
