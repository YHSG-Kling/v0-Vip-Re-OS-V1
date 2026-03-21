import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { WorkflowOrchestrator } from "@/lib/orchestrator"

export async function GET(request: Request) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get("authorization")
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const supabase = await createClient()

    // Verify schema exists before running — tables may not be created in production yet
    const { error: schemaCheck } = await supabase
      .from("workflow_executions")
      .select("id")
      .limit(1)

    if (schemaCheck?.code === "42P01" || schemaCheck?.message?.includes("does not exist")) {
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

    return NextResponse.json({
      message: "Workflow retries processed",
      processed,
      succeeded,
      failed,
    })
  } catch (error: any) {
    console.error("[Cron] Workflow retry processing failed:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
