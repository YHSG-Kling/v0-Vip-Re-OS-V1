/**
 * lib/kernel/approval-sources.ts
 *
 * Wave 40 — the CONTENT-APPROVAL SOURCE REGISTRY. Every customer-facing content
 * type that needs a human RELEASE before it ships (social posts incl. GBP, email
 * newsletters, direct-mail campaigns) is declared here ONCE: how to find its
 * pending rows, how to render the finished creative for review, and how to
 * approve / reject. The Command Center loads them all into one governed surface,
 * so there is no second approval dashboard to drift from.
 *
 * No new state — each source reuses its native column (social_posts /
 * newsletter_campaigns.approval_status, direct_mail_campaigns.status lifecycle).
 * The send/publish crons already gate on the approved value, so a pending row
 * physically cannot reach a consumer.
 *
 * Governance: managers PRODUCE autonomously; a human RELEASES. Adding a new
 * surface = adding one entry here + a preview in the Command Center client.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { evaluateApprovalSla, type ApprovalSlaLevel } from "./approval-sla"

type Svc = ReturnType<typeof createServiceClient>

export type ContentQueue = "social" | "newsletter" | "direct_mail"

/** Mirrors CommandCenterAction (kept structural to avoid a circular import). */
export interface ContentApprovalAction {
  id:          string
  queue:       ContentQueue
  brokerageId: string
  actionType:  string
  rationale:   string | null
  actionInput: Record<string, unknown>
  status:      string
  proposedAt:  string | null
  ageHours:    number
  slaLevel:    ApprovalSlaLevel
}

interface ContentSource {
  queue:     ContentQueue
  table:     "social_posts" | "newsletter_campaigns" | "direct_mail_campaigns"
  select:    string
  /** Apply the "awaiting a human" filter for this table. */
  pending:   (q: any) => any
  /** Map a pending row → the unified action contract (incl. finished-creative preview). */
  toAction:  (row: any, now: Date) => ContentApprovalAction
  /** Patch that RELEASES the item (the send/publish cron then ships it). */
  approve:   (userId: string) => Record<string, unknown>
  /** Guard the approve write to the still-pending row (idempotent, no double-release). */
  approveGuard: (q: any) => any
  /** Patch that REJECTS the item (held out of every send query). */
  reject:    (userId: string) => Record<string, unknown>
}

const nowIso = () => new Date().toISOString()

export const CONTENT_SOURCES: Record<ContentQueue, ContentSource> = {
  // ── Social posts (incl. the agent's avatar/listing reels + GBP auto-posts) ──
  social: {
    queue: "social",
    table: "social_posts",
    select: "id, brokerage_id, content, media_urls, hashtags, platform, post_type, scheduled_for, listing_id, ai_generated, created_at",
    pending: (q) => q.eq("approval_status", "pending").not("status", "in", "(published,cancelled,failed)"),
    toAction: (s, now) => {
      const sla = evaluateApprovalSla(s.created_at ?? null, now, { deadlineIso: (s.scheduled_for as string | null) ?? null })
      const platform = String(s.platform ?? "social")
      return {
        id: s.id, queue: "social", brokerageId: s.brokerage_id, actionType: "approve_social_post",
        rationale: `${s.ai_generated ? "AI-drafted" : "Drafted"} ${platform === "all" ? "multi-platform" : platform} post${s.listing_id ? " for a listing" : ""} — review the creative + caption before it posts to a public feed.`,
        actionInput: {
          content: s.content ?? null, media_urls: Array.isArray(s.media_urls) ? s.media_urls : [],
          hashtags: Array.isArray(s.hashtags) ? s.hashtags : [], platform, post_type: s.post_type ?? null,
          scheduled_for: s.scheduled_for ?? null, listing_id: s.listing_id ?? null, ai_generated: !!s.ai_generated,
        },
        status: "proposed", proposedAt: s.created_at ?? null, ageHours: sla.ageHours, slaLevel: sla.level,
      }
    },
    approve: (userId) => ({ approval_status: "approved", approved_by: userId, approved_at: nowIso(), updated_at: nowIso() }),
    approveGuard: (q) => q.eq("approval_status", "pending"),
    reject: () => ({ approval_status: "rejected", status: "cancelled", error_message: "Rejected in Command Center", updated_at: nowIso() }),
  },

  // ── Email newsletters ──────────────────────────────────────────────────────
  newsletter: {
    queue: "newsletter",
    table: "newsletter_campaigns",
    select: "id, brokerage_id, campaign_name, subject_line, content, send_date, is_ai_generated, status, created_at",
    pending: (q) => q.eq("approval_status", "pending_review").not("status", "in", "(sent,sending)"),
    toAction: (n, now) => {
      const sla = evaluateApprovalSla(n.created_at ?? null, now, { deadlineIso: (n.send_date as string | null) ?? null })
      const body = String(n.content ?? "")
      return {
        id: n.id, queue: "newsletter", brokerageId: n.brokerage_id, actionType: "approve_newsletter",
        rationale: `${n.is_ai_generated ? "AI-drafted" : "Drafted"} newsletter "${n.campaign_name ?? n.subject_line ?? "Untitled"}" — review the subject + body before it emails your subscribers.`,
        actionInput: {
          campaign_name: n.campaign_name ?? null, subject_line: n.subject_line ?? null,
          content_preview: body.length > 1200 ? body.slice(0, 1200) + "…" : body,
          send_date: n.send_date ?? null, is_ai_generated: !!n.is_ai_generated,
        },
        status: "proposed", proposedAt: n.created_at ?? null, ageHours: sla.ageHours, slaLevel: sla.level,
      }
    },
    approve: () => ({ approval_status: "approved" }),
    approveGuard: (q) => q.eq("approval_status", "pending_review"),
    reject: () => ({ approval_status: "rejected" }),
  },

  // ── Direct-mail campaigns (one approval per campaign, not per piece) ─────────
  direct_mail: {
    queue: "direct_mail",
    table: "direct_mail_campaigns",
    select: "id, brokerage_id, campaign_name, copy_text, design_url, piece_type, quantity, target_audience, mailing_date, is_ai_generated, status, created_at",
    pending: (q) => q.eq("status", "planning").eq("approval_status", "pending"),
    toAction: (d, now) => {
      const sla = evaluateApprovalSla(d.created_at ?? null, now, { deadlineIso: (d.mailing_date as string | null) ?? null })
      return {
        id: d.id, queue: "direct_mail", brokerageId: d.brokerage_id, actionType: "approve_direct_mail",
        rationale: `${d.is_ai_generated ? "AI-drafted" : "Drafted"} ${d.piece_type ?? "mail"} campaign "${d.campaign_name ?? "Untitled"}"${d.quantity ? ` (${d.quantity} pieces)` : ""} — review the design + copy before it prints and mails.`,
        actionInput: {
          campaign_name: d.campaign_name ?? null, copy_text: d.copy_text ?? null, design_url: d.design_url ?? null,
          piece_type: d.piece_type ?? null, quantity: d.quantity ?? null, target_audience: d.target_audience ?? null,
          mailing_date: d.mailing_date ?? null, is_ai_generated: !!d.is_ai_generated,
        },
        status: "proposed", proposedAt: d.created_at ?? null, ageHours: sla.ageHours, slaLevel: sla.level,
      }
    },
    approve: () => ({ status: "approved", approval_status: "approved" }),
    approveGuard: (q) => q.eq("status", "planning"),
    reject: () => ({ approval_status: "rejected" }),
  },
}

