/**
 * WEB-PUSH PROVIDER — platform-keyed browser push egress (RFC 8030 / VAPID).
 *
 * The push_notification_queue drain exposed the honest gap: rows failed with
 * 'no_push_provider_configured' because no push rail existed. This adapter is
 * that rail. Delivery targets are the user's browser push subscriptions in
 * public.push_subscriptions (captured by app/actions/push-subscriptions.ts +
 * public/push-sw.js; RLS lets users manage their own rows, the service role
 * reads them here for delivery).
 *
 * Platform env keys (all three required): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
 * VAPID_SUBJECT (mailto: contact per RFC 8292). Guardian awareness lives in
 * lib/agentic-os/connector-probe.ts PLATFORM_PROVIDER_KEYS (web_push).
 *
 * Dead endpoints (HTTP 404/410 from the push service) are soft-disabled
 * (disabled_at + disabled_reason='endpoint_gone') — never deleted — so the
 * ledger of what the user once subscribed survives. sendWebPush never throws;
 * per-endpoint outcomes are aggregated into {sent, failed, pruned}.
 */

import "server-only"
import webpush from "web-push"
import { createServiceClient } from "@/lib/supabase/service"
import { withActionLedger, type ActionReasonCode, type LedgerClient } from "@/lib/kernel/action-ledger"

/** True when all three VAPID env keys are present — the drain's gate for
 *  attempting real push egress instead of the in-app-only fallback. */
export function isWebPushConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT,
  )
}

export interface SendWebPushParams {
  userId: string
  title: string
  body: string
  /** Arbitrary payload forwarded to the service worker (e.g. { url }). */
  data?: Record<string, unknown>
  /** The tenant this push belongs to. With it, the push is ledgered (agent_action_ledger is
   *  tenant-scoped, brokerage_id NOT NULL); without it the push is sent unledgered. */
  brokerageId?: string | null
  /** ACTION LEDGER context (wave 98) — `cycle` makes the push at-most-once (the queue drain
   *  passes the push_notification_queue row id, so a re-drained row never double-pushes). */
  ledger?: { reasonCode?: ActionReasonCode; reasonDetail?: string; cycle?: string }
}

export interface SendWebPushResult {
  /** Endpoints that accepted the push. */
  sent: number
  /** Endpoints that errored (non-gone failures — transient or auth). */
  failed: number
  /** Endpoints the push service reported gone (404/410) — soft-disabled. */
  pruned: number
  /** Populated when nothing could even be attempted (not configured / lookup failed). */
  error?: string
}

/**
 * Send a real browser push to every ACTIVE subscription for the user.
 * Never throws; never fakes a send — sent>0 means at least one push service
 * accepted the message.
 */
export async function sendWebPush(params: SendWebPushParams): Promise<SendWebPushResult> {
  // ACTION LEDGER (wave 98, lane 98B) — the ONE web-push egress (its only caller is the
  // push_notification_queue drain). sent>0 → executed; nothing attempted (config / lookup) →
  // failed; no active subscription → skipped. Unledgered only when no tenant was given.
  if (!params.brokerageId) return sendWebPushUnledgered(params)
  return ledgerWebPush(params as SendWebPushParams & { brokerageId: string }, () => sendWebPushUnledgered(params))
}

/**
 * The ledger half of the push chokepoint — claim → `push()` → settle.
 * @proofSeam exported so scripts/action-ledger-guard.ts proves one push = one ledger row and a re-drained queue row pushes once.
 */
export function ledgerWebPush(
  params: SendWebPushParams & { brokerageId: string },
  push: () => Promise<SendWebPushResult>,
  opts?: { client?: LedgerClient },
): Promise<SendWebPushResult> {
  return withActionLedger<SendWebPushResult>({
    brokerageId: params.brokerageId,
    action: "comms.push.send",
    channel: "push",
    actor: { type: "system" },
    subject: { type: "user", id: params.userId },
    reasonCode: params.ledger?.reasonCode ?? null,
    reasonDetail: params.ledger?.reasonDetail ?? params.title.slice(0, 200),
    cycle: params.ledger?.cycle ?? null,
    riskClass: "COMMUNICATION",
    systemSource: "web_push",
  }, push, {
    settle: (r) => r.sent > 0
      ? { status: "executed", outcome: "accepted", provider: "web_push", costUsd: 0 }
      : r.error ? { status: "failed", outcome: "not_attempted", provider: "web_push", error: r.error }
      : { status: "skipped", outcome: r.failed > 0 ? "every_endpoint_failed" : "no_active_subscription" },
    replay: (claim) => claim.kind === "replay"
      ? { sent: 1, failed: 0, pruned: 0 }
      : { sent: 0, failed: 0, pruned: 0, error: claim.kind === "refused" ? claim.error : `push ${claim.kind === "unknown" ? "outcome unknown" : "already in flight"} — not re-sent` },
  }, opts)
}

async function sendWebPushUnledgered(params: SendWebPushParams): Promise<SendWebPushResult> {
  const result: SendWebPushResult = { sent: 0, failed: 0, pruned: 0 }

  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT
  if (!publicKey || !privateKey || !subject) {
    result.error = "web-push not configured (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT)"
    return result
  }

  try {
    const supabase = createServiceClient()

    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", params.userId)
      .is("disabled_at", null)
    if (error) {
      result.error = `push_subscriptions lookup failed: ${error.message}`
      return result
    }
    if (!subs || subs.length === 0) return result

    const payload = JSON.stringify({
      title: params.title,
      body: params.body,
      data: params.data ?? {},
    })

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
          { vapidDetails: { subject, publicKey, privateKey }, TTL: 60 * 60 * 24 },
        )
        result.sent++
      } catch (e) {
        const statusCode =
          typeof e === "object" && e !== null && "statusCode" in e
            ? Number((e as { statusCode: unknown }).statusCode)
            : null
        if (statusCode === 404 || statusCode === 410) {
          // Endpoint is gone (browser unsubscribed / subscription expired).
          // Soft-disable — never delete — so the row remains auditable.
          const { error: disableErr } = await supabase
            .from("push_subscriptions")
            .update({ disabled_at: new Date().toISOString(), disabled_reason: "endpoint_gone" })
            .eq("id", sub.id)
          if (disableErr) {
            console.error(`[v0] web-push: failed to soft-disable gone subscription ${sub.id}:`, disableErr.message)
          }
          result.pruned++
        } else {
          result.failed++
        }
      }
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
  }

  return result
}
