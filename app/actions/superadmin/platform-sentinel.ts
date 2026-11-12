"use server"

// app/actions/superadmin/platform-sentinel.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM SENTINEL — the staff approval queue over platform_sentinel_actions.
// The daily cron (app/api/cron/platform-sentinel) composes proposed actions
// with drafted outreach; these actions let platform staff LIST (proposed
// first), APPROVE, APPROVE-AND-SEND, and DISMISS them.
//
// Gate: requirePlatformCapability('sentinel') to read; writes additionally
// require write access. Approve/dismiss/send are audited to
// superadmin_audit_log (the ai-ops.ts audit shape).
//
// HONEST SEND RAIL: approve→send goes through the SAME canonical email sender
// the dunning ladder and prospect follow-up use (lib/providers/messaging
// sendEmail — SendGrid-gated, fails loudly without creds). A row only becomes
// 'sent' when the provider actually accepted the message; a failed or
// unconfigured send leaves it 'approved' with the draft ready to copy, and the
// result says so. Only email drafts are wire-sendable — 'call' scripts and
// internal notes are for a human, so approve keeps them at 'approved'.

import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveActorNames } from "@/lib/kernel/actor-attribution"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { isEmailOnSuppressionList } from "@/lib/platform/suppression-list"
import {
  splitDraftEmail,
  SEVERITY_ORDER,
  summarizeSentinelVerdicts,
  activeSentinelSuppressions,
  isSentinelKindOverAlarmed,
  SENTINEL_LEARNING_WINDOW_DAYS,
  SENTINEL_SUPPRESSION_STREAK,
  type SentinelSeverity,
  type SentinelVerdictRow,
} from "@/lib/platform/platform-sentinel"

const SENTINEL_PAGE = "/dashboard/superadmin/sentinel"

export interface SentinelActionRow {
  id: string
  kind: string
  severity: string
  brokerageId: string | null
  brokerageName: string | null
  title: string
  detail: string
  draftChannel: string
  draftText: string
  status: string
  createdAt: string
  actedAt: string | null
  /** WHO decided. platform_sentinel_actions.acted_by is stamped by every
   *  approve/send/dismiss below and, until wave H5, was read by nothing — the
   *  queue showed WHEN a fleet-wide staff decision was taken and never BY WHOM,
   *  so the accountable half of an accountability record was write-only.
   *  Resolved to the staff email; null when the row predates the stamp or the
   *  user row is gone (FK is ON DELETE SET NULL). */
  actedBy: string | null
}

/** Fleet-wide flywheel stats for one proposal kind (the learning strip). */
export interface SentinelKindLearning {
  kind: string
  approved: number
  sent: number
  dismissed: number
  decided: number
  /** dismissed / decided as a whole percentage (0–100). */
  dismissalRate: number
  /** True when the kind rule is currently lowering this kind's severity. */
  downgraded: boolean
}

/** A (kind, tenant) pair the tenant rule currently suppresses. */
export interface SentinelSuppressionView {
  kind: string
  brokerageId: string
  brokerageName: string | null
  streak: number
}

/** What the sentinel has learned from staff verdicts (the flywheel readout). */
export interface SentinelLearningView {
  kinds: SentinelKindLearning[]
  suppressions: SentinelSuppressionView[]
  /** Total decisions inside the learning window. */
  decisions: number
  windowDays: number
  suppressionStreak: number
}

export interface SentinelQueue {
  proposed: SentinelActionRow[]
  recent: SentinelActionRow[]
  /** True when the platform email rail (SendGrid) is configured — the UI keeps
   *  its "send" affordance honest instead of pretending. */
  emailRailReady: boolean
  learning: SentinelLearningView
}

type Gate = { ok: true; userId: string; email: string } | { ok: false; error: string }

async function gate(requireWrite: boolean): Promise<Gate> {
  const g = await requirePlatformCapability("sentinel", { requireWrite })
  if (!g.ok || !g.userId) return { ok: false, error: g.error ?? "Forbidden" }
  const svc = createServiceClient()
  const { data } = await svc.from("users").select("email").eq("id", g.userId).maybeSingle()
  return { ok: true, userId: g.userId, email: (data as any)?.email ?? "" }
}

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action,
      target_type: "platform_sentinel_action", target_id: targetId, details,
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[platform-sentinel audit] failed:", err) }
}