/**
 * Load every pending content-approval item across all sources into the unified
 * action contract. Brokerage-scoped when provided. Best-effort per source — one
 * source erroring never drops the others.
 */
export async function loadContentApprovalActions(
  supabase: Svc,
  params: { brokerageId?: string; limit: number; now: Date },
): Promise<ContentApprovalAction[]> {
  const sources = Object.values(CONTENT_SOURCES)
  const results = await Promise.all(sources.map(async (src) => {
    try {
      let q = supabase.from(src.table).select(src.select).order("created_at", { ascending: true }).limit(params.limit)
      q = src.pending(q)
      if (params.brokerageId) q = q.eq("brokerage_id", params.brokerageId)
      const { data } = await q
      return (data ?? []).map((row: any) => src.toAction(row, params.now))
    } catch { return [] as ContentApprovalAction[] }
  }))
  return results.flat()
}

export interface ContentApprovalResult { ok: boolean; status?: string; error?: string }

/**
 * Approve (RELEASE) a content item from the Command Center. Brokerage-scoped
 * unless superadmin; idempotent via the source's pending guard. Returns the new
 * logical status. Social is handled by its own self-scoping action elsewhere —
 * this covers newsletter + direct_mail.
 */
export async function approveContentSource(
  queue: ContentQueue, id: string, ctx: { userId: string; brokerageId: string | null; isSuperadmin: boolean },
): Promise<ContentApprovalResult> {
  const src = CONTENT_SOURCES[queue]
  if (!src) return { ok: false, error: "unknown queue" }
  const svc = createServiceClient()

  const { data: row } = await svc.from(src.table).select("id, brokerage_id").eq("id", id).maybeSingle()
  if (!row) return { ok: false, error: "not found" }
  if (!ctx.isSuperadmin && ctx.brokerageId && (row as any).brokerage_id !== ctx.brokerageId) return { ok: false, error: "outside your brokerage" }

  let q = svc.from(src.table).update(src.approve(ctx.userId)).eq("id", id)
  q = src.approveGuard(q)
  const { data: updated, error } = await q.select("id").maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!updated) return { ok: false, error: "already actioned" }
  return { ok: true, status: "approved" }
}

export async function rejectContentSource(
  queue: ContentQueue, id: string, ctx: { userId: string; brokerageId: string | null; isSuperadmin: boolean },
): Promise<ContentApprovalResult> {
  const src = CONTENT_SOURCES[queue]
  if (!src) return { ok: false, error: "unknown queue" }
  const svc = createServiceClient()

  const { data: row } = await svc.from(src.table).select("id, brokerage_id").eq("id", id).maybeSingle()
  if (!row) return { ok: false, error: "not found" }
  if (!ctx.isSuperadmin && ctx.brokerageId && (row as any).brokerage_id !== ctx.brokerageId) return { ok: false, error: "outside your brokerage" }

  const { error } = await svc.from(src.table).update(src.reject(ctx.userId)).eq("id", id)
  if (error) return { ok: false, error: error.message }
  return { ok: true, status: "rejected" }
}
