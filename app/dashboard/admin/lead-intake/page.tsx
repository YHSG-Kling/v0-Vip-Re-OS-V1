import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { loadLeadIntakeCockpit, REJECTION_REASON_LABEL } from "@/lib/kernel/lead-intake-cockpit"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const metadata = {
  title: "Lead Intake Cockpit | Kernel OS",
  description:
    "The Data Steward's command surface over the front of the lifecycle — the live raw → gate → leads (AI ISA) → contact funnel, gate rejections + why, per-source conversion, and the hot seller-intent leads the AI ISA is holding.",
}

const pct = (r: number) => `${Math.round(r * 100)}%`

/**
 * Lead Intake Cockpit — the Data Steward's read-only command surface over the FRONT of
 * the lifecycle. Mirrors the content-studio / campaign-center pattern (auth/role gate →
 * server component → loadX kernel aggregation → Card/Badge). Shows the funnel stage cards
 * (pending / promoted / rejected / error + conversions), the per-source conversion table
 * (raw→lead, lead→contact), the rejection-reasons breakdown (WHY the gate stopped rows),
 * and the hot seller-intent list (AI-ISA-owned, non-contact leads the Listing Inventory
 * Radar surfaced). All data via loadLeadIntakeCockpit(); no writes, no placeholder data.
 */
export default async function LeadIntakeCockpitPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  const userType = u?.user_type ?? "agent"
  const brokerageId = u?.brokerage_id ?? undefined
  if (!["admin", "broker", "superadmin"].includes(userType) || !brokerageId) redirect("/dashboard")

  const data = await loadLeadIntakeCockpit(brokerageId)
  const { funnel } = data

  const stageCards: Array<{ label: string; value: number; hint?: string }> = [
    { label: "Raw scraped", value: funnel.rawTotal, hint: "all rows on the bench" },
    { label: "Pending in gate", value: funnel.pending, hint: "enriching / queued" },
    { label: "Promoted → leads", value: funnel.promoted, hint: `${pct(data.overallRawToLead)} raw→lead` },
    { label: "Gate-rejected", value: funnel.rejected, hint: "blocked before promotion" },
    { label: "Errors", value: funnel.error },
    { label: "Converted → contacts", value: data.convertedTotal, hint: `${pct(data.overallLeadToContact)} lead→contact` },
  ]

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Lead Intake Cockpit</h1>
        <span className="text-sm text-muted-foreground">
          {funnel.rawTotal} raw · {funnel.promoted} promoted · {data.convertedTotal} converted
        </span>
      </div>

      {funnel.rawTotal === 0 && data.leadTotal === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">
          No intake yet — this fills as the scraper bench lands raw_scraped_leads and the gate (enrich + dedup +
          territory/identity guards) promotes them to leads. Honest zeros until then.
        </Card>
      ) : (
        <>
          {/* ── Funnel stage cards ──────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            {stageCards.map((c) => (
              <Card key={c.label} className="p-3">
                <div className="text-2xl font-semibold tabular-nums">{c.value}</div>
                <div className="text-xs font-medium">{c.label}</div>
                {c.hint && <div className="text-[11px] text-muted-foreground mt-0.5">{c.hint}</div>}
              </Card>
            ))}
          </div>

          {/* ── Per-source conversion table ─────────────────────────────────── */}
          <Card className="p-4">
            <div className="text-xs font-medium mb-2">Conversion by source</div>
            {data.bySource.length === 0 ? (
              <div className="text-sm text-muted-foreground">No sources yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b">
                      <th className="py-1.5 pr-3 font-medium">Source</th>
                      <th className="py-1.5 px-3 font-medium text-right">Raw</th>
                      <th className="py-1.5 px-3 font-medium text-right">Promoted</th>
                      <th className="py-1.5 px-3 font-medium text-right">raw→lead</th>
                      <th className="py-1.5 px-3 font-medium text-right">Leads</th>
                      <th className="py-1.5 px-3 font-medium text-right">Converted</th>
                      <th className="py-1.5 pl-3 font-medium text-right">lead→contact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bySource.map((s) => (
                      <tr key={s.source} className="border-b last:border-0">
                        <td className="py-1.5 pr-3 truncate max-w-[14rem]">{s.source}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums">{s.rawCount}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums">{s.promotedCount}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums">{pct(s.rawToLeadRate)}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums">{s.leadCount}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums">{s.convertedCount}</td>
                        <td className="py-1.5 pl-3 text-right tabular-nums">{pct(s.leadToContactRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* ── Rejection reasons (WHY the gate stopped rows) ───────────────── */}
          <Card className="p-4">
            <div className="text-xs font-medium mb-2">
              Gate rejections · {funnel.rejected}
            </div>
            {Object.keys(funnel.rejectionsByReason).length === 0 ? (
              <div className="text-sm text-muted-foreground">No rejections — every gated row passed or is still in flight.</div>
            ) : (
              <div className="space-y-1.5">
                {Object.entries(funnel.rejectionsByReason)
                  .sort((a, b) => b[1] - a[1])
                  .map(([status, n]) => (
                    <div key={status} className="flex items-center justify-between gap-3">
                      <div className="text-sm">{REJECTION_REASON_LABEL[status] ?? status}</div>
                      <Badge variant="secondary" className="tabular-nums shrink-0">
                        {n}
                      </Badge>
                    </div>
                  ))}
              </div>
            )}
          </Card>

          {/* ── Hot seller-intent leads (AI-ISA-owned, non-contact) ─────────── */}
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              Hot seller-intent with AI ISA · {data.hotIntent.length}
            </div>
            {data.hotIntent.length === 0 ? (
              <Card className="p-4 text-sm text-muted-foreground">
                Nothing hot right now — the Listing Inventory Radar stamps the AI-ISA-owned leads it surfaces; this fills
                as the bench finds seller-intent inventory.
              </Card>
            ) : (
              <div className="grid gap-2">
                {data.hotIntent.map((lead) => (
                  <Card key={lead.leadId} className="p-3 space-y-1.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">
                          {lead.summary ?? "Seller-intent candidate"}
                        </div>
                        {lead.source && (
                          <div className="text-xs text-muted-foreground">source: {lead.source}</div>
                        )}
                      </div>
                      <Badge className="shrink-0 tabular-nums">intent {lead.leadScore}/100</Badge>
                    </div>
                    {lead.reasons.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {lead.reasons.map((r, i) => (
                          <Badge key={i} variant="outline" className="text-[11px]">
                            {r}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
