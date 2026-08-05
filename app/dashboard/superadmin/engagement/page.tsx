import Link from "next/link"
import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import {
  classifyEngagement,
  daysSinceActivity,
  DAY_MS,
  TIER_ORDER,
  type EngagementTier,
} from "@/lib/platform/engagement-risk"
import {
  lastNPeriods,
  rollupNpsByPeriod,
  classifyNps,
  NPS_DETRACTOR_MAX_SCORE,
  type NpsRollupByPeriod,
} from "@/lib/platform/nps"

export const dynamic = "force-dynamic"

// TENANT ENGAGEMENT / CHURN-RISK RADAR — the behavioral signal the money views
// miss. PLATFORM-GLOBAL READ by design (tenants-gated, service client).
//
// ACTIVITY SOURCE (investigated before building): public.users has NO
// last_sign_in_at column (verified against scripts/schema-snapshot.ts; the
// ai-chat superadmin context notes the same). The candidates that DO exist:
//   • auth.users.last_sign_in_at — Supabase Auth's own sign-in stamp, read via
//     svc.auth.admin.listUsers() (the same admin API lib/kernel/users.ts already
//     uses) and joined to tenants through public.users.brokerage_id — users.id
//     IS the auth uid (require-capability queries users by auth uid).  ← CHOSEN
//   • user_activity — rejected: no brokerage_id, and it is not login evidence.
//     Its one remaining writer is services/supabaseService.ts:logUserActivity,
//     which inserts whatever caller-supplied row it is handed and is not tied to
//     sign-in at all. (The writer this note originally cited,
//     services/workflowService.ts, logged user_id 'system' and has since been
//     deleted — see lib/migration-status.ts.)
//   • audit_log — rejected: no brokerage_id; sparse writers.
// So "last sign-in" and "active users 7/30d" below are exactly what Supabase
// Auth recorded — real logins, nothing synthesized. (Note: last_sign_in_at
// keeps only each user's NEWEST sign-in, which is precisely what an
// active-within-N-days count needs.)
//
// VELOCITY: core-object creation (contacts / listings / transactions) last 30d
// vs the prior 30d — two head-only counts per table per tenant, brokerage_id-
// anchored, run in small chunks so N tenants never fan out unbounded.

const CORE_TABLES = ["contacts", "listings", "transactions"] as const

