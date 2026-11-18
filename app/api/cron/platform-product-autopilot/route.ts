import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"
import { runWeeklyProductAutopilot } from "@/lib/platform/product-content-autopilot"

/**
 * app/api/cron/platform-product-autopilot/route.ts
 *
 * Monday: the platform's own acquisition content for the week — the product
 * post calendar plus ONE ProductPromoReel video draft with its render queued
 * through the one registry — as GATED drafts a superadmin approves and posts
 * (app/dashboard/superadmin/growth). Registered in lib/kernel/cron-dispatch.ts;
 * owned by campaign_orchestrator (lib/kernel/manager-registry.ts CRON_MANAGER —
 * m618: survivor of the retired marketing_agent seat).
 * Auth: CRON_SECRET.
 *
 * DECISION + EVIDENCE (wave 154, lane 154A3 — coverage-ledger gap row 22). The run is an autonomous manager action that
 * writes drafts and queues a render (compute spend), so it now asks the ONE autonomy gate first
 * (lib/managers/autonomy-gate.ts autonomyDecision with the platform circuit-breaker, loadPlatformHalt): while the god
 * switch is halted the week's drafts are NOT written (the next Monday, or a superadmin's manual "generate", runs them).
 * Either way the run is recorded on agent_action_ledger under the platform's house tenant (the same tenant its renders are
 * filed under) — who (campaign_orchestrator), why, which decision, what was drafted. The drafts themselves stay gated:
 * nothing posts until a human approves it.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  const authError = verifyCronAuth(request)
  if (authError) return authError
  try {
    const svc = createServiceClient()
    const { loadPlatformHalt } = await import("@/lib/platform/platform-controls")
    const { autonomyDecision } = await import("@/lib/managers/autonomy-gate")
    const gate = autonomyDecision({ managerKey: "campaign_orchestrator", effective: null, platformHalt: await loadPlatformHalt(svc as never) })
    const { DEMO_CONFIG } = await import("@/app/constants/auth")
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const now = new Date()
    type Run = { ok: boolean; held?: boolean; reason?: string | null; recorded?: boolean } & Partial<Awaited<ReturnType<typeof runWeeklyProductAutopilot>>>
    const result = await withActionLedger<Run>(
      {
        brokerageId: DEMO_CONFIG.BROKERAGE_ID,
        action: "platform.product_autopilot.run",
        actor: { type: "manager", managerKey: "campaign_orchestrator" },
        subject: { type: "platform_content_week", ref: now.toISOString().slice(0, 10) },
        reasonCode: "SCHEDULED_CONTENT_PUBLISH",
        reasonDetail: gate.allow ? "weekly product content drafts (gated — a superadmin approves before anything posts)" : `held by the autonomy gate: ${gate.reason ?? "platform halted"}`,
        riskClass: "LOW_RISK_WRITE",
        systemSource: "platform_product_autopilot",
        detail: { decided_by: "autonomyDecision(platformHalt)", allow: gate.allow, held: gate.held },
      },
      async () => {
        if (!gate.allow) return { ok: true, held: true, reason: gate.reason }
        return { ok: true, ...(await runWeeklyProductAutopilot(svc)) }
      },
      {
        settle: (r) => r.held
          ? { status: "skipped", outcome: "held_platform_halt" }
          : { status: "executed", outcome: `drafts:${r.calendar?.created ?? 0},video:${r.videoDraftId ? "yes" : "no"}` },
        // Recording-only claim (no idempotency key): the drafts' own weekly reads are the once-guard, so a ledger that cannot
        // record never blocks the run — but a non-acting claim is still said by kind.
        replay: (claim) => ({ ok: claim.kind !== "refused", recorded: false, reason: claim.kind === "refused" ? `ledger refused: ${claim.error}` : `claim ${claim.kind}` }),
      },
      { client: svc as never },
    )
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
