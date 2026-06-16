// lib/intelligence/decision-receipts-runner.ts
//
// Loader for DECISION RECEIPTS — pulls a contact's send/skip/block/open/reply signals from the
// three sources and assembles the honest "why" trail. Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { assembleReceipts, type ReceiptEntry } from "./decision-receipts"

type Svc = ReturnType<typeof createServiceClient>

export async function getContactDecisionReceipts(
  svc: Svc, contactId: string, brokerageId: string, sinceDays = 30,
): Promise<ReceiptEntry[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const [steps, compliance, touches, videos] = await Promise.all([
    svc.from("sequence_step_executions")
      .select("channel, status, blocked_reason, error_message, sent_at, opened_at, replied_at, created_at")
      .eq("contact_id", contactId).gte("created_at", since).limit(500),
    svc.from("outbound_message_compliance_log")
      .select("channel, decision, block_reason, recipient_local_hour, created_at")
      .eq("contact_id", contactId).gte("created_at", since).limit(500),
    svc.from("marketing_campaign_touchpoints")
      .select("channel, metadata, sent_at")
      .eq("contact_id", contactId).eq("brokerage_id", brokerageId).gte("sent_at", since).limit(500),
    svc.from("ai_video_projects")
      .select("title, script_content, video_type, status, approval_status, video_metadata, created_at")
      .eq("contact_id", contactId).eq("brokerage_id", brokerageId).gte("created_at", since).limit(200),
  ])
  return assembleReceipts({
    stepExecutions: (steps.data ?? []) as any,
    complianceLogs: (compliance.data ?? []) as any,
    touchpoints: (touches.data ?? []) as any,
    videoProjects: ((videos.data ?? []) as any[]).map((v) => ({
      title: v.title, script_content: v.script_content, video_type: v.video_type,
      status: v.status, approval_status: v.approval_status,
      requested_via: v.video_metadata?.requested_via ?? null, created_at: v.created_at,
    })),
  })
}
