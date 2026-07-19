import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingDown, AlertCircle } from "lucide-react"
import { createServiceClient } from "@/lib/supabase/service"

/**
 * REFINANCE INDICATOR (lifetime portal) — LOAN TRUTH RE-SOURCE (loan-sweep
 * deferral closed): when the closed transaction has a transaction_lenders row,
 * the payment math runs on the REAL loan_amount and the REAL locked rate from
 * that record, labeled with its provenance. The 80%-LTV path survives ONLY as
 * the labeled fallback ("estimated — no loan record on file") — and the
 * original-rate side of the comparison is never fabricated: with no lender
 * record and no caller-provided rate, the card stays in its honest monitoring
 * state. The current-rate benchmark comes from market_rate_snapshots (the real
 * rate feed); the cold-start seed is never persisted there, so any row read is
 * a genuine market quote.
 */

interface RefinanceIndicatorCardProps {
  purchasePrice: number
  closeDate: string | null
  /** the closed transaction — lets the card re-source the loan from its transaction_lenders row */
  transactionId?: string | null
  estimatedCurrentRate?: number | null  // current 30yr fixed benchmark (override)
  estimatedOriginalRate?: number | null // estimated rate at time of purchase (override)
}

export async function RefinanceIndicatorCard({
  purchasePrice,
  closeDate,
  transactionId,
  estimatedCurrentRate,
  estimatedOriginalRate,
}: RefinanceIndicatorCardProps) {
  // ── Re-source the loan facts from the transaction's lender record (best-effort;
  //    the card never breaks the page over a read failure). ──
  let recordLoanAmount: number | null = null
  let recordRate: number | null = null
  let recordTermYears: number | null = null
  let lenderName: string | null = null
  let benchmarkRate: number | null = null
  let benchmarkDate: string | null = null
  try {
    const svc = createServiceClient()
    const [{ data: lender }, { data: snapshot }] = await Promise.all([
      transactionId
        ? svc.from("transaction_lenders")
            .select("loan_amount, interest_rate, loan_term_years, lender_name")
            .eq("transaction_id", transactionId).limit(1).maybeSingle()
        : Promise.resolve({ data: null as any }),
      svc.from("market_rate_snapshots")
        .select("rate_30yr_fixed_bps, rate_date")
        .order("rate_date", { ascending: false }).limit(1).maybeSingle(),
    ])
    const la = Number((lender as any)?.loan_amount)
    if (Number.isFinite(la) && la > 0) recordLoanAmount = la
    const ir = Number((lender as any)?.interest_rate)
    if (Number.isFinite(ir) && ir > 0) recordRate = ir
    const term = Number((lender as any)?.loan_term_years)
    if (Number.isFinite(term) && term > 0) recordTermYears = term
    lenderName = ((lender as any)?.lender_name as string | null) ?? null
    const bps = Number((snapshot as any)?.rate_30yr_fixed_bps)
    if (Number.isFinite(bps) && bps > 0) {
      benchmarkRate = bps / 100
      benchmarkDate = ((snapshot as any)?.rate_date as string | null) ?? null
    }
  } catch {
    // honest monitoring state below
  }

  // Only compute refi math when REAL rate inputs exist: the lender record's
  // locked rate (or a caller override) vs the market benchmark. Never
  // fabricate rates — show a neutral monitoring state until real data exists.
  const current = estimatedCurrentRate ?? benchmarkRate
  const original = estimatedOriginalRate ?? recordRate
  const hasRates = current != null && original != null
  const delta = hasRates ? (original as number) - (current as number) : 0
  const opportunityExists = hasRates && delta >= 0.5

  const yearsSincePurchase = closeDate
    ? (Date.now() - new Date(closeDate).getTime()) / (1000 * 60 * 60 * 24 * 365)
    : null

  // Monthly payment (principal + interest) — REAL loan amount from the lender
  // record when one exists; the 80%-LTV heuristic only as the labeled fallback.
  const loanKnown = recordLoanAmount != null
  const loanAmount = recordLoanAmount ?? purchasePrice * 0.8
  const loanSourceLabel = loanKnown
    ? `per your loan record on file${lenderName ? ` (${lenderName})` : ""}`
    : "estimated — no loan record on file (assumes 20% down)"
  const termMonths = (recordTermYears ?? 30) * 12
  const calcMonthlyPayment = (rate: number) => {
    const r = rate / 100 / 12
    const n = termMonths
    return (loanAmount * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
  }
  const monthlySavings = hasRates
    ? Math.max(0, calcMonthlyPayment(original as number) - calcMonthlyPayment(current as number))
    : 0

  return (
    <Card className={opportunityExists ? "border-emerald-200 bg-emerald-50/30" : undefined}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingDown className="h-5 w-5 text-emerald-600" />
            <CardTitle className="text-lg">Refinance Opportunity</CardTitle>
          </div>
          {opportunityExists ? (
            <Badge className="bg-emerald-100 text-emerald-800 border-0">Opportunity</Badge>
          ) : (
            <Badge variant="secondary">Monitoring</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {opportunityExists ? (
          <div className="space-y-2">
            <p className="text-sm">
              Current rates ({current}%) are <span className="font-semibold text-emerald-700">{delta.toFixed(1)}% lower</span> than your {recordRate != null && estimatedOriginalRate == null ? "locked rate on file" : "estimated original rate"} ({original}%).
            </p>
            {monthlySavings > 50 && (
              <p className="text-sm font-medium">
                Potential savings: ~${Math.round(monthlySavings).toLocaleString()}/mo
              </p>
            )}
            <p className="text-xs text-muted-foreground">Loan figures {loanSourceLabel}.{benchmarkDate ? ` Market benchmark as of ${benchmarkDate}.` : ""}</p>
            <p className="text-xs text-muted-foreground">
              Talk to your agent or a lender to see if refinancing makes sense for your situation.
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-sm text-muted-foreground">
              {hasRates
                ? `Current rates (${current}%) are near your ${recordRate != null && estimatedOriginalRate == null ? "locked rate on file" : "original rate"}. We'll alert you when a meaningful refinance opportunity appears.`
                : "We're monitoring mortgage rates for you and will alert you when a meaningful refinance opportunity appears."}
            </p>
          </div>
        )}
        {yearsSincePurchase !== null && (
          <p className="text-xs text-muted-foreground">
            You've owned your home for {yearsSincePurchase < 1 ? "less than a year" : `${Math.floor(yearsSincePurchase)} year${Math.floor(yearsSincePurchase) !== 1 ? "s" : ""}`}.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