function toRow(r: any, nameOf: Map<string, string>, actorOf?: Map<string, string>): SentinelActionRow {
  return {
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    brokerageId: r.brokerage_id ?? null,
    brokerageName: r.brokerage_id ? nameOf.get(r.brokerage_id) ?? null : null,
    title: r.title ?? "",
    detail: r.detail ?? "",
    draftChannel: r.draft_channel ?? "none",
    draftText: r.draft_text ?? "",
    status: r.status,
    createdAt: r.created_at,
    actedAt: r.acted_at ?? null,
    actedBy: r.acted_by ? (actorOf?.get(r.acted_by) ?? r.acted_by) : null,
  }
}

/** The queue: every proposed action (severity-first), the recent decisions,
 *  and the flywheel readout (what those decisions have taught the sentinel). */
export async function listSentinelActionsAction(): Promise<{ ok: true; data: SentinelQueue } | { ok: false; error: string }> {
  const g = await gate(false)
  if (!g.ok) return g
  const svc = createServiceClient()

  const decidedSince = new Date(Date.now() - SENTINEL_LEARNING_WINDOW_DAYS * 86_400_000).toISOString()
  const [proposedRes, recentRes, decidedRes] = await Promise.all([
    svc.from("platform_sentinel_actions")
      .select("id, kind, severity, brokerage_id, title, detail, draft_channel, draft_text, status, created_at, acted_at")
      .eq("status", "proposed")
      .order("created_at", { ascending: false })
      .limit(200),
    svc.from("platform_sentinel_actions")
      .select("id, kind, severity, brokerage_id, title, detail, draft_channel, draft_text, status, created_at, acted_at, acted_by")
      .neq("status", "proposed")
      .order("acted_at", { ascending: false, nullsFirst: false })
      .limit(30),
    // The flywheel input: every decision in the learning window — the same
    // rows the cron reads before composing, so panel and cron never disagree.
    svc.from("platform_sentinel_actions")
      .select("kind, brokerage_id, status, acted_at")
      .in("status", ["approved", "sent", "dismissed"])
      .gte("acted_at", decidedSince)
      .limit(5000),
  ])
  const err = proposedRes.error ?? recentRes.error ?? decidedRes.error
  if (err) return { ok: false, error: `Failed to load sentinel actions: ${err.message}` }

  const verdictRows: SentinelVerdictRow[] = ((decidedRes.data ?? []) as any[]).map((r) => ({
    kind: r.kind as string,
    brokerageId: (r.brokerage_id as string | null) ?? null,
    status: r.status as string,
    actedAt: (r.acted_at as string | null) ?? null,
  }))
  const summary = summarizeSentinelVerdicts(verdictRows)
  const suppressions = activeSentinelSuppressions(summary)

  const brokerageIds = [...new Set([
    ...[...(proposedRes.data ?? []), ...(recentRes.data ?? [])].map((r: any) => r.brokerage_id).filter(Boolean),
    ...suppressions.map((s) => s.brokerageId),
  ])] as string[]
  const nameOf = new Map<string, string>()
  if (brokerageIds.length > 0) {
    const { data: brks } = await svc.from("brokerages").select("id, name").in("id", brokerageIds)
    for (const b of (brks ?? []) as any[]) nameOf.set(b.id, b.name ?? "(unnamed)")
  }

  // WHO decided. Resolved once for the decided rows; a staff id with no user
  // row left resolves to the raw id rather than to a blank, so a deleted
  // account never renders as "nobody decided this" — that fallback lives at
  // the render site (toRow: `actorOf?.get(r.acted_by) ?? r.acted_by`).
  // TOMBSTONE (§1.1, 2026-09-03): the inline users lookup that stood here was
  // one of four copies AND the only one that never read its error, so a refused
  // read rendered every decision as its raw id with no trace of why. Survivor
  // lib/kernel/actor-attribution.ts:91 (resolveActorNames) — unscoped on
  // purpose: acted_by is PLATFORM staff, who belong to no tenant.
  const actorIds = ((recentRes.data ?? []) as any[]).map((r) => r.acted_by).filter(Boolean) as string[]
  const { names: actorOf, error: actorErr } = await resolveActorNames(svc, actorIds)
  if (actorErr) console.error("[platform-sentinel] decision actor lookup failed:", actorErr)

  const proposed = ((proposedRes.data ?? []) as any[]).map((r) => toRow(r, nameOf))
  proposed.sort((a, b) =>
    (SEVERITY_ORDER[a.severity as SentinelSeverity] ?? 3) - (SEVERITY_ORDER[b.severity as SentinelSeverity] ?? 3) ||
    b.createdAt.localeCompare(a.createdAt),
  )

  const kinds: SentinelKindLearning[] = Object.values(summary.byKind)
    .filter((k) => k.decided > 0)
    .map((k) => ({
      kind: k.kind,
      approved: k.approved,
      sent: k.sent,
      dismissed: k.dismissed,
      decided: k.decided,
      dismissalRate: Math.round((k.dismissed / k.decided) * 100),
      downgraded: isSentinelKindOverAlarmed(k),
    }))
    .sort((a, b) => b.decided - a.decided || a.kind.localeCompare(b.kind))

  return {
    ok: true,
    data: {
      proposed,
      recent: ((recentRes.data ?? []) as any[]).map((r) => toRow(r, nameOf, actorOf)),
      emailRailReady: !!process.env.SENDGRID_API_KEY,
      learning: {
        kinds,
        suppressions: suppressions.map((s) => ({
          kind: s.kind,
          brokerageId: s.brokerageId,
          brokerageName: nameOf.get(s.brokerageId) ?? null,
          streak: s.streak,
        })),
        decisions: verdictRows.length,
        windowDays: SENTINEL_LEARNING_WINDOW_DAYS,
        suppressionStreak: SENTINEL_SUPPRESSION_STREAK,
      },
    },
  }
}

