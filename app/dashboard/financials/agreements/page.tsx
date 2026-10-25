import { redirect } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { isBrokerageFinanceAdminGrantRole } from "@/lib/auth/resolve-user-role"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { RoleGateNotice } from "@/app/components/shared/role-gate-notice"
import { ArrowLeft, FileSignature } from "lucide-react"
import { listCommissionAgreementHistoryAction } from "@/app/actions/commission-agreement-history"

export const dynamic = "force-dynamic"

/** Term keys worth naming in a plain-language change line; everything else prints under its column name. */
const TERM_LABELS: Record<string, string> = {
  split_percent: "Agent split %",
  cap_amount: "Cap",
  team_override_percent: "Team override %",
  transaction_fee_value: "Transaction fee",
  desk_fee_value: "Desk fee",
  technology_fee_value: "Technology fee",
  eo_fee_value: "E&O fee",
  referral_value: "Referral term",
  residual_value: "Residual term",
  royalty_value: "Royalty term",
  // Wave 144 (144D, owner ruling 9): the cap cycle and what counts toward it come from the agreement (m850).
  cap_anniversary_date: "Cap anniversary",
  cap_eligible_contributions: "Counts toward the cap",
  structure_type: "Structure",
  is_active: "Active",
}
const show = (v: unknown) => (v === null || v === undefined ? "—" : String(v))

/**
 * COMMISSION AGREEMENTS — the terms history and the signed record (wave 143, lane 143C).
 * The commission engine prices every deal on the agreement IN FORCE on the deal's date; this page is where a finance
 * admin sees those agreements, what changed between versions, and the signed documents of record beside them.
 */
export default async function CommissionAgreementsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const context = await ensureAgentContextInPlace()
  if (!context.isAuthenticated) redirect("/login")

  if (!isBrokerageFinanceAdminGrantRole(context.role)) {
    return <RoleGateNotice surface="Commission agreements" audience="your broker, broker owner and brokerage admins" />
  }

  const result = await listCommissionAgreementHistoryAction()

  return (
    <div className="container mx-auto max-w-5xl space-y-6 px-4 py-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/financials/commissions" className="text-muted-foreground hover:text-foreground" aria-label="Back to commissions">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><FileSignature className="h-6 w-6" /> Commission agreements</h1>
          <p className="text-sm text-muted-foreground">
            Each deal is priced on the agreement in force on its closing date — never today&apos;s percentage on an earlier deal.
          </p>
        </div>
      </div>

      {!result.ok ? (
        <Card><CardContent className="py-6 text-sm text-destructive">{result.error}</CardContent></Card>
      ) : (
        <>
          {!result.historyAvailable && (
            <Card><CardContent className="py-4 text-sm text-muted-foreground">
              The terms history is not available yet — deals are priced on each agent&apos;s current profile until it is switched on.
            </CardContent></Card>
          )}

          {result.agents.length === 0 && result.historyAvailable && (
            <Card><CardContent className="py-6 text-sm text-muted-foreground">No agent commission terms are on record yet.</CardContent></Card>
          )}

          {result.agents.map((a) => (
            <Card key={a.agentId}>
              <CardHeader>
                <CardTitle className="text-lg">{a.name}</CardTitle>
                <CardDescription>
                  {a.versions.length} version{a.versions.length === 1 ? "" : "s"} of terms · {a.signed.length} signed agreement{a.signed.length === 1 ? "" : "s"} on file
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {a.versions.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="py-2 pr-4 font-medium">In force from</th>
                          <th className="py-2 pr-4 font-medium">Agent split</th>
                          <th className="py-2 pr-4 font-medium">What changed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...a.versions].reverse().map((v) => (
                          <tr key={v.id} className="border-b align-top last:border-0">
                            <td className="py-2 pr-4 whitespace-nowrap">{v.effectiveFrom === "1900-01-01" ? "From the start" : v.effectiveFrom}</td>
                            <td className="py-2 pr-4">{show(v.terms.split_percent)}{v.terms.split_percent != null ? "%" : ""}</td>
                            <td className="py-2 pr-4">
                              {v.changes.length === 0
                                ? <span className="text-muted-foreground">No change recorded</span>
                                : v.changes.filter((c) => c.key !== "is_active" || c.to === false).slice(0, 12).map((c) => (
                                    <div key={c.key}>{TERM_LABELS[c.key] ?? c.key}: {show(c.from)} → <strong>{show(c.to)}</strong></div>
                                  ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {a.signed.length === 0 && <span className="text-sm text-muted-foreground">No fully signed agreement on file.</span>}
                  {a.signed.map((s) => (
                    <Badge key={s.id} variant="outline" className="gap-1">
                      {s.contractType.replace(/_/g, " ")} · signed {s.fullyExecutedAt.slice(0, 10)}
                      {s.documentUrl && <a href={s.documentUrl} className="underline" target="_blank" rel="noreferrer">view</a>}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}

          {result.teams.map((t) => (
            <Card key={t.teamId}>
              <CardHeader>
                <CardTitle className="text-lg">Team · {t.name}</CardTitle>
                <CardDescription>The team&apos;s standing terms by the date they take effect</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {/* phone: one card per version (the census' card variant); desktop: the table */}
                <div className="md:hidden space-y-3">
                  {[...t.versions].reverse().map((v) => (
                    <div key={v.effectiveDate} className="rounded-md border p-3 text-sm space-y-1">
                      <div className="font-medium">{v.effectiveDate === "1900-01-01" ? "From the start" : v.effectiveDate}</div>
                      <div className="text-muted-foreground">Team lead share: {v.splitValue == null ? "—" : v.splitType === "flat" ? `$${v.splitValue.toLocaleString()} flat` : `${v.splitValue}%`}</div>
                      <div className="text-muted-foreground">Cap: {v.capAmount == null ? "No cap" : `$${v.capAmount.toLocaleString()}`}</div>
                    </div>
                  ))}
                </div>
                <div className="hidden md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">In force from</th>
                      <th className="py-2 pr-4 font-medium">Team lead share</th>
                      <th className="py-2 pr-4 font-medium">Cap</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...t.versions].reverse().map((v) => (
                      <tr key={v.effectiveDate} className="border-b last:border-0">
                        <td className="py-2 pr-4 whitespace-nowrap">{v.effectiveDate === "1900-01-01" ? "From the start" : v.effectiveDate}</td>
                        <td className="py-2 pr-4">{v.splitValue == null ? "—" : v.splitType === "flat" ? `$${v.splitValue.toLocaleString()} flat` : `${v.splitValue}%`}</td>
                        <td className="py-2 pr-4">{v.capAmount == null ? "No cap" : `$${v.capAmount.toLocaleString()}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  )
}
