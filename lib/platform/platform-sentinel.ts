// lib/platform/platform-sentinel.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM SENTINEL MANAGER — the AI staff-side manager that watches the whole
// subscriber fleet and composes a daily proposed-action list WITH drafted
// outreach, so platform staff approve instead of operate.
//
// PURE by design (like engagement-risk.ts / support-sla.ts): this module takes
// plain FACT inputs — fleet engagement rows, expiring tenant credentials,
// dunning events, SLA breaches, expiring trials — and returns proposed rows for
// platform_sentinel_actions. No I/O here; the cron
// (app/api/cron/platform-sentinel/route.ts) loads live facts and upserts on the
// deterministic dedupe_key (ignore-duplicates), so re-runs never duplicate.
//
// FACT SOURCES (each mirrors the console that owns the signal, so the sentinel
// and the boards can never disagree):
//   • engagement    — classifyEngagement inputs (lib/platform/engagement-risk),
//                     the same tiers the engagement radar shows
//   • connections   — deriveConnectivityStatus over the three credential stores
//                     (lib/agentic-os/connectivity-agent), same as connection-health
//   • dunning       — platform_dunning_events steps (lib/billing/dunning ladder)
//   • support SLA   — evaluateTicketSla breaches (lib/support/support-sla)
//   • trials        — reconciled trial end (subscriptions.trial_end ??
//                     brokerages.trial_ends_at, the subscription-oversight rule)
//
// DEDUPE BUCKET: `${kind}:${brokerageId}:…:${weekBucket(now)}` — the bucket is
// the Monday of `now`'s week (yyyy-mm-dd-ish, deterministic from the passed-in
// now). One proposal per condition per week: an unacted row simply STAYS in the
// proposed queue; a dismissed row is not re-proposed until the next week if the
// condition persists. Ticket-scoped keys carry the ticket id so distinct
// breached tickets never collapse.
//
// OUTREACH DRAFTS are composed from the real facts (days silent, provider
// names, expiry dates, dunning step, trial end) and the platform's OWN brand
// name (lib/platform/product-brand — never hardcoded; the caller resolves it).

import { classifyEngagement, daysSinceActivity } from "@/lib/platform/engagement-risk"

export type SentinelKind =
  | "engagement_risk" | "connection_expiry" | "dunning_risk"
  | "support_sla" | "growth_opportunity" | "demo_followup"
export type SentinelSeverity = "info" | "warn" | "critical"
export type SentinelChannel = "email" | "sms" | "call" | "none"

/** A row proposed for platform_sentinel_actions (status starts 'proposed'). */
export interface ProposedSentinelAction {
  kind: SentinelKind
  severity: SentinelSeverity
  brokerageId: string | null
  title: string
  detail: string
  draftChannel: SentinelChannel
  draftText: string
  dedupeKey: string
}

// ── Fact shapes (plain data — the cron assembles these from live rows) ────────

export interface EngagementFact {
  brokerageId: string
  brokerageName: string
  /** brokerages.created_at — a brand-new tenant with no sign-in yet is onboarding, not churning. */
  tenantCreatedAt: string | null
  /** Newest auth.users.last_sign_in_at across the tenant's team; null = never. */
  lastSignInAt: string | null
  teamSize: number
}

export interface ConnectionExpiryFact {
  brokerageId: string
  brokerageName: string
  provider: string
  status: "expiring_soon" | "expired"
  expiresAt: string | null
}

export interface DunningFact {
  brokerageId: string
  brokerageName: string
  /** Highest dunning-ladder step recorded this episode (1–4, lib/billing/dunning). */
  step: number
  occurredAt: string
}

export interface SlaBreachFact {
  brokerageId: string | null
  brokerageName: string | null
  ticketId: string
  subject: string | null
  priority: string | null
  ageHours: number
  kinds: Array<"first_response" | "resolution">
}

export interface TrialFact {
  brokerageId: string
  brokerageName: string
  trialEndsAt: string
  daysLeft: number
}

export interface SentinelFacts {
  engagement: EngagementFact[]
  connections: ConnectionExpiryFact[]
  dunning: DunningFact[]
  slaBreaches: SlaBreachFact[]
  trials: TrialFact[]
}

