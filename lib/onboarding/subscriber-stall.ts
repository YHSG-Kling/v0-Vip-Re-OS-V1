// lib/onboarding/subscriber-stall.ts
// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIBER STALL LOOP — the autonomous half of "humans when warranted" AFTER
// the door (lane 79D). Every subscriber-level nudge the OS already had assumed
// the owner was INSIDE the product: onboarding-reminders nudges an agent who
// stopped completing steps, onboarding-fallbehind rings the broker about that
// agent, checkin-cadence writes a day-7/30/90 in-app check-in. A brand-new
// subscriber who never crossed the threshold — never clicked the magic link,
// never finished the paid checkout — got NOTHING, because every one of those
// signals is an in-app notification to a mailbox nobody has opened yet.
//
// Two stall shapes, read from rows the core already writes (no migration):
//   · activation_pending — a PAID activation whose checkout never cleared:
//     subscriptions.status 'trialing' with NO stripe_subscription_id and a
//     trial_end at creation (buildSubscriptionRow's paid shape). Money was
//     promised and never moved.
//   · onboarding_pending — brokerages.onboarding_status still 'pending' (the
//     value createTenantCore writes; the wizard flips it to in_progress).
//     The owner has not started.
//
// Cadence (from the existing stall constant, lib/onboarding/onboarding-roster
// STALL_AFTER_DAYS = 7): day ≥ NUDGE_AFTER_DAYS → ONE email to the owner from
// the platform sales rep (the only channel that reaches someone who has never
// signed in) + the in-app bell for when they do; day ≥ STALL_AFTER_DAYS → ONE
// platform-staff escalation (a person calls). Each stage fires ONCE per
// brokerage — stamped in brokerages.billing_metadata.subscriber_stall, the
// jsonb carry-bag the door already uses (coupon / signup_intent / waiver), so
// a re-run is a counted zero. Rides the daily onboarding-reminders cron.
//
// Owners: recruiting_manager (onboarding) with data_steward (the door) and
// finance_manager (the unpaid activation) — see MAINTENANCE_DOMAINS
// subscriber_door.

import { STALL_AFTER_DAYS } from "@/lib/onboarding/onboarding-roster"

/** Days after creation before the first nudge. */
export const NUDGE_AFTER_DAYS = 3
/** How far back the sweep looks — older tenants are the retention radar's. */
export const STALL_LOOKBACK_DAYS = 45

export type SubscriberStallKind = "activation_pending" | "onboarding_pending"
export type SubscriberStallStage = "none" | "nudge" | "escalate"

export interface SubscriberStallRow {
  id: string
  name: string | null
  email: string | null
  created_at: string
  onboarding_status: string | null
  plan_tier: string | null
  billing_metadata: Record<string, unknown> | null
  subscription: { status: string | null; stripe_subscription_id: string | null; trial_end: string | null } | null
}

export interface SubscriberStallStamp { nudged_at?: string | null; escalated_at?: string | null }

export interface SubscriberStallState {
  kind: SubscriberStallKind | null
  stage: SubscriberStallStage
  ageDays: number
  /** What is still owed this run after the stamp is honoured. */
  due: "nudge" | "escalate" | null
}

const DAY_MS = 86_400_000

/** PURE: is this subscription row a paid activation whose checkout never cleared? */
export function isActivationPending(sub: SubscriberStallRow["subscription"], createdAt: string): boolean {
  if (!sub || sub.status !== "trialing" || sub.stripe_subscription_id) return false
  if (!sub.trial_end) return false
  // A real trial ends ~14 days after creation; the paid shape writes trial_end = now.
  return new Date(sub.trial_end).getTime() - new Date(createdAt).getTime() < DAY_MS
}

/** PURE: the stall rule + the idempotence rule, so a guard can pin both without a database. */
export function subscriberStallState(row: SubscriberStallRow, now: Date): SubscriberStallState {
  const ageDays = Math.floor((now.getTime() - new Date(row.created_at).getTime()) / DAY_MS)
  const kind: SubscriberStallKind | null = isActivationPending(row.subscription, row.created_at)
    ? "activation_pending"
    : row.onboarding_status === "pending" ? "onboarding_pending" : null
  if (!kind) return { kind: null, stage: "none", ageDays, due: null }
  const stage: SubscriberStallStage = ageDays >= STALL_AFTER_DAYS ? "escalate" : ageDays >= NUDGE_AFTER_DAYS ? "nudge" : "none"
  const stamp = ((row.billing_metadata?.subscriber_stall ?? null) as SubscriberStallStamp | null) ?? {}
  const due = stage === "escalate" && !stamp.escalated_at ? "escalate"
    : stage !== "none" && !stamp.nudged_at ? "nudge"
    : null
  return { kind, stage, ageDays, due }
}

