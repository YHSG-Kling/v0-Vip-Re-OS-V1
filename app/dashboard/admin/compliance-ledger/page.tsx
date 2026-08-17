import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { loadComplianceLedger } from "@/lib/kernel/compliance-ledger"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const metadata = {
  title: "Compliance Ledger | Kernel OS Admin",
  description: "Every outbound message and its Fair Housing / consent disposition — the regulatory audit trail.",
}

const SEV_BADGE: Record<string, string> = {
  clear: "bg-green-100 text-green-800",
  advisory: "bg-amber-100 text-amber-800",
  blocked: "bg-red-100 text-red-800",
}
const RANGES = [7, 30, 90, 365]
const SEVERITIES = ["all", "advisory", "blocked"] as const

/**
 * COMPLIANCE LEDGER — the Compliance Officer's on-demand audit report. Reads compliance_events
 * (gate_name='compliance_preflight'): every outbound decision, its Fair Housing / consent verdict,
 * who released it, and the ones released over an open objection. Admin/broker/superadmin only;
 * brokerage-scoped (superadmin = platform-wide). All data via loadComplianceLedger — no mock data.
 */
export default async function ComplianceLedgerPage({ searchParams }: { searchParams: Promise<{ days?: string; severity?: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { days, severity } = await searchParams

  const { data: userData } = await supabase
    .from("users").select("user_type, platform_role, brokerage_id").eq("id", user.id).maybeSingle()
  const userType = userData?.user_type ?? "agent"
  if (!isAdminOrBroker({ user_type: userType })) redirect("/dashboard")
  // Platform-wide ledger scope from BOTH identity columns. `userType ===
  // "superadmin"` is FALSE for the platform's only superadmin (user_type='admin',
  // platform_role='superadmin'), so brokerageId was never null and the
  // platform-wide compliance audit trail — the cross-tenant Fair Housing /
  // consent record this page exists to produce — was unreachable. Same shape as
  // public.is_platform_admin() in RLS; see app/actions/vendor-budget.ts:136-147.
  const isSuperadmin = userType === "superadmin" || userData?.platform_role === "superadmin"
  const brokerageId = isSuperadmin ? null : (userData?.brokerage_id ?? null)

  const sinceDays = RANGES.includes(Number(days)) ? Number(days) : 30
  const sev = severity && SEVERITIES.includes(severity as any) && severity !== "all" ? severity : undefined
  const { rows, summary } = await loadComplianceLedger(brokerageId, { sinceDays, severity: sev })

  const qs = (d: number, s: string) => `?days=${d}${s !== "all" ? `&severity=${s}` : ""}`
  const activeSev = sev ?? "all"

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">⚖️ Compliance Ledger</h1>
        <p className="text-sm text-muted-foreground">
          Every outbound message and its Fair Housing / consent disposition — the Compliance Officer&apos;s audit trail.
        </p>
      </div>

      {/* Disposition summary — always the FULL window, regardless of the row filter. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Reviewed", value: summary.total, tone: "text-foreground" },
          { label: "Cleared", value: summary.cleared, tone: "text-green-700" },
          { label: "Advisory", value: summary.advisory, tone: "text-amber-700" },
          { label: "Blocked", value: summary.blocked, tone: "text-red-700" },
          { label: "Released over objection", value: summary.approvedDespiteAdvisory, tone: "text-red-700" },
          { label: "Held (rejected)", value: summary.rejected, tone: "text-slate-700" },
        ].map((c) => (
          <Card key={c.label} className="p-3">
            <div className={`text-2xl font-semibold ${c.tone}`}>{c.value}</div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{c.label}</div>
          </Card>
        ))}
      </div>

      {/* Filters — pure links (SSR), no client JS. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Window:</span>
        {RANGES.map((d) => (
          <Link key={d} href={qs(d, activeSev)} className={`rounded-full px-2.5 py-1 ${d === sinceDays ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
            {d === 365 ? "1 year" : `${d}d`}
          </Link>
        ))}
        <span className="ml-3 text-muted-foreground">Severity:</span>
        {SEVERITIES.map((s) => (
          <Link key={s} href={qs(sinceDays, s)} className={`rounded-full px-2.5 py-1 capitalize ${s === activeSev ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
            {s}
          </Link>
        ))}
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Queue</th>
              <th className="px-3 py-2">Channel</th>
              <th className="px-3 py-2">Disposition</th>
              <th className="px-3 py-2">Released</th>
              <th className="px-3 py-2">Findings</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No outbound decisions in this window.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t align-top">
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{r.when ? new Date(r.when).toLocaleString() : "—"}</td>
                <td className="px-3 py-2">{r.queue.replace(/_/g, " ")}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.channel}</td>
                <td className="px-3 py-2">
                  <Badge className={SEV_BADGE[r.severity] ?? "bg-slate-100 text-slate-700"}>{r.severity}</Badge>
                  {r.releasedOverObjection && <Badge className="ml-1 bg-red-100 text-red-800">over objection</Badge>}
                </td>
                <td className="px-3 py-2">{r.released ? "Sent" : "Held"}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.findings.length === 0 ? "—" : <ul className="space-y-0.5">{r.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