export const SEVERITY_ORDER: Record<SentinelSeverity, number> = { critical: 0, warn: 1, info: 2 }

const DAY_MS = 86_400_000

/**
 * PURE: the dedupe bucket — the Monday of `now`'s week as yyyy-mm-dd (UTC).
 * Weekly, not daily, so a persistent condition proposes at most once a week
 * while the unacted row itself keeps sitting in the queue.
 */
export function sentinelBucket(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dow = d.getUTCDay() // 0=Sun … 6=Sat
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7)) // back to Monday
  return d.toISOString().slice(0, 10)
}

function fmtDate(iso: string | null): string {
  if (!iso) return "an unknown date"
  const t = new Date(iso)
  return Number.isNaN(t.getTime()) ? "an unknown date" : t.toISOString().slice(0, 10)
}

// ── Composers per signal ──────────────────────────────────────────────────────

function composeEngagement(f: EngagementFact, brandName: string, now: Date, bucket: string): ProposedSentinelAction | null {
  const tier = classifyEngagement({ lastActivityAt: f.lastSignInAt, createsLast30d: 0, createsPrior30d: 0 }, now)
  if (tier !== "at_risk") return null

  const days = daysSinceActivity(f.lastSignInAt, now)
  const never = !Number.isFinite(days)
  // A tenant that has NEVER signed in but is under 14 days old is still
  // onboarding — the onboarding loops own that window, not churn outreach.
  if (never && f.tenantCreatedAt && daysSinceActivity(f.tenantCreatedAt, now) <= 14) return null

  const silentLabel = never ? "has never signed in" : `has had no team sign-in in ${Math.floor(days)} days`
  const severity: SentinelSeverity = never || days > 30 ? "critical" : "warn"
  const draft = [
    `Subject: Checking in from ${brandName}`,
    ``,
    `Hi ${f.brokerageName} team,`,
    ``,
    never
      ? `We noticed nobody from your team has signed in to ${brandName} yet. That usually means something got in the way of getting started — and we'd like to fix that, not watch it.`
      : `We noticed nobody from your team has signed in to ${brandName} in about ${Math.floor(days)} days. When usage goes quiet it usually means something isn't earning its place — and we'd rather hear it than guess.`,
    ``,
    `Would a short working session help? We can walk your team through the parts of the platform doing the most for brokerages like yours, or dig into whatever got stuck. Just reply to this email and we'll set it up.`,
    ``,
    `— The ${brandName} team`,
  ].join("\n")

  return {
    kind: "engagement_risk",
    severity,
    brokerageId: f.brokerageId,
    title: `${f.brokerageName} ${never ? "has never signed in" : `quiet for ${Math.floor(days)} days`}`,
    detail: `Engagement radar: ${f.brokerageName} (team of ${f.teamSize}) ${silentLabel}${f.lastSignInAt ? ` (last sign-in ${fmtDate(f.lastSignInAt)})` : ""}. Tier: at risk.`,
    draftChannel: "email",
    draftText: draft,
    dedupeKey: `engagement_risk:${f.brokerageId}:${bucket}`,
  }
}