/** PURE: the owner-facing nudge — specific to the stall, honest about the ask, one next step. */
export function composeStallNudge(i: { kind: SubscriberStallKind; brandName: string; brokerageName: string; firstName: string; planTier: string | null; appUrl: string }): { subject: string; html: string; text: string; bellTitle: string; bellBody: string } {
  const plan = (i.planTier ?? "your").replace(/_/g, " ")
  if (i.kind === "activation_pending") {
    const link = `${i.appUrl}/auth/login`
    return {
      subject: `${i.brokerageName}: your ${i.brandName} plan is reserved but not active yet`,
      html: `<p>Hi ${i.firstName},</p><p>Your ${plan} plan is reserved and your workspace is built, but the checkout never finished, so nothing is live yet. Sign in with the link in your inbox and activate from Billing — it takes a minute: <a href="${link}">${link}</a></p><p>If the checkout gave you trouble, reply to this email and a person will send you a fresh link or take it over the phone.</p>`,
      text: `Your ${i.brandName} ${plan} plan is reserved but the checkout never finished. Sign in and activate from Billing: ${link} — or reply and a person will help.`,
      bellTitle: "Finish activating your plan",
      bellBody: `Your ${plan} plan is reserved. Activate it from Billing and your AI managers go on duty the moment it clears.`,
    }
  }
  const link = `${i.appUrl}/auth/login`
  return {
    subject: `${i.brokerageName}: your ${i.brandName} workspace is waiting`,
    html: `<p>Hi ${i.firstName},</p><p>Your ${plan} workspace is built and your AI managers are on duty, but nobody has walked in yet. Use the sign-in link in your inbox (or request a new one here: <a href="${link}">${link}</a>) and the onboarding wizard takes it from there — your first contacts, your first market, your voice.</p><p>Stuck on anything? Reply to this email and a person will get you set up.</p>`,
    text: `Your ${i.brandName} ${plan} workspace is built but nobody has signed in yet. Sign in: ${link} — reply if you'd like a person to get you set up.`,
    bellTitle: "Your onboarding wizard is waiting",
    bellBody: `Start with your first market and your first contacts — the wizard walks you through it, and a person is one reply away.`,
  }
}

export interface SubscriberStallSweepResult {
  scanned: number
  pending: number
  nudged: number
  escalated: number
  skipped: number
  errors: string[]
}