export interface ApproveResult {
  ok: boolean
  error?: string
  /** Final status after this call ('approved' or 'sent'). */
  status?: string
  /** Set when a send was attempted: what actually happened on the wire. */
  sendNote?: string
}

/**
 * Approve a proposed action; optionally push its email draft through the
 * platform send rail. status becomes 'sent' ONLY when the provider accepted
 * the message — otherwise it stays 'approved' with the draft ready to copy.
 */
export async function approveSentinelActionAction(id: string, opts: { send?: boolean } = {}): Promise<ApproveResult> {
  const g = await gate(true)
  if (!g.ok) return { ok: false, error: g.error }
  const svc = createServiceClient()

  const { data: row, error } = await svc
    .from("platform_sentinel_actions")
    .select("id, kind, severity, brokerage_id, title, draft_channel, draft_text, status")
    .eq("id", id).maybeSingle()
  if (error || !row) return { ok: false, error: error?.message ?? "Action not found" }
  if (row.status !== "proposed" && row.status !== "approved") {
    return { ok: false, error: `Action is already ${row.status}` }
  }

  const nowIso = new Date().toISOString()
  if (row.status === "proposed") {
    const { error: upErr } = await svc
      .from("platform_sentinel_actions")
      .update({ status: "approved", acted_by: g.userId, acted_at: nowIso })
      .eq("id", id).eq("status", "proposed")
    if (upErr) return { ok: false, error: `Approve failed: ${upErr.message}` }
    await audit(g.userId, g.email, "platform_sentinel.approved", id, {
      kind: row.kind, severity: row.severity, brokerage_id: row.brokerage_id, title: row.title, send_requested: !!opts.send,
    })
  }

  if (!opts.send) {
    revalidatePath(SENTINEL_PAGE)
    return { ok: true, status: "approved" }
  }

  // ── Send path (email drafts only — calls and internal notes stay with a human) ──
  if (row.draft_channel !== "email") {
    revalidatePath(SENTINEL_PAGE)
    return { ok: true, status: "approved", sendNote: `Approved. A '${row.draft_channel}' draft isn't wire-sendable — it's ready for you to use directly.` }
  }
  if (!row.brokerage_id) {
    revalidatePath(SENTINEL_PAGE)
    return { ok: true, status: "approved", sendNote: "Approved, but this action has no tenant to address the email to." }
  }

  // Recipient: the tenant's billing/admin users first (the dunning rail's rule),
  // else the brokerage's own email on file.
  const [{ data: admins }, { data: brk }] = await Promise.all([
    svc.from("users").select("email")
      .eq("brokerage_id", row.brokerage_id)
      .in("user_type", ["broker", "admin"])
      .is("deleted_at", null).limit(20),
    svc.from("brokerages").select("email").eq("id", row.brokerage_id).maybeSingle(),
  ])
  const to = ((admins ?? []) as any[]).map((a) => a.email).filter(Boolean)[0] ?? (brk as any)?.email ?? null
  if (!to) {
    revalidatePath(SENTINEL_PAGE)
    return { ok: true, status: "approved", sendNote: "Approved, but no admin email is on file for this tenant — copy the draft and reach them another way." }
  }
  if (await isEmailOnSuppressionList(to)) {
    revalidatePath(SENTINEL_PAGE)
    return { ok: true, status: "approved", sendNote: `Approved, but ${to} is on the platform suppression list — it must not be emailed.` }
  }

  const { subject, body } = splitDraftEmail(row.draft_text ?? "", row.title ?? "A note from the platform team")
  let sendNote: string
  try {
    const { sendEmail } = await import("@/lib/providers/messaging")
    const sent = await sendEmail({
      to, subject,
      html: `<p>${body.replace(/\n/g, "<br>")}</p>`,
      text: body,
    })
    if (!sent.success) {
      sendNote = `Approved, but the send failed: ${sent.error ?? "provider rejected the message"}. The draft is ready to copy.`
      revalidatePath(SENTINEL_PAGE)
      return { ok: true, status: "approved", sendNote }
    }
    const { error: sentErr } = await svc
      .from("platform_sentinel_actions")
      .update({ status: "sent", acted_by: g.userId, acted_at: new Date().toISOString() })
      .eq("id", id)
    if (sentErr) {
      // The email went out; the status row lagging is a bookkeeping problem — say so.
      sendNote = `Email sent to ${to}, but recording 'sent' failed: ${sentErr.message}`
      revalidatePath(SENTINEL_PAGE)
      return { ok: true, status: "approved", sendNote }
    }
    await audit(g.userId, g.email, "platform_sentinel.sent", id, {
      kind: row.kind, brokerage_id: row.brokerage_id, to, subject, provider: sent.provider ?? null,
    })
    revalidatePath(SENTINEL_PAGE)
    return { ok: true, status: "sent", sendNote: `Email sent to ${to}.` }
  } catch (e) {
    sendNote = `Approved, but the send errored: ${e instanceof Error ? e.message : "unknown error"}. The draft is ready to copy.`
    revalidatePath(SENTINEL_PAGE)
    return { ok: true, status: "approved", sendNote }
  }
}

/** Dismiss a proposed (or approved-but-unsent) action. Audited. */
export async function dismissSentinelActionAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const g = await gate(true)
  if (!g.ok) return { ok: false, error: g.error }
  const svc = createServiceClient()

  const { data: row, error } = await svc
    .from("platform_sentinel_actions")
    .select("id, kind, severity, brokerage_id, title, status")
    .eq("id", id).maybeSingle()
  if (error || !row) return { ok: false, error: error?.message ?? "Action not found" }
  if (row.status !== "proposed" && row.status !== "approved") {
    return { ok: false, error: `Action is already ${row.status}` }
  }

  const { error: upErr } = await svc
    .from("platform_sentinel_actions")
    .update({ status: "dismissed", acted_by: g.userId, acted_at: new Date().toISOString() })
    .eq("id", id).in("status", ["proposed", "approved"])
  if (upErr) return { ok: false, error: `Dismiss failed: ${upErr.message}` }
  await audit(g.userId, g.email, "platform_sentinel.dismissed", id, {
    kind: row.kind, severity: row.severity, brokerage_id: row.brokerage_id, title: row.title,
  })
  revalidatePath(SENTINEL_PAGE)
  return { ok: true }
}
