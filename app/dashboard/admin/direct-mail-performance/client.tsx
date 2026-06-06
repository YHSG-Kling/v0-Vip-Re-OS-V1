"use client"

import type {
  ChannelOverview,
  VariantArmRow,
  RecentCampaignRow,
  GeoHeatmapRow,
} from "@/app/actions/direct-mail-performance"

export interface DirectMailPerformanceClientProps {
  overview:        ChannelOverview
  topVariants:     VariantArmRow[]
  recentCampaigns: RecentCampaignRow[]
  geoHeatmap:      GeoHeatmapRow[]
}

export function DirectMailPerformanceClient(props: DirectMailPerformanceClientProps) {
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Direct Mail Performance</h1>
        <p className="text-gray-600 mt-2">
          Channel state for the last 28 days. Variant arms come from the
          Thompson-sampling bandit; the daily aggregator updates scan counts
          at 08:30 UTC.
        </p>
      </header>

      <OverviewSection overview={props.overview} />
      <TopVariantsSection topVariants={props.topVariants} />
      <GeoHeatmapSection rows={props.geoHeatmap} />
      <RecentCampaignsSection rows={props.recentCampaigns} />
    </div>
  )
}

function GeoHeatmapSection({ rows }: { rows: GeoHeatmapRow[] }) {
  // Render scan intensity as a horizontal bar relative to the top zip,
  // keyed off scans_count so the leader is fully filled and others
  // visually scale. v1 surface; SVG/Leaflet map can layer on the same
  // data shape later.
  const maxScans = rows.length > 0 ? Math.max(...rows.map((r) => r.scans_count), 1) : 1

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-3">Geo heatmap (last 28 days, by zip)</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 italic">
          No geo data yet. Once farm-mail or lifecycle postcards mail to contacts with verified zips, this lights up.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left">
                <th className="py-2 px-3 font-semibold text-gray-700">Zip</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">Sends</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">Scans</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">Leads</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">Scan%</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">Lead%</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">CPL</th>
                <th className="py-2 px-3 font-semibold text-gray-700 w-1/3">Scan intensity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pct = Math.round((r.scans_count / maxScans) * 100)
                return (
                  <tr key={r.zip} className="border-b border-gray-100">
                    <td className="py-1.5 px-3 font-mono font-medium text-gray-900">{r.zip}</td>
                    <td className="py-1.5 px-3 text-right text-gray-700">{r.sends_count}</td>
                    <td className="py-1.5 px-3 text-right text-gray-700">{r.scans_count}</td>
                    <td className="py-1.5 px-3 text-right font-medium text-green-700">{r.leads_count}</td>
                    <td className="py-1.5 px-3 text-right text-gray-700">{(r.scan_rate * 100).toFixed(1)}%</td>
                    <td className="py-1.5 px-3 text-right font-medium text-gray-900">{(r.lead_rate * 100).toFixed(1)}%</td>
                    <td className="py-1.5 px-3 text-right text-gray-700">{r.cost_per_lead == null ? "—" : `$${r.cost_per_lead.toFixed(2)}`}</td>
                    <td className="py-1.5 px-3">
                      <div className="h-2 bg-gray-100 rounded overflow-hidden">
                        <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="text-xs text-gray-500 mt-2">
            Sorted by leads desc → scans desc. Zips with high scan%/lead% are
            the farm targets where the omnipresence agent should fanout more
            topics; zips with high spend + low scans are candidates for
            cancel_direct_mail_send or design retry.
          </p>
        </div>
      )}
    </section>
  )
}

function OverviewSection({ overview }: { overview: ChannelOverview }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-3">Channel overview (last 28 days)</h2>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Stat label="Pieces sent"      value={overview.sent_28d.toLocaleString()} />
        <Stat label="QR scans"         value={overview.scans_28d.toLocaleString()} />
        <Stat label="Lob spend"        value={`$${overview.cost_spent_28d.toFixed(2)}`} />
        <Stat
          label="Cost per scan"
          value={overview.cost_per_scan == null ? "—" : `$${overview.cost_per_scan.toFixed(2)}`}
          hint={overview.cost_per_scan == null ? "No scans yet" : "Channel marginal efficiency"}
        />
        <Stat
          label="Exploration ratio"
          value={`${(overview.exploration_ratio * 100).toFixed(1)}%`}
          hint="% of sends to cold bandit arms (≤5 sends). Higher = more learning, lower = more exploitation."
        />
      </div>
    </section>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-gray-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
    </div>
  )
}

