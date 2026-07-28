// lib/billing/dunning.ts
// ─────────────────────────────────────────────────────────────────────────────
// DUNNING — past-due payment RECOVERY, the half of the money loop the paywall
// alone can't close. Today a failed payment produced ONE webhook notification
// and then silence: the tenant hit the paywall at next login and nobody followed
// up. This is the follow-up: a pure escalation ladder (day 0 → 3 → 7 → 14) that
// nudges the tenant admin toward the billing page, each step sent EXACTLY ONCE
// per past-due episode (platform_dunning_events is the dedupe + audit spine).
// Honest mechanics: in-app notification always; email only when SendGrid creds
// exist (creds-gated, never faked). Nothing here suspends an account — the
// paywall (billing-access) already gates access; dunning is the communication.

export interface DunningStep {
  step: number
  /** Days past due before this step fires. */
  afterDays: number
  subject: string
  /** Body template — {brokerage} and {amount} substituted. */
  body: string
}

// The ladder. Tone escalates but stays factual — no fabricated deadlines; the
// day-14 step states the real consequence (access already restricted + Stripe
// retries eventually cancel).
export const DUNNING_LADDER: DunningStep[] = [
  {
    step: 1, afterDays: 0,
    subject: "Payment issue on your {brokerage} subscription",
    body: "A recent payment for {brokerage} didn't go through{amount}. This is usually an expired or declined card — you can update your payment method in a minute from your billing page. Your data is safe and nothing has been deleted.",
  },
  {
    step: 2, afterDays: 3,
    subject: "Reminder: {brokerage} subscription payment still failing",
    body: "We still couldn't collect payment for {brokerage}{amount}. Stripe retries automatically, but the fastest fix is updating the card on your billing page. If something looks wrong on our side, reply and platform support will dig in.",
  },
  {
    step: 3, afterDays: 7,
    subject: "One week past due — {brokerage} access is restricted",
    body: "It's been a week since the payment for {brokerage} failed{amount}. Sign-ins now route to the billing page until payment is restored. Everything — contacts, deals, history — is intact and waiting.",
  },
  {
    step: 4, afterDays: 14,
    subject: "Final notice: {brokerage} subscription will cancel",
    body: "Payment for {brokerage} has been failing for two weeks{amount}. When Stripe exhausts its retries the subscription cancels automatically. Update the payment method today to keep the account active — or contact support if you're winding down and want a data export.",
  },
]

/** PURE: whole days between two ISO timestamps (floored, never negative). */
export function daysBetween(fromIso: string, nowIso: string): number {
  const ms = new Date(nowIso).getTime() - new Date(fromIso).getTime()
  return Math.max(0, Math.floor(ms / 86_400_000))
}

/**
 * PURE: given how many days a subscription has been past due and which steps
 * were already sent THIS episode, the single next step due — or null. Never
 * skips a rung mid-episode is deliberately NOT enforced: if a sweep was down
 * for days, the highest due unsent step fires (the tenant gets the current
 * truth, not a stale drip backlog).
 */
export function planNextDunningStep(daysPastDue: number, sentSteps: number[]): DunningStep | null {
  const due = DUNNING_LADDER.filter((s) => daysPastDue >= s.afterDays && !sentSteps.includes(s.step))
  if (due.length === 0) return null
  return due[due.length - 1]
}

/** PURE: render a step's subject/body for a tenant. amountCents null → clause omitted. */
export function composeDunningMessage(
  step: DunningStep, brokerageName: string, amountCents: number | null,
): { subject: string; body: string } {
  const amount = amountCents && amountCents > 0
    ? ` (${"$" + (amountCents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })})`
    : ""
  const sub = (t: string) => t.split("{brokerage}").join(brokerageName).split("{amount}").join(amount)
  return { subject: sub(step.subject), body: sub(step.body) }
}

/**
 * PURE: the anchor a past-due episode ages from — the oldest OPEN invoice's
 * date, else the subscription's own updated_at (status flip time). Events
 * older than the anchor belong to a PREVIOUS episode and don't dedupe this one.
 */