function fmtAgo(iso: string | null) {
  if (!iso) return "never"
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

function fmtPeriod(period: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(period)
  if (!m) return period
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
}

const NPS_BUCKET_BADGE: Record<ReturnType<typeof classifyNps>, string> = {
  detractor: "bg-red-100 text-red-800",
  passive: "bg-slate-100 text-slate-700",
  promoter: "bg-emerald-100 text-emerald-800",
}

const TIER_BADGE: Record<EngagementTier, { label: string; cls: string }> = {
  at_risk: { label: "at risk", cls: "bg-red-100 text-red-800" },
  cooling: { label: "cooling", cls: "bg-amber-100 text-amber-800" },
  engaged: { label: "engaged", cls: "bg-emerald-100 text-emerald-800" },
}

export default async function SuperadminEngagementPage() {
  const gate = await requirePlatformCapability("tenants")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const svc = createServiceClient()
  const now = new Date()
  const since30 = new Date(now.getTime() - 30 * DAY_MS).toISOString()
  const since60 = new Date(now.getTime() - 60 * DAY_MS).toISOString()

  const { data: brokerages, error: brkError } = await svc
    .from("brokerages")
    .select("id, name, plan_tier, created_at")
    .is("deleted_at", null)
    .order("name")
  if (brkError) return <div className="p-6 text-red-600">Failed to load tenants: {brkError.message}</div>
  const tenants = (brokerages ?? []) as any[]

  // 1) Sign-in evidence: auth.users.last_sign_in_at via the admin API (paged).
  const lastSignInByAuthId = new Map<string, string>()
  for (let page = 1; page <= 20; page++) {
    const { data: authPage, error: authError } = await svc.auth.admin.listUsers({ page, perPage: 1000 })
    if (authError) return <div className="p-6 text-red-600">Failed to read auth sign-ins: {authError.message}</div>
    for (const u of authPage.users) {
      if (u.last_sign_in_at) lastSignInByAuthId.set(u.id, u.last_sign_in_at)
    }
    if (authPage.users.length < 1000) break
  }

  // 2) Tenant membership: public.users.brokerage_id (users.id = auth uid).
  //    Contact portal logins (is_contact) are excluded — this radar measures the
  //    subscriber's own team, not their clients. Paged for >1000 rows.
  const tenantUsers: { id: string; brokerage_id: string }[] = []
  for (let from = 0; ; from += 1000) {
    const { data: userPage, error: usersError } = await svc
      .from("users")
      .select("id, brokerage_id, is_contact")
      .not("brokerage_id", "is", null)
      .is("deleted_at", null)
      .order("id")
      .range(from, from + 999)
    if (usersError) return <div className="p-6 text-red-600">Failed to load tenant users: {usersError.message}</div>
    for (const u of (userPage ?? []) as any[]) {
      if (u.is_contact !== true) tenantUsers.push({ id: u.id, brokerage_id: u.brokerage_id })
    }
    if ((userPage ?? []).length < 1000) break
  }

  const signInAgg = new Map<string, { users: number; last: string | null; active7: number; active30: number }>()
  for (const b of tenants) signInAgg.set(b.id, { users: 0, last: null, active7: 0, active30: 0 })
  for (const u of tenantUsers) {
    const agg = signInAgg.get(u.brokerage_id)
    if (!agg) continue // user of a deleted tenant
    agg.users += 1
    const last = lastSignInByAuthId.get(u.id) ?? null
    if (!last) continue
    if (!agg.last || last > agg.last) agg.last = last
    const days = daysSinceActivity(last, now)
    if (days <= 7) agg.active7 += 1
    if (days <= 30) agg.active30 += 1
  }

  // 3) Creation velocity: two head-counts per core table per tenant, chunked.
  const velocity = new Map<string, { cur: number; prior: number; detail: string }>()
  const CHUNK = 8
  for (let i = 0; i < tenants.length; i += CHUNK) {
    const chunk = tenants.slice(i, i + CHUNK)
    const results = await Promise.all(
      chunk.flatMap((b: any) =>
        CORE_TABLES.map(async (table) => {
          const [cur, prior] = await Promise.all([
            svc.from(table).select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).gte("created_at", since30),
            svc.from(table).select("id", { count: "exact", head: true }).eq("brokerage_id", b.id).gte("created_at", since60).lt("created_at", since30),
          ])
          return { brokerageId: b.id as string, table, cur, prior }
        })
      )
    )
    for (const r of results) {
      const err = r.cur.error ?? r.prior.error
      if (err) return <div className="p-6 text-red-600">Failed to count {r.table}: {err.message}</div>
      const agg = velocity.get(r.brokerageId) ?? { cur: 0, prior: 0, detail: "" }
      agg.cur += r.cur.count ?? 0
      agg.prior += r.prior.count ?? 0
      agg.detail += `${agg.detail ? " · " : ""}${r.table}: ${r.cur.count ?? 0} (prior ${r.prior.count ?? 0})`
      velocity.set(r.brokerageId, agg)
    }
  }

  const rows = tenants.map((b: any) => {
    const signIns = signInAgg.get(b.id) ?? { users: 0, last: null, active7: 0, active30: 0 }
    const vel = velocity.get(b.id) ?? { cur: 0, prior: 0, detail: "" }
    const tier = classifyEngagement(
      { lastActivityAt: signIns.last, createsLast30d: vel.cur, createsPrior30d: vel.prior },
      now
    )
    return {
      id: b.id as string,
      name: (b.name as string) ?? "(unnamed)",
      planTier: (b.plan_tier as string) ?? "—",
      users: signIns.users,
      lastSignIn: signIns.last,
      active7: signIns.active7,
      active30: signIns.active30,
      creates30: vel.cur,
      createsPrior: vel.prior,
      velocityDetail: vel.detail,
      tier,
    }
  })
  // Riskiest first; within a tier, the longest-silent tenant leads.
  rows.sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      daysSinceActivity(b.lastSignIn, now) - daysSinceActivity(a.lastSignIn, now) ||
      a.name.localeCompare(b.name)
  )

  // ── Tenant→platform NPS rollup (platform_nps_responses, last 6 periods) ────
  // Same ledger the tenant survey card writes and the sentinel's detractor
  // feed reads. A read failure degrades to an inline error, not a dead page.
  const npsPeriods = lastNPeriods(6, now)
  let nps: NpsRollupByPeriod | null = null
  let npsError: string | null = null
  try {
    nps = await rollupNpsByPeriod(npsPeriods)
  } catch (e) {
    npsError = e instanceof Error ? e.message : "Failed to load NPS responses"
  }
  const tenantName = new Map<string, string>(tenants.map((b: any) => [b.id as string, (b.name as string) ?? "(unnamed)"]))
  const npsVerbatims = (nps?.responses ?? []).filter((r) => (r.verbatim ?? "").trim().length > 0).slice(0, 8)
  const npsDetractors = (nps?.responses ?? []).filter((r) => r.score <= NPS_DETRACTOR_MAX_SCORE).slice(0, 10)

  const atRiskCount = rows.filter((r) => r.tier === "at_risk").length
  const coolingCount = rows.filter((r) => r.tier === "cooling").length
  const engagedCount = rows.filter((r) => r.tier === "engaged").length

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Engagement radar — every tenant</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Churn risk from behavior, not billing: real sign-ins (Supabase Auth), active team members over
            7/30 days, and core-object creation velocity (30d vs prior 30d). Riskiest tenants first.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/home" className="rounded-md border px-3 py-1 text-sm">Home</Link>
          <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
        </div>
      </div>

      {/* Tier counts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{atRiskCount}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-100 text-red-800">At risk</div>
          <div className="text-[11px] text-muted-foreground mt-1">No sign-in in over 14 days</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{coolingCount}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-800">Cooling</div>
          <div className="text-[11px] text-muted-foreground mt-1">Quiet 7–14 days, or output halved</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{engagedCount}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-800">Engaged</div>
          <div className="text-[11px] text-muted-foreground mt-1">Signed in this week, velocity holding</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{rows.length}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-700">Tenants</div>
        </div>
      </div>

      {/* Every tenant, riskiest first */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">All tenants ({rows.length})</h2>
        {rows.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">No tenants yet.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Tenant</th>
                  <th className="p-2">Risk</th>
                  <th className="p-2">Last sign-in</th>
                  <th className="p-2 text-right">Active 7d</th>
                  <th className="p-2 text-right">Active 30d</th>
                  <th className="p-2 text-right">Team</th>
                  <th className="p-2 text-right">Created 30d</th>
                  <th className="p-2 text-right">Prior 30d</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-2">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-[11px] text-muted-foreground">{r.planTier}</div>
                    </td>
                    <td className="p-2">
                      <span className={"rounded px-1.5 py-0.5 text-[11px] font-semibold " + TIER_BADGE[r.tier].cls}>
                        {TIER_BADGE[r.tier].label}
                      </span>
                    </td>
                    <td className="p-2 text-xs text-muted-foreground" title={r.lastSignIn ?? undefined}>
                      {fmtAgo(r.lastSignIn)}
                    </td>
                    <td className="p-2 text-right tabular-nums">{r.active7}</td>
                    <td className="p-2 text-right tabular-nums">{r.active30}</td>
                    <td className="p-2 text-right tabular-nums text-muted-foreground">{r.users}</td>
                    <td className="p-2 text-right tabular-nums" title={r.velocityDetail || undefined}>{r.creates30}</td>
                    <td className="p-2 text-right tabular-nums text-muted-foreground" title={r.velocityDetail || undefined}>
                      {r.createsPrior}
                      {r.createsPrior > 0 && r.creates30 * 2 <= r.createsPrior && (
                        <span className="ml-1 rounded px-1 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-800">halved</span>
                      )}
                    </td>
                    <td className="p-2 text-right">
                      <Link href={`/dashboard/superadmin/brokerages/${r.id}`} className="text-xs font-medium text-indigo-600">Manage →</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Tenant→platform NPS — the voice-of-subscriber signal next to the
          behavior signal. Fed by the once-a-quarter survey card on the tenant
          dashboard; detractors here also flow into the platform sentinel as
          engagement_risk proposals with a drafted check-in. */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Tenant NPS</h2>
          <p className="text-xs text-muted-foreground">
            "How likely are you to recommend us?" — every tenant user, at most once a quarter.
            NPS = % promoters (9–10) − % detractors (0–6); n is the sample behind each score.
          </p>
        </div>

        {npsError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            Failed to load NPS responses: {npsError}
          </div>
        ) : !nps || nps.responses.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            No NPS responses yet. Tenant users are prompted on their dashboard once per quarter,
            after 30 days of tenancy — scores land here as they answer.
          </div>
        ) : (
          <>
            {/* Score by period, last 6 (oldest → newest) */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
              {[...nps.platform].reverse().map((p) => (
                <div key={p.period} className="rounded-lg border p-3">
                  <div className="text-[11px] text-muted-foreground">{fmtPeriod(p.period)}</div>
                  <div className="text-2xl font-bold tabular-nums">
                    {p.nps === null ? "—" : p.nps > 0 ? `+${p.nps}` : p.nps}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    n={p.sample}
                    {p.sample > 0 && (
                      <span className="ml-1">
                        ({p.promoters}P / {p.passives}N / {p.detractors}D)
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {/* Recent verbatims */}
              <div className="rounded-lg border">
                <div className="border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
                  Recent verbatims ({npsVerbatims.length})
                </div>
                {npsVerbatims.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    No written feedback yet — scores only so far.
                  </div>
                ) : (
                  <ul className="divide-y">
                    {npsVerbatims.map((r) => (
                      <li key={r.id} className="p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium truncate">
                            {r.brokerageId ? tenantName.get(r.brokerageId) ?? "(unknown tenant)" : "(unknown tenant)"}
                          </span>
                          <span
                            className={
                              "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums " +
                              NPS_BUCKET_BADGE[classifyNps(r.score)]
                            }
                          >
                            {r.score}/10
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">&ldquo;{r.verbatim}&rdquo;</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {fmtPeriod(r.period)} · {fmtAgo(r.createdAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Detractor list */}
              <div className="rounded-lg border">
                <div className="border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
                  Detractors — score ≤ {NPS_DETRACTOR_MAX_SCORE} ({npsDetractors.length})
                </div>
                {npsDetractors.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    No detractors in the last 6 periods.
                  </div>
                ) : (
                  <ul className="divide-y">
                    {npsDetractors.map((r) => (
                      <li key={r.id} className="p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium truncate">
                            {r.brokerageId ? tenantName.get(r.brokerageId) ?? "(unknown tenant)" : "(unknown tenant)"}
                          </span>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums bg-red-100 text-red-800">
                              {r.score}/10
                            </span>
                            {r.brokerageId && (
                              <Link
                                href={`/dashboard/superadmin/brokerages/${r.brokerageId}`}
                                className="text-xs font-medium text-indigo-600"
                              >
                                Manage →
                              </Link>
                            )}
                          </div>
                        </div>
                        {r.verbatim && <p className="mt-1 text-xs text-muted-foreground">&ldquo;{r.verbatim}&rdquo;</p>}
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {fmtPeriod(r.period)} · {fmtAgo(r.createdAt)} · flows into the platform sentinel as an
                          engagement-risk check-in draft
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