/** @proofSeam — production callers never pass this. */
export interface SubscriberStallDeps {
  resolveRep?: (svc: any) => Promise<{ userId: string; brokerageId: string } | null>
  dispatch?: (params: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>
  notifyStaff?: (svc: any, n: { type: string; title: string; body: string; entityType?: string | null; entityId?: string | null; priority?: "low" | "medium" | "high" }) => Promise<number>
  brandName?: string
  appUrl?: string
}

/**
 * Sweep new tenants for a stalled subscriber, nudge once, escalate once.
 * Every read/write destructures `{ data, error }` (CLAUDE.md §3); a stamp that
 * matched nothing is reported, never assumed. Best-effort per brokerage.
 */
export async function runSubscriberStallSweep(svc: any, now: Date = new Date(), deps: SubscriberStallDeps = {}): Promise<SubscriberStallSweepResult> {
  const out: SubscriberStallSweepResult = { scanned: 0, pending: 0, nudged: 0, escalated: 0, skipped: 0, errors: [] }
  const since = new Date(now.getTime() - STALL_LOOKBACK_DAYS * DAY_MS).toISOString()
  const { data: rows, error: readErr } = await svc.from("brokerages")
    .select("id, name, email, created_at, onboarding_status, plan_tier, billing_metadata, is_demo")
    .gte("created_at", since).limit(1000)
  if (readErr) { out.errors.push(`brokerages read: ${readErr.message}`); return out }
  const list = ((rows ?? []) as Array<Record<string, unknown>>).filter((b) => b.is_demo !== true)
  if (list.length === 0) return out

  const ids = list.map((b) => b.id as string)
  const { data: subs, error: subErr } = await svc.from("subscriptions")
    .select("brokerage_id, status, stripe_subscription_id, trial_end").in("brokerage_id", ids)
  if (subErr) out.errors.push(`subscriptions read: ${subErr.message}`)
  const subByBrokerage = new Map<string, SubscriberStallRow["subscription"]>()
  for (const s of (subs ?? []) as Array<{ brokerage_id: string; status: string | null; stripe_subscription_id: string | null; trial_end: string | null }>) {
    subByBrokerage.set(s.brokerage_id, { status: s.status, stripe_subscription_id: s.stripe_subscription_id, trial_end: s.trial_end })
  }

  const appUrl = (deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")
  let rep: { userId: string; brokerageId: string } | null | undefined
  let brandName: string | undefined = deps.brandName

  for (const b of list) {
    out.scanned++
    const row: SubscriberStallRow = {
      id: b.id as string, name: (b.name as string | null) ?? null, email: (b.email as string | null) ?? null,
      created_at: b.created_at as string, onboarding_status: (b.onboarding_status as string | null) ?? null,
      plan_tier: (b.plan_tier as string | null) ?? null,
      billing_metadata: (b.billing_metadata && typeof b.billing_metadata === "object" ? b.billing_metadata : null) as Record<string, unknown> | null,
      subscription: subByBrokerage.get(b.id as string) ?? null,
    }
    const state = subscriberStallState(row, now)
    if (!state.kind) continue
    out.pending++
    if (!state.due) { out.skipped++; continue }

    try {
      const { data: owners, error: ownerErr } = await svc.from("users")
        .select("id, email, first_name").eq("brokerage_id", row.id)
        .in("user_type", ["broker", "broker_owner", "admin"]).order("created_at", { ascending: true }).limit(1)
      if (ownerErr) { out.errors.push(`${row.id} owner read: ${ownerErr.message}`); continue }
      const owner = ((owners ?? []) as Array<{ id: string; email: string | null; first_name: string | null }>)[0] ?? null
      const to = owner?.email ?? row.email
      const firstName = owner?.first_name?.trim() || "there"
      if (brandName === undefined) {
        try { const { loadProductBrand } = await import("@/lib/platform/product-brand"); brandName = (await loadProductBrand(svc)).name } catch { brandName = "the platform" }
      }
      const stamp = ((row.billing_metadata?.subscriber_stall ?? null) as SubscriberStallStamp | null) ?? {}
      const nextStamp: SubscriberStallStamp = { ...stamp }

      if (state.due === "nudge" || (state.due === "escalate" && !stamp.nudged_at)) {
        const copy = composeStallNudge({ kind: state.kind, brandName: brandName ?? "the platform", brokerageName: row.name ?? "Your brokerage", firstName, planTier: row.plan_tier, appUrl })
        if (to) {
          if (rep === undefined) {
            const resolveRep = deps.resolveRep ?? (async (client: any) => { const { resolvePlatformSalesRep } = await import("@/lib/platform/sales-rep"); return resolvePlatformSalesRep(client) })
            rep = await resolveRep(svc)
          }
          if (!rep) out.errors.push(`${row.id}: no platform sales rep to send the nudge from`)
          else {
            const dispatch = deps.dispatch ?? (async (params: Record<string, unknown>) => { const { dispatchEmail } = await import("@/lib/providers/dispatch"); return dispatchEmail(params as never) })
            const sent = await dispatch({ to, brokerageId: rep.brokerageId, userId: rep.userId, subject: copy.subject, html: copy.html, text: copy.text, channelPurpose: "transactional", systemSource: "platform_subscriber_stall_nudge" })
            if (!sent.success) out.errors.push(`${row.id} nudge email: ${sent.error ?? "not sent"}`)
          }
        }
        if (owner) {
          const { error: bellErr } = await svc.from("notifications").insert({
            user_id: owner.id, brokerage_id: row.id, type: "onboarding_reminder",
            title: copy.bellTitle, body: copy.bellBody, priority: "high", is_read: false,
          })
          if (bellErr) out.errors.push(`${row.id} bell: ${bellErr.message}`)
        }
        nextStamp.nudged_at = now.toISOString()
        out.nudged++
      }

      if (state.due === "escalate") {
        const notify = deps.notifyStaff ?? (async (client: any, n: Parameters<NonNullable<SubscriberStallDeps["notifyStaff"]>>[1]) => { const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff"); return notifyPlatformStaff(client as never, n) })
        const n = await notify(svc, {
          type: "platform_subscriber_stalled",
          title: state.kind === "activation_pending" ? "A paid signup never finished checkout" : "A new subscriber never signed in",
          body: `${row.name ?? row.id} (${to ?? "no email"}) — ${(row.plan_tier ?? "plan").replace(/_/g, " ")}, day ${state.ageDays}: ${state.kind === "activation_pending" ? "the activation checkout never cleared; call them and send a fresh link" : "the workspace was never opened; a 10-minute call gets them into the wizard"}. Nudged on ${nextStamp.nudged_at ?? stamp.nudged_at ?? "—"}.`,
          entityType: "brokerage", entityId: row.id, priority: "high",
        }).catch((e: unknown) => { out.errors.push(`${row.id} staff bell: ${(e as Error)?.message}`); return 0 })
        nextStamp.escalated_at = now.toISOString()
        if (n > 0) out.escalated++
        else out.errors.push(`${row.id}: escalation reached no platform staff`)
      }

      // The stamp — COUNTED (§3): zero rows means the brokerage vanished mid-run.
      const { data: stamped, error: stampErr } = await svc.from("brokerages")
        .update({ billing_metadata: { ...(row.billing_metadata ?? {}), subscriber_stall: nextStamp }, updated_at: now.toISOString() })
        .eq("id", row.id).select("id")
      if (stampErr) out.errors.push(`${row.id} stamp: ${stampErr.message}`)
      else if (((stamped ?? []) as unknown[]).length !== 1) out.errors.push(`${row.id} stamp matched ${((stamped ?? []) as unknown[]).length} rows`)
    } catch (err) {
      out.errors.push(`${row.id}: ${(err as Error)?.message ?? String(err)}`)
    }
  }
  return out
}