function TopVariantsSection({ topVariants }: { topVariants: VariantArmRow[] }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-3">Top variant arms (≥ 5 sends, sorted by lead rate → scan rate)</h2>
      {topVariants.length === 0 ? (
        <p className="text-sm text-gray-500 italic">No arms have 5+ sends yet. Keep dispatching — the bandit needs ~5 sends per arm before scan-rate signal is reliable.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left">
                <th className="py-2 px-3 font-semibold text-gray-700">Composition</th>
                <th className="py-2 px-3 font-semibold text-gray-700">Copy style</th>
                <th className="py-2 px-3 font-semibold text-gray-700">Persona</th>
                <th className="py-2 px-3 font-semibold text-gray-700">Use</th>
                <th className="py-2 px-3 font-semibold text-gray-700">Size</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">Sends</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">Scans</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">Leads</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">Scan%</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">Lead%</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">CPS</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">CPL</th>
                <th className="py-2 px-3 font-semibold text-gray-700 text-right">Beta μ</th>
              </tr>
            </thead>
            <tbody>
              {topVariants.map((v) => (
                <tr key={v.variant_id} className="border-b border-gray-100">
                  <td className="py-2 px-3 font-medium text-gray-900 whitespace-nowrap">{v.composition_id}</td>
                  <td className="py-2 px-3 text-gray-700">{v.copy_style}</td>
                  <td className="py-2 px-3 text-gray-700">{v.persona}</td>
                  <td className="py-2 px-3 text-gray-700">{v.use_kind}</td>
                  <td className="py-2 px-3 text-gray-700">{v.postcard_size}</td>
                  <td className="py-2 px-3 text-right text-gray-700">{v.sends_count}</td>
                  <td className="py-2 px-3 text-right text-gray-700">{v.scans_count}</td>
                  <td className="py-2 px-3 text-right font-medium text-green-700">{v.leads_count}</td>
                  <td className="py-2 px-3 text-right text-gray-700">{(v.scan_rate * 100).toFixed(2)}%</td>
                  <td className="py-2 px-3 text-right font-medium text-gray-900">{(v.lead_rate * 100).toFixed(2)}%</td>
                  <td className="py-2 px-3 text-right text-gray-700">{v.cost_per_scan == null ? "—" : `$${v.cost_per_scan.toFixed(2)}`}</td>
                  <td className="py-2 px-3 text-right font-medium text-gray-900">{v.cost_per_lead == null ? "—" : `$${v.cost_per_lead.toFixed(2)}`}</td>
                  <td className="py-2 px-3 text-right text-gray-500 text-xs">{v.posterior_mean.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-gray-500 mt-2">
            Beta mean = E[Beta(scans+1, sends-scans+1)] — the bandit&apos;s expected scan-rate estimate for the arm. Higher Beta mean with high sends = high-confidence winner.
          </p>
        </div>
      )}
    </section>
  )
}

function RecentCampaignsSection({ rows }: { rows: RecentCampaignRow[] }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-3">Recent campaigns (last 25)</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 italic">No campaigns yet.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="border border-gray-100 rounded p-3 bg-white">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      r.status === "sent" ? "bg-green-100 text-green-800"
                      : r.status === "failed" ? "bg-red-100 text-red-800"
                      : r.status === "cancelled" ? "bg-gray-100 text-gray-700"
                      : "bg-blue-100 text-blue-800"
                    }`}>{r.status ?? "—"}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">{r.target_audience ?? "—"}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">{r.piece_type ?? "—"}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      r.compliance_status === "passed" ? "bg-green-50 text-green-700"
                      : r.compliance_status === "blocked" ? "bg-red-50 text-red-700"
                      : "bg-gray-50 text-gray-500"
                    }`}>Compliance: {r.compliance_status}</span>
                  </div>
                  <div className="text-sm font-medium text-gray-900 truncate">{r.campaign_name ?? r.id}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {r.variant_summary && <span className="mr-3">Variant: {r.variant_summary}</span>}
                    {r.mailing_date && <span className="mr-3">Mailed: {r.mailing_date}</span>}
                    {r.lob_order_id && <span className="font-mono">Lob: {r.lob_order_id}</span>}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
