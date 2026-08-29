import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getVendorEarningsSummary, completeStripeConnectOnboarding } from "@/app/actions/vendor-payments"
import { readVendorStripeConnect } from "@/lib/connections/vendor-stripe"
import { readRoleGrants, selectVendorId } from "@/lib/auth/role-grants"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { DollarSign, ArrowLeft, TrendingUp, CreditCard, Clock, CheckCircle2 } from "lucide-react"
import Link from "next/link"
import { VendorPayoutButton } from "./payout-button"
import { VendorStripeConnect } from "./stripe-connect"

export const dynamic = "force-dynamic"

function fmt(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount)
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    submitted: "bg-blue-100 text-blue-700",
    viewed: "bg-indigo-100 text-indigo-700",
    paid: "bg-green-100 text-green-700",
    overdue: "bg-red-100 text-red-700",
    cancelled: "bg-gray-100 text-gray-500",
    processing: "bg-yellow-100 text-yellow-700",
    pending: "bg-amber-100 text-amber-700",
    paid_out: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
  }
  return map[status] ?? "bg-gray-100 text-gray-600"
}

export default async function VendorEarningsPage({
  searchParams,
}: {
  searchParams: Promise<{ stripe?: string }>
}) {
  const sp = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const svc = createServiceClient()

  // ID SPACE — this page used to resolve the vendor from
  // `vendor_marketplace_profiles.user_id` and pass that row's id as `vendorId`.
  // That is the WRONG id space and it made this whole page inert: every money
  // table it reads (vendor_earnings, vendor_invoices, vendor_payouts) FKs to
  // `vendors.id`, `requireVendorActor()` matches `user_role_assignments.vendor_id`
  // (also `vendors.id`), and the Connection Center writes the vendor's
  // platform_credentials row under owner_id = `vendors.id`. A marketplace-profile
  // id matches none of them, so earnings/invoices/payouts always read empty, the
  // Stripe Connect banner never resolved the real account, and payout + onboarding
  // both failed their actor gate. `vendors` has no user_id — the canonical linkage
  // is `user_role_assignments.vendor_id`, which is what every other /vendor page
  // (dashboard, invoices, documents, connections, portfolio, reviews) already uses.
  //
  // The error was already checked here; what was still wrong is that the read
  // could only ever succeed for a user with exactly ONE vendor-bearing grant.
  // user_role_assignments is UNIQUE on (user_id, role), so a vendor who also holds
  // a second vendor-bearing grant makes `.maybeSingle()` a guaranteed error — and
  // this page then shows the outage banner to someone whose account is fine.
  const grantsResult = await readRoleGrants(supabase, user.id)
  if (!grantsResult.ok) {
    console.error("[vendor/earnings] role grant read failed:", grantsResult.error)
  }
  const { vendorId: resolvedVendorId, ambiguous } = grantsResult.ok
    ? selectVendorId(grantsResult.grants)
    : { vendorId: null, ambiguous: false }

  // supabase-js resolves a REFUSED read, so `data` alone reads "denied" as
  // "no vendor". Surface the failure instead of telling a real vendor they have
  // no profile.
  if (!grantsResult.ok) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        <p>Could not load your vendor account. Please refresh, or contact support if this persists.</p>
        <Link href="/vendor/dashboard">
          <Button variant="link">Back to Dashboard</Button>
        </Link>
      </div>
    )
  }

  const vendorId = resolvedVendorId

  if (!vendorId) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        <p>
          {ambiguous
            ? "Your account is linked to more than one vendor — ask the brokerage to correct it."
            : "Vendor profile not found."}
        </p>
        <Link href="/vendor/dashboard">
          <Button variant="link">Back to Dashboard</Button>
        </Link>
      </div>
    )
  }

  // Returning from Stripe's hosted onboarding. Webhooks are eventually consistent
  // and Connect events must be separately enabled on the endpoint, so reconcile
  // synchronously here before rendering the Connect banner — otherwise a vendor who
  // just finished onboarding still sees "Connect Stripe to receive payouts".
  // completeStripeConnectOnboarding() re-reads the account from Stripe and passes
  // the computed boolean through, so this also DEMOTES a restricted account.
  let stripeNotice: { tone: "ok" | "warn"; text: string } | null = null
  if (sp.stripe === "complete") {
    const res = await completeStripeConnectOnboarding(vendorId)
    stripeNotice = res.success
      ? { tone: "ok", text: "Stripe payouts are now connected." }
      : { tone: "warn", text: res.error ?? "Stripe onboarding is not complete yet." }
  } else if (sp.stripe === "refresh") {
    stripeNotice = {
      tone: "warn",
      text: "Your Stripe onboarding link expired before it was finished. Start it again below.",
    }
  }

  const stripeConnect = await readVendorStripeConnect(svc, vendorId)
  const summary = await getVendorEarningsSummary(vendorId)

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/vendor/dashboard">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-green-600" />
            My Earnings
          </h1>
          <p className="text-muted-foreground text-sm">Revenue and payment history</p>
        </div>
      </div>

      {/* Stripe return-from-onboarding reconciliation notice */}
      {stripeNotice && (
        <div
          className={
            stripeNotice.tone === "ok"
              ? "rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
              : "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          }
        >
          {stripeNotice.text}
        </div>
      )}

      {/* Stripe Connect status */}
      <VendorStripeConnect
        vendorId={vendorId}
        stripeAccountId={stripeConnect.accountId}
        onboardingComplete={stripeConnect.onboardingComplete}
      />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-green-600">{fmt(summary.netTotal)}</p>
            <p className="text-xs text-muted-foreground mt-1">Total Earned (net)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-amber-600">{fmt(summary.pendingAmount)}</p>
            <p className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
              <Clock className="h-3 w-3" /> Pending
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-blue-600">{fmt(summary.availableAmount)}</p>
            <p className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> Available
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-purple-600">{fmt(summary.paidOutAmount)}</p>
            <p className="text-xs text-muted-foreground mt-1">Paid Out</p>
          </CardContent>
        </Card>
      </div>

      {/* Payout CTA */}
      {summary.availableAmount > 0 && (
        <VendorPayoutButton
          vendorId={vendorId}
          availableAmount={summary.availableAmount}
          stripeReady={stripeConnect.onboardingComplete}
        />
      )}

      {/* Invoice history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            Invoice History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {summary.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              Invoices will appear here once jobs are completed.
            </p>
          ) : (
            <div className="space-y-2">
              {summary.invoices.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between py-2 border-b last:border-0 text-sm"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">
                      {inv.invoiceNumber ?? `INV-${inv.id.slice(0, 8).toUpperCase()}`}
                    </span>
                    <span className="text-xs text-muted-foreground capitalize">
                      Billed to: {inv.billedTo}
                      {inv.dueDate && ` · Due ${new Date(inv.dueDate).toLocaleDateString()}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold">{fmt(inv.total)}</span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadge(inv.status)}`}
                    >
                      {inv.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payout history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Payout History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {summary.payouts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No payouts yet.
            </p>
          ) : (
            <div className="space-y-2">
              {summary.payouts.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between py-2 border-b last:border-0 text-sm"
                >
                  <div className="flex flex-col">
                    <span className="font-medium capitalize">{p.method} payout</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(p.initiatedAt).toLocaleDateString()}
                      {p.completedAt && ` → ${new Date(p.completedAt).toLocaleDateString()}`}
                      {p.cashAppReference && ` · ref ${p.cashAppReference}`}
                      {/* What the transfer settled. Written at payout creation and
                          previously unreadable by the payee — a lump sum with no
                          count of the jobs behind it cannot be reconciled. */}
                      {p.coveredEarningsCount > 0 &&
                        ` · covers ${p.coveredEarningsCount} earning${p.coveredEarningsCount === 1 ? "" : "s"}`}
                    </span>
                    {/* The brokerage's own note on this payout. */}
                    {p.note && (
                      <span className="text-xs text-muted-foreground italic">{p.note}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold">{fmt(p.amount)}</span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadge(p.status)}`}
                    >
                      {p.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
