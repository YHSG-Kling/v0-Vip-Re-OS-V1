// app/api/cron/queue-drain/route.ts
//
// UNIFIED QUEUE DRAIN — closes four "queue with no drain" bugs from the
// write-only-ledger burn-down. Four tables accumulated pending rows that no
// loop ever serviced:
//
//   1. email_queue            — queued by kernel reporting/financial, video
//                               distribution, thank-you notes, source-analytics
//                               reports and the transaction NotificationService.
//                               Drained through the canonical outbound dispatcher
//                               (dispatchEmail), which already runs the platform
//                               suppression list + compliance/de-conflict gates.
//   2. push_notification_queue — queued by the transaction NotificationService.
//                               Real egress via the web-push rail
//                               (lib/providers/web-push.ts + push_subscriptions,
//                               platform VAPID keys). When the provider is not
//                               configured or the user has no active browser
//                               subscription, rows are drained HONESTLY: marked
//                               failed with the reason and re-delivered in-app
//                               via the canonical `notifications` table so the
//                               user still sees the alert.
//   3. orchestrator_tasks     — 'publish_scheduled_post' rows queued by
//                               lib/services/social-publishing.service.ts.
//                               The actual publish is owned by the canonical
//                               publish-social-posts cron (compliance gate →
//                               disclosures → lib/social/publisher), which
//                               already selects the same scheduled+approved
//                               social_posts rows — so this drain RECONCILES
//                               tasks against the post's canonical outcome
//                               instead of running a second (double-publish)
//                               rail. The service's own publishToSocialMedia is
//                               a simulation and is deliberately NOT used.
//   4. drip_campaigns         — queued by startSmartDrip / aiGenerateDripCampaign.
//                               Rows carry NO message content, only a drip_type.
//                               When an active, compliance-gated campaign_sequences
//                               row with sequence_type === drip_type exists, the
//                               contact is enrolled into the canonical sequence
//                               engine (sequence_enrollments — executed by the
//                               campaign-sequence-steps cron) and the drip row is
//                               completed with a link to the enrollment. When no
//                               sequence resolves, the row is paused with the
//                               reason — content is NEVER invented.
//
// Every 5 minutes via the dispatcher; per-row error isolation; per-queue counts
// in the response. Owner: cron_manager (CRON_MANAGER in manager-registry).

import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { verifyCronAuth } from "@/lib/cron-auth"
import { dispatchEmail } from "@/lib/providers/dispatch"
import { isWebPushConfigured, sendWebPush } from "@/lib/providers/web-push"
import { DECONFLICT_GATE_KEY } from "@/lib/campaign-sequences/deferral-policy"
import { enrollContact } from "@/lib/campaign-sequences/enrollment-engine"
import { isValidUUID } from "@/lib/validations"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"
export const maxDuration = 300

type Svc = ReturnType<typeof createServiceClient>

const BATCH = 50
/** Transient send failures retry across runs; permanently fail after this many attempts. */
const MAX_EMAIL_ATTEMPTS = 5
/** Gate verdicts that will not change on retry — fail the row immediately, honestly. */
const PERMANENT_GATES = new Set(["compliance_gate", "content_safety_gate", "autonomy_gate"])

interface QueueCounts {
  processed: number
  sent: number
  failed: number
  /** Left pending on purpose (deconflict deferral / awaiting the canonical publisher or approval). */
  deferred: number
  errors: string[]
}

const emptyCounts = (): QueueCounts => ({ processed: 0, sent: 0, failed: 0, deferred: 0, errors: [] })

