import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Building2, Plus, Search, Filter, TrendingUp } from "lucide-react"
import Link from "next/link"
import { listBrokeragesAction } from "@/app/actions/superadmin/brokerage-management"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"

export const dynamic = "force-dynamic"

function fmtCents(c: number) {
  return `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function tierLabel(t: string) {
  switch (t) {
    case "solo_agent":     return "Solo"
    case "team":           return "Team"
    case "brokerage":      return "Brokerage"
    case "multi_location": return "Multi-loc"
    default:               return t
  }
}
function statusBadge(s: string) {
  switch (s) {
    case "active":    return <Badge className="bg-emerald-100 text-emerald-800 text-xs">Active</Badge>
    case "suspended": return <Badge className="bg-amber-100 text-amber-800 text-xs">Suspended</Badge>
    case "cancelled": return <Badge className="bg-red-100 text-red-800 text-xs">Cancelled</Badge>
    case "archived":  return <Badge className="bg-slate-100 text-slate-600 text-xs">Archived</Badge>
    default:          return <Badge variant="outline" className="text-xs">{s}</Badge>
  }
}
function sourceBadge(s: string) {
  switch (s) {
    case "self_serve": return <Badge variant="outline" className="text-[10px]">Self-serve</Badge>
    case "superadmin": return <Badge variant="outline" className="text-[10px]">Admin</Badge>
    case "partner":    return <Badge variant="outline" className="text-[10px]">Partner</Badge>
    case "import":     return <Badge variant="outline" className="text-[10px]">Import</Badge>
    default:           return null
  }
}

export default async function SuperadminBrokeragesPage(
  { searchParams }: { searchParams: Promise<{ status?: string; tier?: string; search?: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase.from("users").select("user_type").eq("id", user.id).maybeSingle()
  if (profile?.user_type !== "superadmin") {
    return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>
  }

  const params = await searchParams
  const result = await listBrokeragesAction({
    status: params.status as any,
    tier:   params.tier as any,
    search: params.search,
  })
  if (!result.ok) return <div className="p-6 text-red-600">Failed: {result.error}</div>

  const { rows, totals } = result

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            All brokerages
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {totals.count} brokerages · {fmtCents(totals.total_mrr_cents)} MRR · {fmtCents(totals.total_ai_cents)} AI cost (MTD)
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild>
            <Link href="/dashboard/superadmin/brokerages/new">
              <Plus className="h-4 w-4 mr-2" />
              Add subscriber manually
            </Link>
          </Button>
        </div>
      </div>

      {/* Filter chips (links — keeps the page server-rendered) */}
      <div className="flex gap-2 items-center flex-wrap">
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Filter className="h-3 w-3" /> Filter:
        </span>
        {(["active","suspended","cancelled","archived"] as const).map(s => (
          <Link key={s} href={params.status === s ? "/dashboard/superadmin/brokerages" : `/dashboard/superadmin/brokerages?status=${s}`}>
            <Badge variant={params.status === s ? "default" : "outline"} className="cursor-pointer">
              {s}
            </Badge>
          </Link>
        ))}
        <span className="text-xs text-muted-foreground ml-3">·</span>
        {(["solo_agent","team","brokerage","multi_location"] as const).map(t => (
          <Link key={t} href={params.tier === t ? "/dashboard/superadmin/brokerages" : `/dashboard/superadmin/brokerages?tier=${t}`}>
            <Badge variant={params.tier === t ? "default" : "outline"} className="cursor-pointer">
              {tierLabel(t)}
            </Badge>
          </Link>
        ))}
        <form action="/dashboard/superadmin/brokerages" className="flex items-center ml-auto">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text" name="search" defaultValue={params.search ?? ""}
              placeholder="Search name / city / state"
              className="text-sm border rounded-md pl-7 pr-3 py-1.5 w-64"
            />
          </div>
        </form>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            Brokerages
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No brokerages match.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Brokerage</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Tier</th>
                    <th className="text-center px-4 py-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">MRR</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">AI Cost</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Margin</th>
                    <th className="text-center px-4 py-2 font-medium text-muted-foreground">Team</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Signed up</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-muted/10">
                      <td className="px-4 py-2.5">
                        <Link href={`/dashboard/superadmin/brokerages/${r.id}`} className="font-medium hover:underline">
                          {r.name ?? "(unnamed)"}
                        </Link>
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          {r.city && r.state ? `${r.city}, ${r.state}` : "—"}
                          {sourceBadge(r.signup_source)}
                        </div>
                      </td>
                      <td className="px-4 py-2.5"><Badge variant="outline" className="text-xs">{tierLabel(r.plan_tier)}</Badge></td>
                      <td className="px-4 py-2.5 text-center">{statusBadge(r.status)}</td>
                      <td className="px-4 py-2.5 text-right">{fmtCents(r.mrr_cents)}</td>
                      <td className="px-4 py-2.5 text-right text-purple-700">{fmtCents(r.ai_cost_cents)}</td>
                      <td className={`px-4 py-2.5 text-right font-medium ${r.margin_cents < 0 ? "text-red-600" : "text-emerald-700"}`}>
                        {fmtCents(r.margin_cents)}
                        {r.margin_percent !== null && (
                          <div className="text-[10px] text-muted-foreground font-normal">{r.margin_percent.toFixed(0)}%</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center text-xs">
                        {r.team_member_count}
                        {r.pending_invites > 0 && (
                          <span className="ml-1 text-amber-700">(+{r.pending_invites})</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                        {new Date(r.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Button asChild size="sm" variant="ghost">
                          <Link href={`/dashboard/superadmin/brokerages/${r.id}`}>Open</Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