function composeConnections(facts: ConnectionExpiryFact[], brandName: string, bucket: string): ProposedSentinelAction[] {
  // One action per TENANT, listing every lapsing provider — a single email
  // covering all of them beats one per connector.
  const byTenant = new Map<string, ConnectionExpiryFact[]>()
  for (const f of facts) {
    const list = byTenant.get(f.brokerageId) ?? []
    list.push(f)
    byTenant.set(f.brokerageId, list)
  }
  const out: ProposedSentinelAction[] = []
  for (const [brokerageId, list] of byTenant) {
    const name = list[0].brokerageName
    const expired = list.filter((c) => c.status === "expired")
    const expiring = list.filter((c) => c.status === "expiring_soon")
    const describe = (c: ConnectionExpiryFact) =>
      c.status === "expired" ? `${c.provider} (expired ${fmtDate(c.expiresAt)})` : `${c.provider} (expires ${fmtDate(c.expiresAt)})`
    const parts = [...expired, ...expiring].map(describe)
    const draft = [
      `Subject: Action needed — ${parts.length === 1 ? `your ${list[0].provider} connection` : `${parts.length} of your connections`} on ${brandName}`,
      ``,
      `Hi ${name} team,`,
      ``,
      expired.length > 0
        ? `The following connection${expired.length === 1 ? " has" : "s have"} expired, which means the automations that depend on ${expired.length === 1 ? "it are" : "them are"} paused: ${expired.map(describe).join(", ")}.`
        : `A heads-up before anything breaks: ${expiring.map(describe).join(", ")} — the token${expiring.length === 1 ? " is" : "s are"} about to lapse.`,
      expired.length > 0 && expiring.length > 0
        ? `Also coming up: ${expiring.map(describe).join(", ")}.`
        : "",
      ``,
      `Reconnecting takes about a minute from your dashboard's connections panel — sign in, open Connections, and hit reconnect on the flagged provider${parts.length === 1 ? "" : "s"}. Reply here if anything fights back and we'll jump in.`,
      ``,
      `— The ${brandName} team`,
    ].filter((l) => l !== "").join("\n")

    out.push({
      kind: "connection_expiry",
      severity: expired.length > 0 ? "critical" : "warn",
      brokerageId,
      title: `${name}: ${parts.length} connection${parts.length === 1 ? "" : "s"} ${expired.length > 0 ? "expired/expiring" : "expiring soon"}`,
      detail: `Connection health: ${parts.join("; ")}. Automations depending on expired tokens are paused until the tenant reconnects.`,
      draftChannel: "email",
      draftText: draft,
      dedupeKey: `connection_expiry:${brokerageId}:${bucket}`,
    })
  }
  return out
}

function composeDunning(facts: DunningFact[], brandName: string, bucket: string): ProposedSentinelAction[] {
  // The automated ladder (lib/billing/dunning) owns steps 1–2. The sentinel
  // proposes a HUMAN call once a tenant is a week+ past due (step ≥ 3) — the
  // point where an email drip stops working and a person should pick up the phone.
  const byTenant = new Map<string, DunningFact>()
  for (const f of facts) {
    const prev = byTenant.get(f.brokerageId)
    if (!prev || f.step > prev.step) byTenant.set(f.brokerageId, f)
  }
  const out: ProposedSentinelAction[] = []
  for (const f of byTenant.values()) {
    if (f.step < 3) continue
    const final = f.step >= 4
    const script = [
      `Call script — ${f.brokerageName} (dunning step ${f.step}):`,
      ``,
      `"Hi, this is [your name] from ${brandName}. I'm calling because the payment on your subscription has been failing for ${final ? "over two weeks" : "over a week"} and I wanted to reach a person before anything happens automatically."`,
      ``,
      `• Confirm they've seen the emails; the usual fix is an expired/declined card on the billing page.`,
      final
        ? `• Be straight about the stakes: when Stripe exhausts its retries the subscription cancels on its own. If they're winding down, offer a data export instead of a surprise cancellation.`
        : `• Access is already restricted to the billing page — their data is intact; nothing is deleted.`,
      `• If they say the failure looks wrong on our side, take the details and open a support ticket for them on the spot.`,
    ].join("\n")

    out.push({
      kind: "dunning_risk",
      severity: final ? "critical" : "warn",
      brokerageId: f.brokerageId,
      title: `${f.brokerageName} at dunning step ${f.step}${final ? " — final notice sent" : ""}`,
      detail: `Dunning ladder reached step ${f.step} on ${fmtDate(f.occurredAt)} (${final ? "final notice: subscription cancels when Stripe exhausts retries" : "one week past due; access restricted to billing"}). Automated emails have not recovered payment — propose a human call.`,
      draftChannel: "call",
      draftText: script,
      dedupeKey: `dunning_risk:${f.brokerageId}:${bucket}`,
    })
  }
  return out
}