// ─── 1. email_queue ───────────────────────────────────────────────────────────
// Row shape mirrors the writers (NotificationService.sendEmailNotification,
// emailReport, emailFinancialReport, sendThankYouNoteAction, emailSourceReport,
// distributeVideo): to_email/to_name/subject/body/template/metadata/brokerage_id/
// status('pending')/attempts. Drain vocabulary: sent (+sent_at) | failed (+error_msg).
async function drainEmailQueue(supabase: Svc): Promise<QueueCounts> {
  const counts = emptyCounts()

  // STALENESS RULE (round 12): a queued email older than 7 days must NEVER
  // send — a "your report is ready" or "new booking" mail arriving weeks late
  // is worse than none. Expire stale pendings in bulk before draining, so a
  // drain outage can't end with a backlog blast when the drain returns.
  const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: expired } = await supabase
    .from("email_queue")
    .update({ status: "failed", error_msg: "expired_in_queue (older than 7d at drain time — never sent)" })
    .eq("status", "pending")
    .lt("created_at", staleCutoff)
    .select("id")
  if (expired?.length) counts.errors.push(`expired ${expired.length} stale pending email(s) >7d old (never sent)`)

  const { data: rows, error } = await supabase
    .from("email_queue")
    .select("id, to_email, to_name, subject, body, template, metadata, brokerage_id, attempts")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH)
  if (error) {
    counts.errors.push(`select failed: ${error.message}`)
    return counts
  }

  for (const row of rows ?? []) {
    counts.processed++
    try {
      const now = new Date().toISOString()
      const meta = (row.metadata ?? {}) as Record<string, unknown>
      const contactId = isValidUUID(meta.contact_id as string) ? (meta.contact_id as string) : undefined

      const failRow = async (reason: string, attempts?: number) => {
        const { error: updErr } = await supabase
          .from("email_queue")
          .update({ status: "failed", error_msg: reason.slice(0, 500), ...(attempts !== undefined ? { attempts } : {}) })
          .eq("id", row.id)
        if (updErr) counts.errors.push(`email ${row.id}: mark-failed failed: ${updErr.message}`)
        counts.failed++
      }

      if (!row.brokerage_id) {
        await failRow("email_queue row has no brokerage_id — cannot dispatch")
        continue
      }

      // distributeVideo enqueues to_email:"" with metadata.contact_id ("will be
      // resolved from contact") — resolve it here; unresolvable → honest failure.
      let toEmail = (row.to_email ?? "").trim()
      let toName = row.to_name as string | null
      if (!toEmail && contactId) {
        const { data: contact } = await supabase
          .from("contacts")
          .select("email, first_name, last_name")
          .eq("id", contactId)
          .maybeSingle()
        toEmail = (contact?.email ?? "").trim()
        toName = toName || [contact?.first_name, contact?.last_name].filter(Boolean).join(" ") || null
      }
      if (!toEmail) {
        await failRow("no recipient email (to_email empty and metadata.contact_id did not resolve to a contact with an email)")
        continue
      }

      const body = String(row.body ?? "")
      const looksHtml = /<[a-z][^>]*>/i.test(body)

      // Canonical dispatcher: when contactId is passed it already enforces the
      // platform suppression list + outbound compliance + de-conflict gates —
      // no second suppression implementation here.
      const result = await dispatchEmail({
        brokerageId: row.brokerage_id,
        // No invented sender — the queue drain refuses rather than sending
        // from a domain nobody owns (see lib/providers/outbound-sender).
        from: (await import("@/lib/providers/outbound-sender"))
          .formatSenderOrUndefined(await (await import("@/lib/providers/outbound-sender"))
            .resolveOutboundSender(supabase as any, row.brokerage_id)),
        to: toEmail,
        subject: row.subject ?? "(no subject)",
        html: looksHtml ? body : body.replace(/\n/g, "<br>"),
        text: looksHtml ? undefined : body,
        contactId,
        channelPurpose: contactId ? "conversation" : "transactional",
        systemSource: "queue_drain",
        metadata: { email_queue_id: row.id, template: row.template ?? null },
      })

      if (result.success) {
        const { error: updErr } = await supabase
          .from("email_queue")
          .update({ status: "sent", sent_at: now, error_msg: null })
          .eq("id", row.id)
        if (updErr) counts.errors.push(`email ${row.id}: mark-sent failed: ${updErr.message}`)
        counts.sent++
      } else if (result.providerKey === DECONFLICT_GATE_KEY) {
        // Over-touch deferral, not a failure — leave pending for a later run.
        counts.deferred++
      } else if (PERMANENT_GATES.has(result.providerKey)) {
        await failRow(result.error ?? `blocked by ${result.providerKey}`)
      } else {
        const attempts = (row.attempts ?? 0) + 1
        if (attempts >= MAX_EMAIL_ATTEMPTS) {
          await failRow(result.error ?? "send failed", attempts)
        } else {
          const { error: updErr } = await supabase
            .from("email_queue")
            .update({ attempts, error_msg: (result.error ?? "send failed").slice(0, 500) })
            .eq("id", row.id)
          if (updErr) counts.errors.push(`email ${row.id}: retry-update failed: ${updErr.message}`)
          counts.deferred++
        }
      }
    } catch (e) {
      counts.errors.push(`email ${row.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return counts
}

// ─── 2. push_notification_queue ──────────────────────────────────────────────
// Writer: NotificationService.sendPushNotification (user_id/brokerage_id/title/
// body/data/status 'pending'). Status CHECK: pending|delivering|delivered|failed|
// cancelled. Real egress: the web-push rail (lib/providers/web-push.ts) sends
// to the user's ACTIVE push_subscriptions when the platform VAPID keys are
// configured — any accepted push closes the row 'delivered' (+delivered_at; the
// table's vocabulary — there is no 'sent'/sent_at). The in-app `notifications`
// mirror insert is KEPT on real delivery (belt and suspenders — it was the
// fallback design, and the bell is still the canonical in-app surface). When
// the provider is not configured, or the user has no active subscription, or
// every endpoint rejects the send, the row falls back to in-app delivery and is
// closed failed with the honest reason. A push is never faked.

interface PushQueueCounts extends QueueCounts {
  /** Rows delivered via a real web-push send (provider accepted ≥1 endpoint). */
  pushed: number
  /** Rows whose alert reached the user via the in-app notifications fallback. */
  delivered_in_app: number
  /** Subscriptions soft-disabled this run because the push service said gone (404/410). */
  pruned_subscriptions: number
}

async function drainPushQueue(supabase: Svc): Promise<PushQueueCounts> {
  const counts: PushQueueCounts = {
    ...emptyCounts(),
    pushed: 0,
    delivered_in_app: 0,
    pruned_subscriptions: 0,
  }
  const webPushReady = isWebPushConfigured()
  const { data: rows, error } = await supabase
    .from("push_notification_queue")
    .select("id, user_id, brokerage_id, title, body, data")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH)
  if (error) {
    counts.errors.push(`select failed: ${error.message}`)
    return counts
  }

  const now = new Date().toISOString()
  for (const row of rows ?? []) {
    counts.processed++
    try {
      const d = (row.data ?? {}) as Record<string, unknown>

      const insertInAppMirror = async (): Promise<{ ok: boolean }> => {
        const { error: notifErr } = await supabase.from("notifications").insert({
          user_id: row.user_id,
          brokerage_id: row.brokerage_id,
          type: typeof d.event_type === "string" && d.event_type ? d.event_type : "push_notification",
          title: row.title,
          body: row.body ?? "",
          entity_type: d.transaction_id ? "transaction" : null,
          entity_id: (d.transaction_id as string | undefined) ?? null,
          priority: "medium",
          channel: "in_app",
          is_read: false,
          created_at: now,
        })
        if (notifErr) {
          counts.errors.push(`push ${row.id}: in-app insert failed: ${notifErr.message}`)
          return { ok: false }
        }
        counts.delivered_in_app++
        return { ok: true }
      }

      // ── Real web-push egress when the platform rail is configured ──────────
      let push: Awaited<ReturnType<typeof sendWebPush>> | null = null
      if (webPushReady && row.user_id) {
        push = await sendWebPush({
          userId: row.user_id,
          title: row.title,
          body: row.body ?? "",
          data: d,
        })
        counts.pruned_subscriptions += push.pruned
        if (push.error) {
          // Infra error (config/lookup) — transient; leave pending for the next run.
          counts.errors.push(`push ${row.id}: web-push error: ${push.error}`)
          counts.deferred++
          continue
        }
      }

      if (push && push.sent > 0) {
        // At least one push service accepted the message — real delivery.
        // Keep the in-app mirror (belt and suspenders); its failure is non-fatal
        // here because the push actually left the building.
        if (row.user_id && row.brokerage_id) await insertInAppMirror()
        const { error: updErr } = await supabase
          .from("push_notification_queue")
          .update({ status: "delivered", delivered_at: now, error_message: null })
          .eq("id", row.id)
        if (updErr) {
          counts.errors.push(`push ${row.id}: mark-delivered failed: ${updErr.message}`)
          continue
        }
        counts.sent++
        counts.pushed++
        continue
      }

      // ── No push left the building — in-app fallback FIRST, then close the
      //    row with the honest reason. ─────────────────────────────────────────
      const canFallback = Boolean(row.user_id && row.brokerage_id)
      if (canFallback) {
        const { ok } = await insertInAppMirror()
        if (!ok) {
          // Fallback delivery failed — leave the row pending so the alert isn't lost.
          counts.deferred++
          continue
        }
      }

      const suffix = canFallback
        ? " — delivered in-app via notifications instead"
        : " — and row lacks user_id/brokerage_id for the in-app fallback"
      let reason: string
      if (!webPushReady) {
        reason = `no_push_provider_configured${suffix}`
      } else if (!row.user_id) {
        reason = `row lacks user_id — web-push has no subscriptions to target${suffix}`
      } else if (push && push.failed > 0) {
        reason = `web_push_delivery_failed (${push.failed} failed, ${push.pruned} pruned)${suffix}`
      } else {
        reason = `no_active_subscriptions${suffix}`
      }
      const { error: updErr } = await supabase
        .from("push_notification_queue")
        .update({ status: "failed", failed_at: now, error_message: reason })
        .eq("id", row.id)
      if (updErr) {
        counts.errors.push(`push ${row.id}: mark-failed failed: ${updErr.message}`)
        continue
      }
      counts.failed++
      if (canFallback) counts.sent++ // the user still got the alert (in-app)
    } catch (e) {
      counts.errors.push(`push ${row.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return counts
}

// ─── 3. orchestrator_tasks ───────────────────────────────────────────────────
// Writer: schedulePost (task_type 'publish_scheduled_post', payload.post_id,
// scheduled_for, status 'pending'); cancelScheduledPost sets 'cancelled'.
// Status CHECK: pending|running|completed|failed|cancelled.
//
// schedulePost ALSO sets the social_posts row itself to status='scheduled' with
// the same scheduled_for — and the canonical publish-social-posts cron (every
// 15 min) already publishes every due scheduled+approved post through the real
// rail (brand-compliance gate → disclosures → lib/social/publisher). Running a
// second publish path here would risk double-posting the same content, and the
// service's own publishToSocialMedia is a SIMULATION (fake external ids) that
// must not be used. So the drain reconciles each due task against its post's
// canonical outcome and closes it honestly.
async function drainOrchestratorTasks(supabase: Svc): Promise<QueueCounts> {
  const counts = emptyCounts()
  const nowIso = new Date().toISOString()
  const { data: tasks, error } = await supabase
    .from("orchestrator_tasks")
    .select("id, task_type, payload, attempts, scheduled_for")
    .eq("status", "pending")
    .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(BATCH)
  if (error) {
    counts.errors.push(`select failed: ${error.message}`)
    return counts
  }

  for (const task of tasks ?? []) {
    counts.processed++
    try {
      const close = async (status: "completed" | "failed" | "cancelled", lastError: string | null) => {
        const { error: updErr } = await supabase
          .from("orchestrator_tasks")
          .update({
            status,
            last_error: lastError ? lastError.slice(0, 500) : null,
            executed_at: new Date().toISOString(),
            attempts: (task.attempts ?? 0) + 1,
            updated_at: new Date().toISOString(),
          })
          .eq("id", task.id)
        if (updErr) counts.errors.push(`task ${task.id}: close failed: ${updErr.message}`)
        else if (status === "completed") counts.sent++
        else counts.failed++
      }

      if (task.task_type !== "publish_scheduled_post") {
        // Honest absence: no executor exists for this task type anywhere in the repo.
        await close("failed", `no executor registered for task_type '${task.task_type}'`)
        continue
      }

      const postId = (task.payload as Record<string, unknown> | null)?.post_id
      if (!isValidUUID(postId as string)) {
        await close("failed", "payload.post_id missing or invalid")
        continue
      }

      const { data: post, error: postErr } = await supabase
        .from("social_posts")
        .select("id, status, approval_status, error_message, external_post_id")
        .eq("id", postId as string)
        .maybeSingle()
      if (postErr) {
        counts.errors.push(`task ${task.id}: post lookup failed: ${postErr.message}`)
        continue
      }
      if (!post) {
        await close("failed", `social_posts row ${postId} not found`)
        continue
      }

      switch (post.status) {
        case "published":
          await close("completed", null)
          break
        case "failed":
          await close("failed", post.error_message ?? "canonical publisher marked the post failed")
          break
        case "draft":
          // cancelScheduledPost resets posts to draft; a still-pending task means
          // the post was unscheduled outside that path — close it out.
          await close("cancelled", "post reverted to draft (unscheduled)")
          break
        default:
          if (post.approval_status === "rejected") {
            await close("failed", "post approval was rejected — will not publish")
          } else {
            // scheduled/publishing: the canonical publish-social-posts cron owns
            // the send (it selects scheduled+approved posts every 15 min, or is
            // mid-flight). Leave pending; a later run closes the task from the
            // post's terminal state.
            counts.deferred++
          }
      }
    } catch (e) {
      counts.errors.push(`task ${task.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return counts
}

// ─── 4. drip_campaigns ───────────────────────────────────────────────────────
// Writers: startSmartDrip (status 'active', bare drip_type, NO content) and
// aiGenerateDripCampaign (status 'paused' — drafts, untouched here). Status
// CHECK: active|paused|completed|cancelled. A drip row carries no message
// content of its own, so the ONLY honest service is handing the contact to the
// canonical nurture engine: enroll into an active, compliance-gated
// campaign_sequences row whose sequence_type matches drip_type (its steps carry
// the real content; the campaign-sequence-steps cron executes them). No match →
// pause with the reason. Message content is never invented here.
async function drainDripCampaigns(supabase: Svc): Promise<QueueCounts> {
  const counts = emptyCounts()
  const { data: rows, error } = await supabase
    .from("drip_campaigns")
    .select("id, contact_id, brokerage_id, drip_type, metadata")
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(BATCH)
  if (error) {
    counts.errors.push(`select failed: ${error.message}`)
    return counts
  }

  for (const row of rows ?? []) {
    counts.processed++
    try {
      const now = new Date().toISOString()
      const meta = (row.metadata ?? {}) as Record<string, unknown>

      const { data: sequence, error: seqErr } = await supabase
        .from("campaign_sequences")
        .select("id, name")
        .eq("brokerage_id", row.brokerage_id)
        .eq("sequence_type", row.drip_type)
        .eq("is_active", true)
        .eq("compliance_gated", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()
      if (seqErr) {
        counts.errors.push(`drip ${row.id}: sequence lookup failed: ${seqErr.message}`)
        continue
      }

      if (!sequence) {
        // Honest absence: nothing to send and nothing to invent.
        const { error: updErr } = await supabase
          .from("drip_campaigns")
          .update({
            status: "paused",
            paused_at: now,
            updated_at: now,
            metadata: {
              ...meta,
              drain_reason: `no active compliance-gated campaign_sequences row with sequence_type='${row.drip_type}' in this brokerage — drip rows carry no message content, so there is nothing honest to send`,
              drained_by: "queue-drain",
            },
          })
          .eq("id", row.id)
        if (updErr) counts.errors.push(`drip ${row.id}: pause failed: ${updErr.message}`)
        else counts.failed++ // counted under 'paused' semantics for this queue
        continue
      }

      const enrollment = await enrollContact({
        sequenceId: sequence.id,
        contactId: row.contact_id,
        brokerageId: row.brokerage_id,
      })

      if (enrollment.success || enrollment.alreadyEnrolled) {
        const { error: updErr } = await supabase
          .from("drip_campaigns")
          .update({
            status: "completed",
            completed_at: now,
            updated_at: now,
            metadata: {
              ...meta,
              sequence_id: sequence.id,
              sequence_name: sequence.name,
              enrollment_id: enrollment.enrollmentId ?? null,
              already_enrolled: !!enrollment.alreadyEnrolled,
              drained_by: "queue-drain",
            },
          })
          .eq("id", row.id)
        if (updErr) counts.errors.push(`drip ${row.id}: complete failed: ${updErr.message}`)
        else counts.sent++
      } else {
        // Transient enrollment failure — leave active for the next run.
        counts.errors.push(`drip ${row.id}: enrollment failed: ${enrollment.error ?? "unknown"}`)
        counts.deferred++
      }
    } catch (e) {
      counts.errors.push(`drip ${row.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return counts
}

// ─── Route ───────────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "queue-drain",
    cron_path: "/app/api/cron/queue-drain/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const supabase = createServiceClient()

    // Sequential, isolated: one queue blowing up never starves the others.
    const safe = async (name: string, fn: () => Promise<QueueCounts>): Promise<QueueCounts> => {
      try {
        return await fn()
      } catch (e) {
        const c = emptyCounts()
        c.errors.push(`${name} drain crashed: ${e instanceof Error ? e.message : String(e)}`)
        return c
      }
    }

    const email = await safe("email_queue", () => drainEmailQueue(supabase))
    const push = await safe("push_notification_queue", () => drainPushQueue(supabase))
    const tasks = await safe("orchestrator_tasks", () => drainOrchestratorTasks(supabase))
    const drips = await safe("drip_campaigns", () => drainDripCampaigns(supabase))

    const queues = {
      email_queue: { ...email, sent: email.sent },
      // pushed / delivered_in_app / pruned_subscriptions ride along on the counts.
      push_notification_queue: { ...push },
      orchestrator_tasks: { ...tasks, completed: tasks.sent },
      drip_campaigns: { ...drips, enrolled: drips.sent, paused_no_sequence: drips.failed },
    }
    const processed = email.processed + push.processed + tasks.processed + drips.processed

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: processed,
      metadata: queues,
    })

    return NextResponse.json({ message: "Queue drain complete", processed, queues })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Queue drain failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
