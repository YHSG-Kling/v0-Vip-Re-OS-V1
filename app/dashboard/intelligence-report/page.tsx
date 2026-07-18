import { redirect } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isTenancyPrincipal, PRINCIPAL_ROLES } from "@/lib/kernel/tenancy-principal"
import {
  composeIntelligenceReport,
  lastMonthKeys,
  loadIntelligenceFacts,
  monthWindow,
} from "@/lib/kernel/intelligence-report"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Monthly Intelligence Report | Kernel OS",
  description:
    "Proof your AI team got measurably better this month — draft quality, earned autonomy, attribution, activity, and trust, every number from a ledger.",
}

/**
 * THE MONTHLY INTELLIGENCE REPORT — the owner's proof surface over the OS's
 * closed learning loops. Tenant-principal gated (same tier-parity rule as the
 * QBR / earned-autonomy actions). All numbers via the ONE pure composer in
 * lib/kernel/intelligence-report.ts — the board packet renders the same
 * sections. Sections with no data this month are omitted, never zero-padded.
 */
export default async function IntelligenceReportPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: me } = await supabase
    .from("users")
    .select("brokerage_id, role, user_type")
    .eq("id", user.id)
    .maybeSingle()
  const brokerageId = (me as any)?.brokerage_id as string | null
  if (!brokerageId) redirect("/dashboard")

  // TIER PARITY (same rule as the QBR / autonomy grant actions): broker/admin
  // always; solo agent IS the principal; team tier → the team lead.
  const svc = createServiceClient()
  const principal =
    PRINCIPAL_ROLES.has(String((me as any)?.user_type ?? "")) ||
    (await isTenancyPrincipal(svc, {
      userId: user.id,
      brokerageId,
      role: String((me as any)?.role ?? ""),
    }))
  if (!principal) redirect("/dashboard")

  // Month picker — the last 6 months; default to the current month.
  const months = lastMonthKeys(6)
  const { month } = await searchParams
  const monthKey = month && months.includes(month) ? month : months[0]

  const facts = await loadIntelligenceFacts(svc, brokerageId, monthKey)
  const report = composeIntelligenceReport(facts)

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Monthly Intelligence Report</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Proof your AI team got measurably better — every number below traces to a ledger row in the{" "}
          {report.monthLabel} window. Loops with nothing to show this month are omitted, never zero-padded.
        </p>
      </div>

      {/* Month picker — last 6 months, newest first */}
      <div className="flex flex-wrap gap-2">
        {months.map((key) => {
          const active = key === monthKey
          return (
            <Link
              key={key}
              href={`/dashboard/intelligence-report?month=${key}`}
              className={
                active
                  ? "rounded-full border border-primary bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                  : "rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
              }
            >
              {monthWindow(key).label}
            </Link>
          )
        })}
      </div>

      {report.empty ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium">Nothing measurable yet for {report.monthLabel}.</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              This report only shows numbers with ledger rows behind them. As your AI team drafts replies,
              earns autonomy grants, attributes closings, and works deals, the proof appears here month by
              month — measured, not claimed.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {report.sections.map((s) => (
            <Card key={s.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{s.title}</CardTitle>
                <p className="text-sm font-medium leading-snug">{s.headline}</p>
              </CardHeader>
              <CardContent>
                <dl className="divide-y">
                  {s.lines.map((l, i) => (
                    <div key={i} className="flex items-baseline justify-between gap-4 py-1.5">
                      <dt className="text-sm text-muted-foreground">{l.label}</dt>
                      <dd className="text-right text-sm">
                        <span className="font-medium">{l.value}</span>
                        {l.delta ? <span className="ml-2 text-xs text-muted-foreground">{l.delta}</span> : null}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          ))}
          <p className="text-xs text-muted-foreground">
            Composed from the operating ledgers (drafts, policy decisions, attribution credits, voice calls,
            transactions, manager signals, self-heal events) — the same composer feeds your monthly board
            packet PDF.
          </p>
        </div>
      )}
    </div>
  )
}
