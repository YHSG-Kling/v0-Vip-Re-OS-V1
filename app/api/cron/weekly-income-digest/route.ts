/**
 * /api/cron/weekly-income-digest
 *
 * Monday-morning ritual: for every active agent across every brokerage, run
 * the Income Truth engine (computeAndPersistGapAction) and email the agent
 * their forecast, gap to goal, and the 5 ranked actions for the week.
 *
 * Composition:
 *   - app/actions/income-engine.ts:computeAndPersistGapAction — persists
 *     income_forecast_gap_analysis + income_gap_recommended_actions rows.
 *   - lib/providers/messaging:sendEmail — routes through the agent's personal
 *     mailbox (Gmail/Outlook OAuth) when connected, otherwise the brokerage's
 *     configured sender. Per-user cascade.
 *
 * Compliance:
 *   - We only email agents (internal users) — not contacts — so the kernel
 *     TCPA / consent gates do not apply here. Email is to the agent's own
 *     mailbox on file in users.email.
 *
 * Failure handling:
 *   - One agent failure does NOT abort the whole run. We accumulate per-agent
 *     results and surface counts in cron_health_snapshot.
 *
 * Schedule: every Monday 13:00 UTC (9am ET / 6am PT) via vercel.json.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { computeAndPersistGapAction } from "@/app/actions/income-engine"
import { sendEmail } from "@/lib/providers/messaging"

export const dynamic = "force-dynamic"
export const maxDuration = 600   // 10 minutes — many agents possible

const CATEGORY_LABELS: Record<string, string> = {
  prospecting:         "Prospecting",
  listing_acquisition: "Win listings",
  referral_ask:        "Referral ask",
  conversion_focus:    "Convert pipeline",
  reactivation:        "Re-engage",
  negotiation_close:   "Close deal",
  pricing_correction:  "Price correction",
  sphere_nurture:      "Sphere nurture",
  open_house:          "Open house",
  marketing_push:      "Marketing push",
}

function fmtCents(c: number | null | undefined): string {
  if (c === null || c === undefined) return "—"
  return `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

interface AgentDigestRow {
  agent_id:      string
  user_id:       string
  email:         string
  first_name:    string | null
  brokerage_id:  string
  brokerage_name: string | null
}

function buildDigestHtml(params: {
  agentFirstName: string | null
  brokerageName:  string | null
  ytdCents:       number
  goalCents:      number | null
  projectedYearEndCents: number
  gapCents:       number | null
  gapPct:         number | null
  weighted30:     number
  weighted90:     number
  weighted180:    number
  actions:        Array<{
    rank: number
    title: string
    description: string | null
    category: string
    impactCents: number
    effortHours: number
    dueBy:       string | null
  }>
}): string {
  const isBehind = params.gapCents !== null && params.gapCents > 0
  const isAhead  = params.gapCents !== null && params.gapCents <= 0
  const gapLine  = params.gapCents === null
    ? `<p style="color:#64748b;">Set an annual GCI goal in your profile to track gap to target.</p>`
    : isBehind
    ? `<p style="color:#b91c1c;font-size:18px;"><strong>You're behind by ${fmtCents(params.gapCents)}</strong> (${Math.abs(Number(params.gapPct))}%).</p>`
    : `<p style="color:#15803d;font-size:18px;"><strong>You're ahead by ${fmtCents(-Number(params.gapCents))}</strong> (${Math.abs(Number(params.gapPct))}%).</p>`

  const actionsHtml = params.actions.length === 0
    ? `<p style="color:#64748b;">No specific actions surfaced this week. Add contacts and listings to your pipeline to generate recommendations.</p>`
    : `<table style="width:100%;border-collapse:collapse;margin-top:12px;">
         ${params.actions.map(a => `
           <tr>
             <td style="vertical-align:top;padding:12px 8px;border-bottom:1px solid #e2e8f0;width:30px;font-weight:bold;color:#1e40af;">#${a.rank}</td>
             <td style="vertical-align:top;padding:12px 8px;border-bottom:1px solid #e2e8f0;">
               <div style="font-weight:600;font-size:14px;">${a.title}</div>
               <div style="color:#64748b;font-size:12px;margin-top:4px;">
                 <span style="background:#e0f2fe;color:#075985;padding:2px 6px;border-radius:4px;margin-right:6px;">${CATEGORY_LABELS[a.category] ?? a.category}</span>
                 ${a.description ?? ""}
               </div>
               <div style="font-size:12px;margin-top:6px;">
                 <span style="color:#15803d;font-weight:600;">+${fmtCents(a.impactCents)} expected</span>
                 <span style="color:#64748b;margin-left:12px;">${a.effortHours}h effort</span>
                 ${a.dueBy ? `<span style="color:#b45309;margin-left:12px;">Due ${new Date(a.dueBy).toLocaleDateString()}</span>` : ""}
               </div>
             </td>
           </tr>
         `).join("")}
       </table>`

  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:680px;margin:0 auto;padding:24px;">
    <h1 style="font-size:22px;margin:0 0 8px 0;">Monday morning ${params.agentFirstName ? `, ${params.agentFirstName}` : ""}</h1>
    <p style="color:#64748b;margin:0 0 24px 0;">Your Income Truth weekly digest from ${params.brokerageName ?? "your brokerage"}.</p>

    ${gapLine}

    <div style="display:flex;gap:16px;margin:24px 0;flex-wrap:wrap;">
      <div style="flex:1;min-width:140px;padding:12px;background:#f8fafc;border-radius:8px;">
        <div style="color:#64748b;font-size:11px;text-transform:uppercase;">YTD GCI</div>
        <div style="font-size:20px;font-weight:bold;">${fmtCents(params.ytdCents)}</div>
      </div>
      <div style="flex:1;min-width:140px;padding:12px;background:#f8fafc;border-radius:8px;">
        <div style="color:#64748b;font-size:11px;text-transform:uppercase;">Annual goal</div>
        <div style="font-size:20px;font-weight:bold;">${fmtCents(params.goalCents)}</div>
      </div>
      <div style="flex:1;min-width:140px;padding:12px;background:#f8fafc;border-radius:8px;">
        <div style="color:#64748b;font-size:11px;text-transform:uppercase;">Projected year-end</div>
        <div style="font-size:20px;font-weight:bold;">${fmtCents(params.projectedYearEndCents)}</div>
      </div>
    </div>

    <h2 style="font-size:16px;margin:24px 0 4px 0;">Pipeline forecast</h2>
    <div style="color:#475569;font-size:13px;">
      <strong>30d:</strong> ${fmtCents(params.weighted30)}
      &nbsp;·&nbsp;
      <strong>90d:</strong> ${fmtCents(params.weighted90)}
      &nbsp;·&nbsp;
      <strong>180d (incl. sphere):</strong> ${fmtCents(params.weighted180)}
    </div>

    <h2 style="font-size:16px;margin:24px 0 4px 0;">Your ${params.actions.length} actions for this week</h2>
    ${actionsHtml}

    <p style="margin-top:32px;font-size:12px;color:#94a3b8;">
      View full details + diagnostics at
      <a href="${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard/income-truth" style="color:#2563eb;">/dashboard/income-truth</a>.
      This is your weekly Income Truth digest — every Monday at 9am ET.
    </p>
  </body></html>`
}

export async function GET(request: NextRequest) {
  // CRON_SECRET auth
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await createCronRunContextAction({
    cron_name: "weekly-income-digest",
    cron_path: "/app/api/cron/weekly-income-digest/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  let agentsProcessed = 0
  let digestsSent     = 0
  let digestsSkipped  = 0
  let errors          = 0
  const errorSamples: string[] = []

  try {
    const svc = createServiceClient()

    // Pull every active agent with a usable email and an associated user row.
    const { data: agents, error: agentsErr } = await svc
      .from("agents")
      .select(`
        id, user_id, brokerage_id, is_active,
        user:users!inner ( email, first_name ),
        brokerage:brokerages!inner ( name )
      `)
      .eq("is_active", true)
      .limit(5000)

    if (agentsErr) throw new Error(`agents query failed: ${agentsErr.message}`)

    const rows: AgentDigestRow[] = (agents ?? []).map((a: any) => {
      const u = Array.isArray(a.user)       ? a.user[0]       : a.user
      const b = Array.isArray(a.brokerage)  ? a.brokerage[0]  : a.brokerage
      return {
        agent_id:       a.id,
        user_id:        a.user_id,
        email:          u?.email,
        first_name:     u?.first_name ?? null,
        brokerage_id:   a.brokerage_id,
        brokerage_name: b?.name ?? null,
      }
    }).filter(r => r.email && r.brokerage_id)

    for (const row of rows) {
      agentsProcessed++
      try {
        // 1. Compute + persist gap analysis
        const result = await computeAndPersistGapAction({
          agentId:     row.agent_id,
          brokerageId: row.brokerage_id,
        })
        if (!result.ok) {
          errors++
          if (errorSamples.length < 5) errorSamples.push(`${row.email}: ${result.error}`)
          continue
        }

        // 2. Skip if no goal AND no actions — nothing useful to send
        const g = result.result
        if (g.annual_goal_cents === null && g.actions.length === 0) {
          digestsSkipped++
          continue
        }

        // 3. Build digest HTML
        const html = buildDigestHtml({
          agentFirstName:        row.first_name,
          brokerageName:         row.brokerage_name,
          ytdCents:              g.ytd_gci_cents,
          goalCents:             g.annual_goal_cents,
          projectedYearEndCents: g.projected_year_end_cents,
          gapCents:              g.gap_to_goal_cents,
          gapPct:                g.gap_to_goal_pct,
          weighted30:            g.weighted_30_cents,
          weighted90:            g.weighted_90_cents,
          weighted180:           g.weighted_180_cents,
          actions: g.actions.map(a => ({
            rank:        a.action_rank,
            title:       a.action_title,
            description: a.action_description,
            category:    a.action_category,
            impactCents: a.estimated_gci_impact_cents,
            effortHours: a.estimated_effort_hours,
            dueBy:       a.due_by,
          })),
        })

        // 4. Send via per-user email cascade (personal Gmail/Outlook → brokerage SendGrid)
        const send = await sendEmail({
          to:          row.email,
          subject:     `Your Income Truth digest — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
          html,
          agentUserId: row.user_id,
        })
        if (send.success) {
          digestsSent++
        } else {
          errors++
          if (errorSamples.length < 5) errorSamples.push(`${row.email}: ${send.error}`)
        }
      } catch (err: any) {
        errors++
        if (errorSamples.length < 5) errorSamples.push(`${row.email}: ${err?.message ?? "exception"}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: agentsProcessed,
      metadata: {
        digests_sent:     digestsSent,
        digests_skipped:  digestsSkipped,
        errors,
        error_samples:    errorSamples,
      },
    })

    return NextResponse.json({
      ok: true,
      agents_processed: agentsProcessed,
      digests_sent:     digestsSent,
      digests_skipped:  digestsSkipped,
      errors,
      error_samples:    errorSamples,
    })
  } catch (err: any) {
    await recordCronFailureAction({
      context_id: contextId,
      error: err?.message ?? "unknown",
      context_snapshot: { agents_processed: agentsProcessed },
    })
    return NextResponse.json(
      { ok: false, error: err?.message ?? "unknown", agents_processed: agentsProcessed },
      { status: 500 },
    )
  }
}