function composeSla(f: SlaBreachFact, bucket: string): ProposedSentinelAction {
  const labels = f.kinds.map((k) => (k === "first_response" ? "first response" : "resolution"))
  const severity: SentinelSeverity =
    f.kinds.includes("resolution") || f.priority === "urgent" ? "critical" : "warn"
  return {
    kind: "support_sla",
    severity,
    brokerageId: f.brokerageId,
    title: `SLA breach: ${f.subject ?? "Support ticket"}`,
    detail: `Ticket ${f.ticketId} (${f.brokerageName ?? "unknown tenant"}, priority ${f.priority ?? "medium"}) is ${Math.round(f.ageHours)}h old and past its ${labels.join(" and ")} target${labels.length === 1 ? "" : "s"}.`,
    // No outreach draft — the honest action is answering the ticket in the
    // support console, not sending a side-channel message.
    draftChannel: "none",
    draftText: `Internal action: open the support console, take ownership of ticket ${f.ticketId}, and ${f.kinds.includes("first_response") ? "send the first response now" : "drive it to resolution"}. The tenant already sees the clock — the reply IS the outreach.`,
    dedupeKey: `support_sla:${f.brokerageId ?? "none"}:${f.ticketId}:${bucket}`,
  }
}

function composeTrial(f: TrialFact, brandName: string, bucket: string): ProposedSentinelAction | null {
  if (f.daysLeft < 0 || f.daysLeft > 7) return null
  const dayWord = f.daysLeft === 0 ? "today" : f.daysLeft === 1 ? "tomorrow" : `in ${f.daysLeft} days`
  const draft = [
    `Subject: Your ${brandName} trial ends ${dayWord}`,
    ``,
    `Hi ${f.brokerageName} team,`,
    ``,
    `Your ${brandName} trial ends ${dayWord} (${fmtDate(f.trialEndsAt)}). If the platform has been pulling its weight, converting takes two minutes from your billing page and nothing about your setup changes — contacts, pipelines, and automations all carry straight over.`,
    ``,
    `If you're on the fence, reply and tell us what's missing — a short call with someone who can actually change things is yours for the asking.`,
    ``,
    `— The ${brandName} team`,
  ].join("\n")
  return {
    kind: "growth_opportunity",
    severity: f.daysLeft <= 3 ? "warn" : "info",
    brokerageId: f.brokerageId,
    title: `${f.brokerageName}'s trial ends ${dayWord}`,
    detail: `Trial ends ${fmtDate(f.trialEndsAt)} (${f.daysLeft} day${f.daysLeft === 1 ? "" : "s"} left). Convert-or-lapse window — propose a conversion nudge.`,
    draftChannel: "email",
    draftText: draft,
    dedupeKey: `growth_opportunity:${f.brokerageId}:trial:${bucket}`,
  }
}

/**
 * PURE: split a drafted email into { subject, body }. Drafts here lead with a
 * "Subject: …" line (so the queue shows staff the whole message verbatim); the
 * send rail needs the parts. A draft without that line falls back to the given
 * default subject with the full text as body.
 */
export function splitDraftEmail(draftText: string, defaultSubject: string): { subject: string; body: string } {
  const m = draftText.match(/^Subject:\s*(.+)\r?\n/)
  if (!m) return { subject: defaultSubject, body: draftText.trim() }
  return { subject: m[1].trim(), body: draftText.slice(m[0].length).trim() }
}

/**
 * PURE: compose the day's proposed staff actions from fleet facts. Severity-
 * ordered (critical first), deterministic dedupe keys from the passed-in now.
 */
export function composeSentinelActions(
  facts: SentinelFacts,
  brand: { name: string },
  now: Date,
): ProposedSentinelAction[] {
  const bucket = sentinelBucket(now)
  const out: ProposedSentinelAction[] = []

  for (const f of facts.engagement) {
    const a = composeEngagement(f, brand.name, now, bucket)
    if (a) out.push(a)
  }
  out.push(...composeConnections(facts.connections, brand.name, bucket))
  out.push(...composeDunning(facts.dunning, brand.name, bucket))
  for (const f of facts.slaBreaches) out.push(composeSla(f, bucket))
  for (const f of facts.trials) {
    const a = composeTrial(f, brand.name, bucket)
    if (a) out.push(a)
  }

  out.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.kind.localeCompare(b.kind) ||
      a.dedupeKey.localeCompare(b.dedupeKey),
  )
  return out
}
