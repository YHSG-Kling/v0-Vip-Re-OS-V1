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
import {
  BLOG_PENDING_PUBLISH_STATUS,
  NEWSLETTER_PENDING_APPROVAL_STATUSES,
  AD_CREATIVE_PENDING_APPROVAL_STATUSES,
  PODCAST_PENDING_STATUS,
  PODCAST_PENDING_APPROVAL_STATUS,
} from "./approval-pending"

type Svc = ReturnType<typeof createServiceClient>

export type ContentQueue = "social" | "newsletter" | "direct_mail" | "ad_creative" | "predictive_listing" | "transaction_task" | "transaction_smart_task" | "agent_followup" | "blog" | "podcast"

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
  table:     "social_posts" | "newsletter_campaigns" | "direct_mail_campaigns" | "ad_creative_variations" | "predictive_listing_actions" | "transaction_pending_actions" | "transaction_tasks" | "ai_autopilot_actions" | "blog_posts" | "podcast_episodes"
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
    pending: (q) => q.in("approval_status", [...NEWSLETTER_PENDING_APPROVAL_STATUSES]).not("status", "in", "(sent,sending)"),
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
    approveGuard: (q) => q.in("approval_status", [...NEWSLETTER_PENDING_APPROVAL_STATUSES]),
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

  // ── Paid-ad creatives (review the headline/copy/CTA before any spend) ───────
  ad_creative: {
    queue: "ad_creative",
    table: "ad_creative_variations",
    select: "id, brokerage_id, ad_campaign_id, variation_name, headline, primary_text, description, call_to_action, media_asset_url, destination_url, created_at",
    pending: (q) => q.in("approval_status", [...AD_CREATIVE_PENDING_APPROVAL_STATUSES]),
    toAction: (c, now) => {
      const sla = evaluateApprovalSla(c.created_at ?? null, now)
      return {
        id: c.id, queue: "ad_creative", brokerageId: c.brokerage_id, actionType: "approve_ad_creative",
        rationale: `Paid-ad creative "${c.variation_name ?? c.headline ?? "Untitled"}" — review the headline + copy + CTA before it can run as a paid ad.`,
        actionInput: {
          ad_campaign_id: c.ad_campaign_id ?? null, variation_name: c.variation_name ?? null,
          headline: c.headline ?? null, primary_text: c.primary_text ?? null, description: c.description ?? null,
          call_to_action: c.call_to_action ?? null, media_asset_url: c.media_asset_url ?? null, destination_url: c.destination_url ?? null,
        },
        status: "proposed", proposedAt: c.created_at ?? null, ageHours: sla.ageHours, slaLevel: sla.level,
      }
    },
    approve: () => ({ approval_status: "approved" }),
    approveGuard: (q) => q.in("approval_status", [...AD_CREATIVE_PENDING_APPROVAL_STATUSES]),
    reject: () => ({ approval_status: "rejected" }),
  },

  // ── Predictive-seller auto-touch (PLS) — surfaced into the ONE Command Center.
  // Distinct subsystem (system-generated likely-to-list outreach), but its review
  // belongs on the same surface as every other client-facing approval. Approve →
  // 'queued' (the predictive-listing send cron ships it under compliance);
  // reject → 'cancelled'. (Its own card UI still works; this unifies the review.)
  predictive_listing: {
    queue: "predictive_listing",
    table: "predictive_listing_actions",
    select: "id, brokerage_id, contact_id, action_type, channel, triggering_pls_score, message_subject, message_body, scheduled_send_at, status, created_at",
    pending: (q) => q.eq("status", "pending_review"),
    toAction: (r, now) => {
      const sla = evaluateApprovalSla(r.created_at ?? null, now, { deadlineIso: (r.scheduled_send_at as string | null) ?? null })
      return {
        id: r.id, queue: "predictive_listing", brokerageId: r.brokerage_id, actionType: "approve_predictive_touch",
        rationale: `Predicted-seller ${r.channel ?? "outreach"} (PLS ${r.triggering_pls_score ?? "?"}) — review before it reaches the homeowner.`,
        actionInput: {
          contact_id: r.contact_id ?? null, channel: r.channel ?? null, pls_score: r.triggering_pls_score ?? null,
          subject: r.message_subject ?? null, body: r.message_body ?? null, scheduled_send_at: r.scheduled_send_at ?? null,
        },
        status: "proposed", proposedAt: r.created_at ?? null, ageHours: sla.ageHours, slaLevel: sla.level,
      }
    },
    approve: (userId) => ({ status: "queued", reviewed_by_user_id: userId, reviewed_at: nowIso() }),
    approveGuard: (q) => q.eq("status", "pending_review"),
    reject: (userId) => ({ status: "cancelled", cancelled_by_user_id: userId, cancelled_at: nowIso(), cancel_reason: "rejected in Command Center" }),
  },

  // ── Transaction AT-RISK alerts (closing-orchestration cron) — table
  // `transaction_pending_actions`. System-detected deal risks (appraisal not
  // ordered, deadline closing). Approve = "Resolved"; reject = "Dismiss".
  // NOTE: distinct from `transaction_smart_task` below (the agent to-do list,
  // table `transaction_tasks`) — kept separate by design; orthogonal subsystems.
  transaction_task: {
    queue: "transaction_task",
    table: "transaction_pending_actions",
    select: "id, brokerage_id, transaction_id, action_type, severity, due_date, headline, detail, suggested_recipient, status, created_at",
    pending: (q) => q.eq("status", "open"),
    toAction: (r, now) => {
      const sla = evaluateApprovalSla(r.created_at ?? null, now, { deadlineIso: (r.due_date as string | null) ?? null })
      // Severity drives urgency too — urgent/high escalate immediately.
      const level = (r.severity === "urgent" || r.severity === "high") ? "breached" : sla.level
      return {
        id: r.id, queue: "transaction_task", brokerageId: r.brokerage_id, actionType: "resolve_transaction_task",
        rationale: `${r.headline ?? r.action_type ?? "Deal task"}${r.severity ? ` · ${r.severity}` : ""} — at-risk item on a transaction.`,
        actionInput: {
          transaction_id: r.transaction_id ?? null, action_type: r.action_type ?? null, severity: r.severity ?? null,
          headline: r.headline ?? null, detail: r.detail ?? null, suggested_recipient: r.suggested_recipient ?? null, due_date: r.due_date ?? null,
        },
        status: "proposed", proposedAt: r.created_at ?? null, ageHours: sla.ageHours, slaLevel: level as ApprovalSlaLevel,
      }
    },
    approve: (userId) => ({ status: "resolved", resolved_by: userId, resolved_at: nowIso() }),
    approveGuard: (q) => q.eq("status", "open"),
    reject: (userId) => ({ status: "dismissed", resolved_by: userId, resolved_at: nowIso() }),
  },

  // ── Transaction SMART TASKS (deal to-do list) — table `transaction_tasks`.
  // The human-agent to-do list: stage-templated + AI-suggested + contract-review
  // tasks an agent works through a deal. Surfaced here so the ONE Command Center
  // is the single place an agent sees their open deal work, alongside the at-risk
  // alerts above. Approve = "Done" (→ completed); reject = "Cancel" (→ cancelled).
  // Its native UIs (transaction detail, coordinator panel, /overdue) still work —
  // this unifies the action surface, it does not replace them.
  transaction_smart_task: {
    queue: "transaction_smart_task",
    table: "transaction_tasks",
    select: "id, brokerage_id, transaction_id, title, description, priority, category, due_date, assigned_to, ai_generated, status, created_at",
    pending: (q) => q.eq("status", "pending"),
    toAction: (r, now) => {
      const sla = evaluateApprovalSla(r.created_at ?? null, now, { deadlineIso: (r.due_date as string | null) ?? null })
      // Priority escalates urgency: critical/high jump the queue.
      const level = (r.priority === "critical" || r.priority === "high") ? "breached" : sla.level
      return {
        id: r.id, queue: "transaction_smart_task", brokerageId: r.brokerage_id, actionType: "complete_transaction_task",
        rationale: `${r.title ?? "Deal task"}${r.priority ? ` · ${r.priority}` : ""}${r.ai_generated ? " · AI-suggested" : ""} — open to-do on a transaction.`,
        actionInput: {
          transaction_id: r.transaction_id ?? null, title: r.title ?? null, description: r.description ?? null,
          priority: r.priority ?? null, category: r.category ?? null, due_date: r.due_date ?? null,
          assigned_to: r.assigned_to ?? null, ai_generated: !!r.ai_generated,
        },
        status: "proposed", proposedAt: r.created_at ?? null, ageHours: sla.ageHours, slaLevel: level as ApprovalSlaLevel,
      }
    },
    approve: (userId) => ({ status: "completed", completed_by: userId, completed_at: nowIso(), updated_at: nowIso() }),
    approveGuard: (q) => q.eq("status", "pending"),
    reject: () => ({ status: "cancelled", updated_at: nowIso() }),
  },

  // ── Autopilot follow-ups (open-house etc.) — surfaced as a follow-up task queue.
  // Internal reminders that previously had NO UI. Approve = "Done", reject = "Skip".
  agent_followup: {
    queue: "agent_followup",
    table: "ai_autopilot_actions",
    select: "id, brokerage_id, entity_type, entity_id, action_type, title, description, priority, scheduled_for, status, created_at",
    pending: (q) => q.eq("status", "pending"),
    toAction: (r, now) => {
      const sla = evaluateApprovalSla(r.created_at ?? null, now, { deadlineIso: (r.scheduled_for as string | null) ?? null })
      return {
        id: r.id, queue: "agent_followup", brokerageId: r.brokerage_id, actionType: "complete_followup",
        rationale: `${r.title ?? r.action_type ?? "Follow-up"} — a scheduled follow-up reminder.`,
        actionInput: {
          title: r.title ?? null, description: r.description ?? null, action_type: r.action_type ?? null,
          priority: r.priority ?? null, scheduled_for: r.scheduled_for ?? null, entity_type: r.entity_type ?? null,
        },
        status: "proposed", proposedAt: r.created_at ?? null, ageHours: sla.ageHours, slaLevel: sla.level,
      }
    },
    approve: () => ({ status: "executed", executed_at: nowIso() }),
    approveGuard: (q) => q.eq("status", "pending"),
    reject: () => ({ status: "skipped", executed_at: nowIso() }),
  },

  // ── Blog posts — auto-drafted SEO content, deliverable-gated before publish.
  // The publish cron only ships publish_status='approved', so a draft can't go live.
  blog: {
    queue: "blog",
    table: "blog_posts",
    // Canonical: the stager writes publish_status='draft' (marketing.ts) — the
    // prior 'pending_review' filter matched nothing, so B's blog source was dark
    // AND its approve-guard could never fire. Both now use the shared constant.
    select: "id, brokerage_id, title, slug, excerpt, content, featured_image_url, publish_status, created_at",
    pending: (q) => q.eq("publish_status", BLOG_PENDING_PUBLISH_STATUS),
    toAction: (b, now) => {
      const sla = evaluateApprovalSla(b.created_at ?? null, now)
      const body = String(b.content ?? b.excerpt ?? "")
      return {
        id: b.id, queue: "blog", brokerageId: b.brokerage_id, actionType: "approve_blog_post",
        rationale: `Blog post "${b.title ?? "Untitled"}" — review the copy before it publishes to your site.`,
        actionInput: { title: b.title ?? null, excerpt: b.excerpt ?? null, content_preview: body.length > 1200 ? body.slice(0, 1200) + "…" : body, featured_image_url: b.featured_image_url ?? null },
        status: "proposed", proposedAt: b.created_at ?? null, ageHours: sla.ageHours, slaLevel: sla.level,
      }
    },
    approve: () => ({ publish_status: "approved" }),
    approveGuard: (q) => q.eq("publish_status", BLOG_PENDING_PUBLISH_STATUS),
    reject: () => ({ publish_status: "archived" }),
  },

  // ── Podcast episodes — generated, then deliverable-gated before distribution.
  // Canonical: the auto-producer stages status='completed' + approval_status=
  // 'pending_review'; the distributor ships status='completed' AND approval_status
  // ='approved'. So the REVIEW gate is approval_status (NOT status). The prior
  // filter (status='completed') matched approved+un-approved alike, and the prior
  // approve (status='scheduled') stranded the episode — it never set approval_status
  // ='approved' and set a status the distributor ignores. Approve/reject now DELEGATE
  // to the ONE canonical marketing transition (see approveContentSource) which sets
  // approval_status + defaults publish_channels; the patches below are the
  // column-correct fallback (approval_status-based, never the status column).
  podcast: {
    queue: "podcast",
    table: "podcast_episodes",
    select: "id, brokerage_id, title, description, audio_url, status, approval_status, created_at",
    pending: (q) => q.eq("status", PODCAST_PENDING_STATUS).eq("approval_status", PODCAST_PENDING_APPROVAL_STATUS),
    toAction: (p, now) => {
      const sla = evaluateApprovalSla(p.created_at ?? null, now)
      return {
        id: p.id, queue: "podcast", brokerageId: p.brokerage_id, actionType: "approve_podcast_episode",
        rationale: `Podcast episode "${p.title ?? "Untitled"}" is generated — review before it distributes to Spotify/Apple/etc.`,
        actionInput: { title: p.title ?? null, description: p.description ?? null, audio_url: p.audio_url ?? null },
        status: "proposed", proposedAt: p.created_at ?? null, ageHours: sla.ageHours, slaLevel: sla.level,
      }
    },
    approve: () => ({ approval_status: "approved" }),
    approveGuard: (q) => q.eq("approval_status", PODCAST_PENDING_APPROVAL_STATUS),
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

/** Load ONE content action by id (the same registry select + toAction the full loader uses),
 *  so a decision-time consumer (the compliance ledger) can read its copy without re-deriving
 *  per-queue field maps. Returns null when the row is gone. */
export async function loadOneContentAction(
  queue: ContentQueue, id: string, client?: Svc,
): Promise<ContentApprovalAction | null> {
  const src = CONTENT_SOURCES[queue]
  if (!src) return null
  const svc = client ?? createServiceClient()
  const { data } = await svc.from(src.table).select(src.select).eq("id", id).maybeSingle()
  if (!data) return null
  try { return src.toAction(data, new Date()) } catch { return null }
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

  // Podcast release rides the ONE canonical marketing transition (sets
  // approval_status='approved' AND defaults publish_channels — a bare patch
  // would leave channels empty and the distributor would never ship it). Tenant
  // scope is already enforced above.
  if (queue === "podcast") {
    const { applyMarketingAssetApproval } = await import("./approval-queue-aggregator")
    const res = await applyMarketingAssetApproval("podcast", id)
    return res.ok ? { ok: true, status: "approved" } : { ok: false, error: res.error }
  }

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

  // Podcast rejection rides the same canonical transition (approval_status=
  // 'rejected'), so the two surfaces can't write different columns.
  if (queue === "podcast") {
    const { applyMarketingAssetRejection } = await import("./approval-queue-aggregator")
    const res = await applyMarketingAssetRejection("podcast", id, "Rejected in Command Center")
    return res.ok ? { ok: true, status: "rejected" } : { ok: false, error: res.error }
  }

  const { error } = await svc.from(src.table).update(src.reject(ctx.userId)).eq("id", id)
  if (error) return { ok: false, error: error.message }
  return { ok: true, status: "rejected" }
}
