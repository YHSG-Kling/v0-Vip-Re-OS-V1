// lib/intelligence/decision-receipts.ts
//
// DECISION RECEIPTS — the glass box. For any contact, assemble the honest INTERNAL trail of "what
// did the AI team do for this person, and why": every send, open, reply, and — critically — every
// SKIP/BLOCK with its reason (no TCPA consent, quiet hours, opted out, no copy generated). The
// signals already exist scattered across sequence_step_executions (status + blocked_reason +
// open/reply), outbound_message_compliance_log (compliance decisions), and the touch provenance
// (manager + ai_intent). This stitches them into one timeline. NOT transparency_updates — that's
// the CLIENT-facing portal; this is the agent/broker-facing "why" record.
//
// assembleReceipts is PURE (no I/O), unit-tested directly; the loader pulls the rows.

export type ReceiptAction = "sent" | "opened" | "replied" | "skipped" | "blocked" | "failed" | "staged"

export interface ReceiptEntry {
  at: string
  channel: string | null
  action: ReceiptAction
  /** human-readable "what + why". */
  summary: string
  manager?: string | null
}

export interface StepExecRow {
  channel: string | null
  status: string | null
  blocked_reason: string | null
  error_message?: string | null
  sent_at: string | null
  opened_at?: string | null
  replied_at?: string | null
  created_at: string | null
}
export interface ComplianceRow {
  channel: string | null
  decision: string | null
  block_reason: string | null
  recipient_local_hour?: number | null
  created_at: string | null
}
export interface TouchRow {
  channel: string | null
  metadata: { manager?: string | null; ai_intent?: string | null } | null
  sent_at: string | null
}
export interface VideoProjectRow {
  title: string | null
  script_content: string | null
  video_type: string | null
  status: string | null
  approval_status: string | null
  /** video_metadata.requested_via — which manager commissioned it (e.g. "asset_manager"). */
  requested_via?: string | null
  created_at: string | null
}

export interface AssembleReceiptsInput {
  stepExecutions?: StepExecRow[]
  complianceLogs?: ComplianceRow[]
  touchpoints?: TouchRow[]
  /** ai_video_projects commissioned for this contact (e.g. a personal win-back). */
  videoProjects?: VideoProjectRow[]
}

const BLOCKED_STATUSES = new Set(["skipped", "blocked", "authority_blocked"])

/** Stitch the scattered signals into one honest, time-ordered "why" trail for a contact. Pure. */
export function assembleReceipts(input: AssembleReceiptsInput): ReceiptEntry[] {
  const out: ReceiptEntry[] = []

  for (const s of input.stepExecutions ?? []) {
    const at = s.created_at ?? s.sent_at ?? ""
    const ch = s.channel
    const status = (s.status ?? "").toLowerCase()
    if (status === "sent") {
      out.push({ at: s.sent_at ?? at, channel: ch, action: "sent", summary: `${ch ?? "message"} sent` })
      if (s.opened_at) out.push({ at: s.opened_at, channel: ch, action: "opened", summary: `${ch ?? "message"} opened` })
      if (s.replied_at) out.push({ at: s.replied_at, channel: ch, action: "replied", summary: `contact replied on ${ch ?? "message"}` })
    } else if (BLOCKED_STATUSES.has(status)) {
      out.push({ at, channel: ch, action: status === "authority_blocked" ? "blocked" : "skipped", summary: `${ch ?? "step"} ${status}: ${s.blocked_reason ?? "no reason recorded"}` })
    } else if (status === "failed") {
      out.push({ at, channel: ch, action: "failed", summary: `${ch ?? "step"} failed: ${s.error_message ?? s.blocked_reason ?? "unknown"}` })
    }
  }

  for (const c of input.complianceLogs ?? []) {
    const decision = (c.decision ?? "").toLowerCase()
    if (decision === "blocked") {
      const hour = typeof c.recipient_local_hour === "number" ? ` (their local time ${c.recipient_local_hour}:00)` : ""
      out.push({ at: c.created_at ?? "", channel: c.channel, action: "blocked", summary: `${c.channel ?? "message"} blocked by compliance: ${c.block_reason ?? "policy"}${hour}` })
    }
  }

  for (const t of input.touchpoints ?? []) {
    const mgr = t.metadata?.manager ?? null
    const intent = t.metadata?.ai_intent
    out.push({ at: t.sent_at ?? "", channel: t.channel, action: "sent", manager: mgr, summary: `${mgr ?? "a manager"} sent a ${t.channel ?? "touch"}${intent ? ` — intent: "${intent}"` : ""}` })
  }

  // Commissioned videos (a personal win-back, an anniversary reel) — the AI team's highest-emotion
  // play. Surface what it is + the hook + where it sits (pending approval vs sent), so "why did they
  // get that?" includes the video, not just text touches.
  for (const v of input.videoProjects ?? []) {
    const mgr = v.requested_via ?? "asset_manager"
    const kind = (v.video_type ?? "video").replace(/_/g, " ")
    const hook = (v.script_content ?? v.title ?? "").trim()
    const where = v.approval_status === "approved" || v.status === "sent" || v.status === "published"
      ? "approved" : "pending approval"
    out.push({
      at: v.created_at ?? "", channel: "video", action: "staged", manager: mgr,
      summary: `${mgr} commissioned a personal ${kind} video${hook ? ` — "${hook}"` : ""} (${where})`,
    })
  }

  // Newest first; entries without a timestamp sink to the bottom.
  return out.sort((a, b) => (b.at || "").localeCompare(a.at || ""))
}
