import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { Camera, QrCode, Home, TrendingUp, Eye, Zap, ArrowRight, Users, DollarSign, BarChart3 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AcquisitionQuickCapture } from "./acquisition-quick-capture"
import { AcquisitionOpenHouseCard } from "./acquisition-open-house-card"
import { getRecruitingROISummary, getRecruitROIByRecruit } from "@/app/actions/recruiting-roi"

export const metadata = { title: "Lead Acquisition", description: "All your inbound capture tools in one place" }

export default async function AcquisitionPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Resolve role + ids
  const { data: roleRow } = await supabase
    .from("user_role_assignments")
    .select("role, agent_id, brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()

  const role = roleRow?.role ?? "agent"
  const agentId = roleRow?.agent_id ?? user.id
  const brokerageId = roleRow?.brokerage_id ?? ""
  const isAdminOrBroker = ["admin", "broker", "superadmin"].includes(role)

  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)
  const startOfMonthISO = startOfMonth.toISOString()

  // Parallel data load — all real tables confirmed in schema
  const [
    cardScansResult,
    qrCodesResult,
    openHouseLeadsResult,
    valuationRequestsResult,
    activeListingsResult,
  ] = await Promise.all([
    // Business cards scanned this month
    supabase
      .from("business_card_scans")
      .select("id, created_at, contact_id, extracted_data", { count: "exact" })
      .eq("agent_id", agentId)
      .gte("created_at", startOfMonthISO)
      .order("created_at", { ascending: false })
      .limit(3),

    // Active QR codes
    supabase
      .from("qr_codes")
      .select("id, label, scan_count, created_at, slug", { count: "exact" })
      .eq("agent_id", agentId)
      .eq("is_active", true)
      .order("scan_count", { ascending: false })
      .limit(3),

    // Open house attendees this month (via event join)
    supabase
      .from("open_house_attendees")
      .select(`
        id, created_at, check_in_time,
        event:open_house_events!event_id(agent_id, listing_id, event_date),
        contact:contacts!contact_id(first_name, last_name, email)
      `, { count: "exact" })
      .gte("created_at", startOfMonthISO)
      .limit(3),

    // Home value / valuation requests (confirmed table: valuation_requests)
    supabase
      .from("valuation_requests")
      .select("id", { count: "exact" })
      .eq("brokerage_id", brokerageId)
      .gte("submitted_at", startOfMonthISO),

    // Agent's active listings for the open house quick-create selector
    // Brokers see all brokerage listings; agents see only their own
    isAdminOrBroker
      ? supabase
          .from("listings")
          .select("id, address, city, state")
          .eq("brokerage_id", brokerageId)
          .in("status", ["active", "coming_soon"])
          .order("created_at", { ascending: false })
          .limit(20)
      : supabase
          .from("listings")
          .select("id, address, city, state")
          .eq("agent_id", agentId)
          .in("status", ["active", "coming_soon"])
          .order("created_at", { ascending: false })
          .limit(20),
  ])

  const recentCards = cardScansResult.data ?? []
  const cardCount = cardScansResult.count ?? 0
  const qrCodes = qrCodesResult.data ?? []
  const qrCount = qrCodesResult.count ?? 0
  const openHouseLeads = openHouseLeadsResult.data ?? []
  const openHouseCount = openHouseLeadsResult.count ?? 0
  const valuationCount = valuationRequestsResult.count ?? 0
  const activeListings = activeListingsResult.data ?? []

  const topQr = qrCodes[0] ?? null

  // Recruiting ROI — only for admin/broker
  const [recruitROISummary, recruitROIByRecruit] = isAdminOrBroker && brokerageId
    ? await Promise.all([
        getRecruitingROISummary(brokerageId).catch(() => null),
        getRecruitROIByRecruit(brokerageId).catch(() => []),
      ])
    : [null, []]

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-8 font-sans">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Zap className="h-6 w-6 text-foreground" aria-hidden="true" />
            <h1 className="text-2xl font-bold text-foreground text-balance">Lead Acquisition</h1>
          </div>
          <p className="text-sm text-muted-foreground">All your inbound capture tools in one place</p>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Cards scanned", value: cardCount, icon: Camera },
          { label: "Active QR codes", value: qrCount, icon: QrCode },
          { label: "Open house captures", value: openHouseCount, icon: Home },
          { label: "Home value requests", value: valuationCount, icon: TrendingUp },
        ].map(({ label, value, icon: Icon }) => (
          <div
            key={label}
            className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
          >
            <Icon className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
            <div>
              <p className="text-xl font-bold text-foreground leading-none">{value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Acquisition module cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* Card 1 — Business Card Scanner */}
        <Card className="flex flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-muted p-2">
                  <Camera className="h-4 w-4 text-foreground" aria-hidden="true" />
                </div>
                <CardTitle className="text-base">Business Card Scanner</CardTitle>
              </div>
              {cardCount > 0 && (
                <Badge variant="secondary">{cardCount} this month</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Scan a photo and Claude AI extracts contact info — contact created instantly.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 flex-1">
            {recentCards.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Recent scans</p>
                {recentCards.map((scan) => {
                  const name = [
                    scan.extracted_data?.first_name,
                    scan.extracted_data?.last_name,
                  ]
                    .filter(Boolean)
                    .join(" ") || "Unknown"
                  return (
                    <div key={scan.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-foreground">{name}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {new Date(scan.created_at).toLocaleDateString()}
                        </span>
                        {scan.contact_id && (
                          <Link
                            href={`/crm/contacts/${scan.contact_id}`}
                            className="text-xs text-primary underline underline-offset-2"
                          >
                            View
                          </Link>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No scans this month.</p>
            )}
            <div className="mt-auto">
              <Link href="/dashboard/agent/business-cards">
                <Button className="w-full gap-2" size="sm">
                  Scan a Card
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Card 2 — QR Codes */}
        <Card className="flex flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-muted p-2">
                  <QrCode className="h-4 w-4 text-foreground" aria-hidden="true" />
                </div>
                <CardTitle className="text-base">QR Codes</CardTitle>
              </div>
              {qrCount > 0 && (
                <Badge variant="secondary">{qrCount} active</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Generate codes for listings, open houses, and social media — every scan tracked.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 flex-1">
            {topQr ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Top performing</p>
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
                  <p className="text-sm font-medium text-foreground text-pretty">{topQr.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{topQr.scan_count ?? 0} total scans</p>
                </div>
                {qrCodes.slice(1).map((qr) => (
                  <div key={qr.id} className="flex items-center justify-between text-sm">
                    <span className="text-foreground text-pretty">{qr.label}</span>
                    <span className="text-xs text-muted-foreground">{qr.scan_count ?? 0} scans</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No active QR codes yet.</p>
            )}
            <div className="mt-auto">
              <Link href="/dashboard/agent/qr-codes">
                <Button className="w-full gap-2" size="sm">
                  Manage QR Codes
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Card 3 — Open House (client component for inline quick-create) */}
        <AcquisitionOpenHouseCard
          openHouseLeads={openHouseLeads as any}
          openHouseCount={openHouseCount}
          agentId={agentId}
          activeListings={activeListings}
        />

        {/* Card 4 — Home Value Requests */}
        <Card className="flex flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-muted p-2">
                  <TrendingUp className="h-4 w-4 text-foreground" aria-hidden="true" />
                </div>
                <CardTitle className="text-base">Home Value Requests</CardTitle>
              </div>
              {valuationCount > 0 && (
                <Badge variant="secondary">{valuationCount} this month</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Sellers who requested a home value estimate — warm inbound seller leads.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 flex-1">
            {valuationCount === 0 ? (
              <p className="text-sm text-muted-foreground">No requests this month.</p>
            ) : (
              <p className="text-sm text-foreground">
                <span className="font-semibold">{valuationCount}</span> home value{" "}
                {valuationCount === 1 ? "request" : "requests"} received this month.
              </p>
            )}
            <div className="mt-auto flex flex-col gap-2">
              <Link href="/leads?source=home_value">
                <Button className="w-full gap-2" size="sm">
                  View Requests
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </Link>
              <Link href="/home-value">
                <Button className="w-full" size="sm" variant="outline">
                  Your Home Value Page
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Card 5 — Visitor Intelligence (admin/broker only) */}
        {isAdminOrBroker && (
          <Card className="md:col-span-2">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-muted p-2">
                  <Eye className="h-4 w-4 text-foreground" aria-hidden="true" />
                </div>
                <CardTitle className="text-base">Anonymous Visitor Intelligence</CardTitle>
                <Badge variant="outline" className="text-xs">Admin / Broker</Badge>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Identify anonymous website visitors and surface high-intent prospects before they raise their hand.
              </p>
            </CardHeader>
            <CardContent>
              <Link href="/dashboard/admin/visitor-tracking">
                <Button className="gap-2" size="sm">
                  View Visitor Intelligence
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Recruiting ROI — admin/broker only */}
      {isAdminOrBroker && recruitROISummary && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-foreground" />
            <h2 className="text-lg font-semibold">Recruiting ROI</h2>
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Total Invested",      value: `$${recruitROISummary.totalInvested.toLocaleString()}`,  icon: DollarSign, color: "text-red-600" },
              { label: "Total Generated",     value: `$${recruitROISummary.totalGenerated.toLocaleString()}`, icon: TrendingUp, color: "text-green-600" },
              { label: "Avg ROI",             value: `${recruitROISummary.avgROI.toFixed(1)}%`,               icon: BarChart3,  color: "text-blue-600" },
              { label: "Profitable Recruits", value: `${recruitROISummary.profitableRecruits}/${recruitROISummary.activeRecruits}`, icon: Users, color: "text-purple-600" },
            ].map(({ label, value, icon: Icon, color }) => (
              <div key={label} className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
                <Icon className={`h-4 w-4 shrink-0 ${color}`} />
                <div>
                  <p className={`text-xl font-bold leading-none ${color}`}>{value}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Per-recruit table */}
          {(recruitROIByRecruit as any[]).length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Per-Recruit ROI</CardTitle>
                <CardDescription>Sorted by highest ROI</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b">
                      <tr>
                        <th className="text-left py-2 px-2 font-medium">Agent</th>
                        <th className="text-right py-2 px-2 font-medium">Recruiting Cost</th>
                        <th className="text-right py-2 px-2 font-medium">Revenue Generated</th>
                        <th className="text-right py-2 px-2 font-medium">ROI</th>
                        <th className="text-right py-2 px-2 font-medium">Break-even Month</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {(recruitROIByRecruit as any[]).map((r: any) => (
                        <tr key={r.id} className="hover:bg-muted/50">
                          <td className="py-2 px-2 font-medium">
                            {/* Names come from users — agents carries no first_name/last_name. */}
                            {`${r.agents?.users?.first_name ?? ""} ${r.agents?.users?.last_name ?? ""}`.trim() || "Unknown"}
                          </td>
                          <td className="py-2 px-2 text-right text-red-600">${(r.total_recruiting_cost ?? 0).toLocaleString()}</td>
                          <td className="py-2 px-2 text-right text-green-600">${(r.lifetime_brokerage_net ?? 0).toLocaleString()}</td>
                          <td className="py-2 px-2 text-right">
                            <Badge variant={(r.roi_pct ?? 0) > 0 ? "default" : "secondary"} className="text-xs">
                              {(r.roi_pct ?? 0).toFixed(1)}%
                            </Badge>
                          </td>
                          <td className="py-2 px-2 text-right text-muted-foreground">
                            {r.breakeven_month ? `Mo. ${r.breakeven_month}` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Quick Capture Form */}
      <AcquisitionQuickCapture />
    </main>
  )
}
