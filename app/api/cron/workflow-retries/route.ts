import {
NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { WorkflowOrchestrator } from "@/lib/orchestrator"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export async function GET(request: Request) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "workflow-retries",
    cron_path: "/app/api/cron/workflow-retries/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[WorkflowRetries] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = await createClient()

    // Verify schema exists before running — tables may not be created in production yet
    const { error: schemaCheck } = await supabase
      .from("workflow_executions")
      .select("id")
      .limit(1)

    if (schemaCheck?.code === "42P01" || schemaCheck?.message?.includes("does not exist")) {
      await recordCronSuccessAction({
        context_id: contextId,
        records_processed: 0,
        metadata: { message: "Workflow tables not yet created" },
      })
      return NextResponse.json({
        ok: false,
        message: "Workflow tables not yet created. Run scripts/220-create-workflow-orchestration.sql",
        ranAt: new Date().toISOString(),
        processed: 0,
      })
    }

    // Get all pending retries that are due
    const { data: retries, error } = await supabase
      .from("workflow_retries")
      .select("*, workflow_executions(*)")
      .eq("executed", false)
      .lte("scheduled_for", new Date().toISOString())
      .limit(50)

    if (error) {
      console.error("[Cron] Error fetching retries:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!retries || retries.length === 0) {
      return NextResponse.json({ message: "No pending retries", processed: 0 })
    }

    const orchestrator = new WorkflowOrchestrator()
    let processed = 0
    let succeeded = 0
    let failed = 0

    for (const retry of retries) {
      try {
        const config = retry.workflow_config as any

        // Execute the workflow
        await orchestrator.executeWorkflow(config, config.context)

        // Mark retry as executed
        await supabase
          .from("workflow_retries")
          .update({ executed: true, executed_at: new Date().toISOString() })
          .eq("id", retry.id)

        processed++
        succeeded++
      } catch (error: any) {
        console.error(`[Cron] Retry failed for execution ${retry.execution_id}:`, error)

        // Mark as executed to avoid infinite loops
        await supabase
          .from("workflow_retries")
          .update({ executed: true, executed_at: new Date().toISOString() })
          .eq("id", retry.id)

        processed++
        failed++
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: processed,
      output_count: succeeded,
      metadata: { processed, succeeded, failed },
    })

    return NextResponse.json({
      message: "Workflow retries processed",
      processed,
      succeeded,
      failed,
    })
  } catch (error: any) {
    console.error("[Cron] Workflow retry processing failed:", error)
    await recordCronFailureAction({
      context_id: contextId,
      error,
      stage: "main-processing",
    })
    return NextResponse.json({ error: error.message, context_id: contextId }, { status: 500 })
  }
}
