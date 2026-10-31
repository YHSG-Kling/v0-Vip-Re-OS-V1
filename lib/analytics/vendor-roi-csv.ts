// lib/analytics/vendor-roi-csv.ts — the provider-ROI CSV export, CLIENT-SAFE.
//
// Moved out of lib/analytics/vendor-roi.ts (lane 88F): that module builds the
// SERVICE-ROLE client, and app/dashboard/admin/provider-intelligence/page.tsx
// ("use client") value-imported it for this pure formatter — dragging service-role
// code into the browser bundle (scripts/client-server-only-guard.ts now sees a
// service-client builder, not only the `server-only` marker). Pure: no I/O.
import type { ProviderMetrics } from "./vendor-roi"

export function providerMetricsToCsv(providers: ProviderMetrics[]): string {
  const headers = [
    'Provider',
    'Total Leads',
    'Leads Qualified',
    'Conversion Rate %',
    'Total Spend ($)',
    'Cost / Lead ($)',
    'Cost / Qualified Lead ($)',
    'Est. ROI %',
    'Avg Lead Score',
    'Avg Days to Qualify',
  ]

  const rows = providers.map(p => [
    p.providerName,
    p.totalLeads,
    p.leadsQualified,
    (p.conversionRate * 100).toFixed(1),
    p.totalSpend.toFixed(2),
    p.costPerLead.toFixed(2),
    p.costPerQualifiedLead.toFixed(2),
    (p.estRoi * 100).toFixed(1),
    p.avgLeadScore.toFixed(1),
    p.avgDaysToQualify !== null ? p.avgDaysToQualify.toFixed(1) : 'N/A',
  ])

  return [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n')
}
