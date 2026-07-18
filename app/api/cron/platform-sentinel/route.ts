import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { canonicalProvider } from "@/lib/integrations/connection-manager"
import { deriveConnectivityStatus, transportFor } from "@/lib/agentic-os/connectivity-agent"
import { evaluateTicketSla } from "@/lib/support/support-sla"
import { loadProductBrand } from "@/lib/platform/product-brand"
import {
  composeSentinelActions,
  summarizeSentinelVerdicts,
  applySentinelLearning,
  SENTINEL_LEARNING_WINDOW_DAYS,
  type SentinelFacts,
  type ConnectionExpiryFact,
  type SentinelVerdictRow,
} from "@/lib/platform/platform-sentinel"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Platform Sentinel Cron — daily fleet watch. Loads live facts from the same
 * sources the individual superadmin boards read (engagement sign-ins, the three
 * credential stores, platform_dunning_events, open support tickets, trial
 * ends), runs the PURE composer (lib/platform/platform-sentinel.ts), applies
 * THE SENTINEL FLYWHEEL (staff verdicts from the last 90 days suppress
 * tenant-rejected kinds and downgrade fleet-dismissed kinds — pure feedback
 * layer in the same module), and upserts proposed actions on the deterministic
 * dedupe_key with ignoreDuplicates — re-runs never duplicate a proposal.
 * Staff approve/dismiss from the Sentinel page
 * (app/dashboard/superadmin/sentinel) — and those verdicts are what the next
 * sweep learns from.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "platform-sentinel",
    cron_path: "/app/api/cron/platform-sentinel/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const svc = createServiceClient()
    const now = new Date()
    const facts = await loadSentinelFacts(svc, now)
    const brand = await loadProductBrand(svc)
    const composed = composeSentinelActions(facts, brand, now)

    // ── THE SENTINEL FLYWHEEL: staff verdicts from the learning window feed
    // back into today's proposals (tenant suppression, kind downgrade) BEFORE
    // anything is upserted. The verdict table is the training signal.
    const decidedSince = new Date(now.getTime() - SENTINEL_LEARNING_WINDOW_DAYS * DAY_MS).toISOString()
    const { data: decidedRows, error: decidedErr } = await svc
      .from("platform_sentinel_actions")
      .select("kind, brokerage_id, status, acted_at")
      .in("status", ["approved", "sent", "dismissed"])
      .gte("acted_at", decidedSince)
      .limit(5000)
    if (decidedErr) throw new Error(`Failed to load sentinel verdicts: ${decidedErr.message}`)
    const verdictRows: SentinelVerdictRow[] = ((decidedRows ?? []) as any[]).map((r) => ({
      kind: r.kind as string,
      brokerageId: (r.brokerage_id as string | null) ?? null,
      status: r.status as string,
      actedAt: (r.acted_at as string | null) ?? null,
    }))
    const verdicts = summarizeSentinelVerdicts(verdictRows)
    const learned = applySentinelLearning(composed, verdicts)
    if (learned.suppressed.length > 0) {
      console.log(
        `[platform-sentinel] flywheel suppressed ${learned.suppressed.length} proposal(s): ` +
          learned.suppressed.map((s) => `${s.kind}@${s.brokerageId} (streak ${s.streak})`).join(", "),
      )
    }
    const proposed = learned.proposals

    let inserted = 0
    if (proposed.length > 0) {
      const rows = proposed.map((p) => ({
        kind: p.kind,
        severity: p.severity,
        brokerage_id: p.brokerageId,
        title: p.title.slice(0, 300),
        detail: p.detail.slice(0, 2000),
        draft_channel: p.draftChannel,
        draft_text: p.draftText.slice(0, 5000),
        status: "proposed",
        dedupe_key: p.dedupeKey,
      }))
      // Idempotent: dedupe_key is UNIQUE; existing rows (whatever their status —
      // proposed, approved, dismissed, sent) are left untouched.
      const { error, count } = await svc
        .from("platform_sentinel_actions")
        .upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true, count: "exact" })
      if (error) throw new Error(`Upsert failed: ${error.message}`)
      inserted = count ?? 0
    }

    const summary = {
      composed: composed.length,
      afterLearning: proposed.length,
      inserted,
      learning: {
        windowDays: SENTINEL_LEARNING_WINDOW_DAYS,
        decisionsConsidered: verdictRows.length,
        suppressedCount: learned.suppressed.length,
        suppressed: learned.suppressed.map((s) => ({
          kind: s.kind,
          brokerage_id: s.brokerageId,
          streak: s.streak,
          note: s.note,
        })),
        downgradedKinds: learned.downgradedKinds,
      },
      facts: {
        engagement: facts.engagement.length,
        connections: facts.connections.length,
        dunning: facts.dunning.length,
        slaBreaches: facts.slaBreaches.length,
        trials: facts.trials.length,
      },
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: inserted,
      metadata: summary as any,
    })
    return NextResponse.json({ message: "Platform sentinel sweep complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Platform sentinel sweep failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

const DAY_MS = 86_400_000

/**
 * Assemble the fleet facts, each from the SAME source its owning board reads:
 *  • engagement — auth.users.last_sign_in_at joined through public.users
 *    membership (the engagement radar's chosen activity source)
 *  • connections — the three credential stores with agent → platform →
 *    integration precedence + deriveConnectivityStatus (connection-health board)
 *  • dunning — platform_dunning_events, last 14 days (the ladder's audit spine)
 *  • SLA — evaluateTicketSla over open tickets (support console's clock)
 *  • trials — subscriptions.trial_end ?? brokerages.trial_ends_at (the
 *    subscription-oversight reconciliation rule)
 */
async function loadSentinelFacts(svc: any, now: Date): Promise<SentinelFacts> {
  const { data: brokerages, error: brkError } = await svc
    .from("brokerages")
    .select("id, name, created_at, trial_ends_at")
    .is("deleted_at", null)
  if (brkError) throw new Error(`Failed to load brokerages: ${brkError.message}`)
  const tenants = (brokerages ?? []) as Array<{ id: string; name: string | null; created_at: string | null; trial_ends_at: string | null }>
  const tenantIds = new Set(tenants.map((t) => t.id))
  const nameOf = new Map(tenants.map((t) => [t.id, t.name ?? "(unnamed)"]))

  // ── Engagement: newest real sign-in per tenant (Supabase Auth admin API) ────
  const lastSignInByAuthId = new Map<string, string>()
  for (let page = 1; page <= 20; page++) {
    const { data: authPage, error: authError } = await svc.auth.admin.listUsers({ page, perPage: 1000 })
    if (authError) throw new Error(`Failed to read auth sign-ins: ${authError.message}`)
    for (const u of authPage.users) {
      if (u.last_sign_in_at) lastSignInByAuthId.set(u.id, u.last_sign_in_at)
    }
    if (authPage.users.length < 1000) break
  }
  const signIn = new Map<string, { last: string | null; team: number }>()
  for (let from = 0; ; from += 1000) {
    const { data: userPage, error: usersError } = await svc
      .from("users")
      .select("id, brokerage_id, is_contact")
      .not("brokerage_id", "is", null)
      .is("deleted_at", null)
      .order("id")
      .range(from, from + 999)
    if (usersError) throw new Error(`Failed to load tenant users: ${usersError.message}`)
    for (const u of (userPage ?? []) as any[]) {
      if (u.is_contact === true || !tenantIds.has(u.brokerage_id)) continue
      const agg = signIn.get(u.brokerage_id) ?? { last: null, team: 0 }
      agg.team += 1
      const last = lastSignInByAuthId.get(u.id) ?? null
      if (last && (!agg.last || last > agg.last)) agg.last = last
      signIn.set(u.brokerage_id, agg)
    }
    if ((userPage ?? []).length < 1000) break
  }
  const engagement = tenants
    .filter((t) => (signIn.get(t.id)?.team ?? 0) > 0) // no team yet = provisioning, not churn
    .map((t) => ({
      brokerageId: t.id,
      brokerageName: nameOf.get(t.id) ?? "(unnamed)",
      tenantCreatedAt: t.created_at,
      lastSignInAt: signIn.get(t.id)?.last ?? null,
      teamSize: signIn.get(t.id)?.team ?? 0,
    }))

  // ── Connections: three stores, connection-health precedence + derivation ────
  const [agentCreds, platCreds, intCreds] = await Promise.all([
    svc.from("agent_api_credentials").select("brokerage_id, service_name, token_expires_at, is_active"),
    svc.from("platform_credentials").select("brokerage_id, platform, token_expires_at, is_active"),
    svc.from("integration_credentials").select("brokerage_id, provider_name, is_active"),
  ])
  const byTenantCreds = new Map<string, Map<string, { isActive: boolean; tokenExpiresAt: string | null }>>()
  const setOnce = (brokerageId: string | null, provider: string | null, entry: { isActive: boolean; tokenExpiresAt: string | null }) => {
    if (!brokerageId || !provider || !tenantIds.has(brokerageId)) return
    let m = byTenantCreds.get(brokerageId)
    if (!m) { m = new Map(); byTenantCreds.set(brokerageId, m) }
    const canon = canonicalProvider(provider)
    if (!m.has(canon)) m.set(canon, entry)
  }
  for (const r of (agentCreds.data ?? []) as any[]) setOnce(r.brokerage_id, r.service_name, { isActive: !!r.is_active, tokenExpiresAt: r.token_expires_at ?? null })
  for (const r of (platCreds.data ?? []) as any[]) setOnce(r.brokerage_id, r.platform, { isActive: !!r.is_active, tokenExpiresAt: r.token_expires_at ?? null })
  for (const r of (intCreds.data ?? []) as any[]) setOnce(r.brokerage_id, r.provider_name, { isActive: !!r.is_active, tokenExpiresAt: null })
  const connections: ConnectionExpiryFact[] = []
  for (const [brokerageId, creds] of byTenantCreds) {
    for (const [provider, entry] of creds) {
      const transport = entry.tokenExpiresAt ? ("oauth" as const) : transportFor(provider)
      const status = deriveConnectivityStatus(
        { connected: entry.isActive, transport, isActive: entry.isActive, tokenExpiresAt: entry.tokenExpiresAt },
        now,
      )
      if (status === "expired" || status === "expiring_soon") {
        connections.push({
          brokerageId,
          brokerageName: nameOf.get(brokerageId) ?? "(unnamed)",
          provider,
          status,
          expiresAt: entry.tokenExpiresAt,
        })
      }
    }
  }

  // ── Dunning: ladder steps recorded in the last 14 days ─────────────────────
  const dunningSince = new Date(now.getTime() - 14 * DAY_MS).toISOString()
  const { data: dunningEvents } = await svc
    .from("platform_dunning_events")
    .select("brokerage_id, step, created_at")
    .gte("created_at", dunningSince)
    .limit(1000)
  const dunning = ((dunningEvents ?? []) as any[])
    .filter((e) => e.brokerage_id && tenantIds.has(e.brokerage_id))
    .map((e) => ({
      brokerageId: e.brokerage_id as string,
      brokerageName: nameOf.get(e.brokerage_id) ?? "(unnamed)",
      step: Number(e.step) || 0,
      occurredAt: e.created_at as string,
    }))

  // ── Support SLA: the support console's own pure clock over open tickets ────
  const { data: tickets } = await svc
    .from("support_tickets")
    .select("id, subject, brokerage_id, created_at, priority, status, first_response_at, resolved_at")
    .in("status", ["open", "in_progress"])
    .limit(500)
  const slaBreaches = ((tickets ?? []) as any[])
    .map((t) => ({ t, sla: evaluateTicketSla(t, now) }))
    .filter(({ sla }) => sla.breaches.length > 0)
    .map(({ t, sla }) => ({
      brokerageId: (t.brokerage_id as string | null) ?? null,
      brokerageName: t.brokerage_id ? nameOf.get(t.brokerage_id) ?? null : null,
      ticketId: t.id as string,
      subject: (t.subject as string | null) ?? null,
      priority: (t.priority as string | null) ?? null,
      ageHours: sla.ageHours,
      kinds: sla.breaches,
    }))

  // ── Trials: reconciled trial end, expiring within a week ───────────────────
  const { data: subs } = await svc
    .from("subscriptions")
    .select("brokerage_id, trial_end")
    .limit(2000)
  const subTrialEnd = new Map<string, string>()
  for (const s of (subs ?? []) as any[]) {
    if (s.brokerage_id && s.trial_end) subTrialEnd.set(s.brokerage_id, s.trial_end)
  }
  const trials = tenants.flatMap((t) => {
    const end = subTrialEnd.get(t.id) ?? t.trial_ends_at
    if (!end) return []
    const endMs = new Date(end).getTime()
    if (!Number.isFinite(endMs)) return []
    const daysLeft = Math.floor((endMs - now.getTime()) / DAY_MS)
    if (daysLeft < 0 || daysLeft > 7) return []
    return [{
      brokerageId: t.id,
      brokerageName: nameOf.get(t.id) ?? "(unnamed)",
      trialEndsAt: end,
      daysLeft,
    }]
  })

  return { engagement, connections, dunning, slaBreaches, trials }
}