export function episodeAnchor(
  sub: { updated_at: string | null },
  openInvoices: Array<{ invoice_date: string | null; due_date: string | null }>,
): string | null {
  const dates = openInvoices.map((i) => i.due_date ?? i.invoice_date).filter(Boolean) as string[]
  if (dates.length > 0) return dates.sort()[0]
  return sub.updated_at ?? null
}

export interface DunningSweepResult {
  pastDueCount: number
  stepsSent: number
  emailed: number
  errors: number
}

/**
 * Sweep every past-due subscription: compute the episode anchor, dedupe against
 * platform_dunning_events since the anchor, send the next due step (in-app to
 * the tenant's billing admins always; email best-effort via the canonical
 * provider sender when creds exist), and record the event.
 */
export async function runDunningSweep(svc: any, now: Date = new Date()): Promise<DunningSweepResult> {
  const result: DunningSweepResult = { pastDueCount: 0, stepsSent: 0, emailed: 0, errors: 0 }
  const { data: subs } = await svc
    .from("subscriptions")
    .select("id, brokerage_id, status, updated_at")
    .in("status", ["past_due", "unpaid"])
    .limit(500)

  for (const sub of (subs ?? []) as Array<{ id: string; brokerage_id: string; status: string; updated_at: string | null }>) {
    result.pastDueCount += 1
    try {
      const [{ data: invoices }, { data: brk }] = await Promise.all([
        svc.from("billing_invoices").select("invoice_date, due_date, amount_cents, status")
          .eq("brokerage_id", sub.brokerage_id).eq("status", "open")
          .order("invoice_date", { ascending: true }).limit(10),
        svc.from("brokerages").select("name, email").eq("id", sub.brokerage_id).maybeSingle(),
      ])
      const open = (invoices ?? []) as Array<{ invoice_date: string | null; due_date: string | null; amount_cents: number | null }>
      const anchor = episodeAnchor(sub, open)
      if (!anchor) continue
      const daysPastDue = daysBetween(anchor, now.toISOString())

      const { data: priorEvents } = await svc
        .from("platform_dunning_events").select("step, created_at")
        .eq("subscription_id", sub.id).gte("created_at", anchor)
      const sentSteps = ((priorEvents ?? []) as Array<{ step: number }>).map((e) => e.step)

      const step = planNextDunningStep(daysPastDue, sentSteps)
      if (!step) continue

      const brokerageName = (brk as any)?.name ?? "your brokerage"
      const amountCents = open[0]?.amount_cents ?? null
      const msg = composeDunningMessage(step, brokerageName, amountCents)

      // In-app to the tenant's billing admins (broker/admin user types).
      const { data: admins } = await svc
        .from("users").select("id, email")
        .eq("brokerage_id", sub.brokerage_id)
        .in("user_type", ["broker", "admin"]).limit(20)
      const adminRows = (admins ?? []) as Array<{ id: string; email: string | null }>
      if (adminRows.length > 0) {
        await svc.from("notifications").insert(adminRows.map((a) => ({
          user_id: a.id, brokerage_id: sub.brokerage_id, type: "billing_dunning",
          title: msg.subject.slice(0, 200), body: msg.body.slice(0, 480),
          entity_type: "subscription", entity_id: sub.id, priority: "high",
          channel: "in_app", is_read: false,
        })))
      }

      // Email best-effort — canonical provider sender, SendGrid-gated (honest no-op without creds).
      let channel = "in_app"
      if (process.env.SENDGRID_API_KEY) {
        try {
          const { sendEmail } = await import("@/lib/providers/messaging")
          const to = adminRows.map((a) => a.email).filter(Boolean) as string[]
          const target = to[0] ?? (brk as any)?.email
          if (target) {
            const sent = await sendEmail({ to: target, subject: msg.subject, html: `<p>${msg.body}</p>` })
            if (sent.success) { channel = "email"; result.emailed += 1 }
          }
        } catch { /* best-effort — the in-app notification already landed */ }
      }

      await svc.from("platform_dunning_events").insert({
        brokerage_id: sub.brokerage_id, subscription_id: sub.id,
        step: step.step, channel, detail: msg.subject.slice(0, 300),
      })
      result.stepsSent += 1
    } catch {
      result.errors += 1
    }
  }
  return result
}
