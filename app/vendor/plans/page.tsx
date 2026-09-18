import { redirect } from "next/navigation"
import Link from "next/link"
import { Layers, ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/server"
import { readRoleGrants, selectVendorGrant } from "@/lib/auth/role-grants"
import { listMyVendorPackageChargesAction } from "@/app/actions/vendors/vendor-plan-subscriptions"
import { VendorPackageChargesClient } from "./plans-client"

export const dynamic = "force-dynamic"

/**
 * VENDOR PACKAGES — THE PAYER'S VIEW.
 *
 * ══ THIS PAGE USED TO SAY THE OPPOSITE OF WHAT IS TRUE ══
 *
 * It shipped as "the plans brokerages can subscribe to from your company" — a
 * vendor authoring a price list that brokerages paid monthly. The owner ruling,
 * verbatim:
 *
 *   "vendor packages are for brokerages to charge the vendor on a subscription
 *    to the platform. vendors do bill the brokerages for jobs but not a monthly
 *    subscription."
 *
 * So the money runs the other way. A vendor package is something the BROKERAGE
 * SELLS TO THIS VENDOR, monthly. The vendor is the PAYER, and a payer does not
 * author or cancel its own bill — which is also exactly what the live write RLS
 * on vendor_subscriptions has always said (brokerage finance admin only; the
 * vendor is granted SELECT). This page is therefore READ-ONLY by design, not by
 * omission.
 *
 * WHAT THE VENDOR STILL DOES BILL FOR. Jobs. Per job, through /vendor/invoices
 * (vendor_invoices, billed_to='brokerage'). That path is unchanged and is linked
 * from here so the two are never confused.
 *
 * LINKAGE. Resolved through the CANONICAL vendor portal grant
 * (user_role_assignments.vendor_id → vendors.id), the same one /vendor/invoices
 * and /vendor/dashboard use — NOT vendor_marketplace_profiles, which is the
 * platform-tier identity in a disjoint id space (m440) and is what this page
 * used to read.
 */
export default async function VendorPackagesPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const grantsResult = await readRoleGrants(supabase, user.id)
  const { grant, ambiguous } = grantsResult.ok
    ? selectVendorGrant(grantsResult.grants)
    : { grant: null, ambiguous: false }

  // Three outcomes that must not share one sentence: a refused read, an
  // ambiguous linkage, and a genuine absence send a reader to different places.
  if (!grant?.vendor_id) {
    const reason = !grantsResult.ok
      ? "We could not verify your vendor account just now — please refresh."
      : ambiguous
        ? "Your account is linked to more than one vendor — ask the brokerage to correct it."
        : "No vendor profile found for your account."
    return (
      <div className="p-6 text-center text-muted-foreground">
        <p>{reason}</p>
        <Link href="/vendor/dashboard">
          <Button variant="link">
            <ArrowLeft className="mr-1 h-4 w-4" /> Back to Dashboard
          </Button>
        </Link>
      </div>
    )
  }

  const result = await listMyVendorPackageChargesAction()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Layers className="h-7 w-7" /> Packages
        </h1>
        <p className="text-muted-foreground mt-1">
          Packages a brokerage charges <strong>you</strong> for — recurring access and placement in
          that brokerage&apos;s marketplace. The brokerage sets the price and starts or ends the
          enrolment; you can see what you are on but cannot change it here.
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          This is not what you bill <em>for jobs</em>. Job work is invoiced by you to the brokerage
          on the{" "}
          <Link href="/vendor/invoices" className="underline">
            Invoices
          </Link>{" "}
          page, per job — never monthly. And it is not your platform tier either, which you pay us on
          the{" "}
          <Link href="/vendor/billing" className="underline">
            Billing
          </Link>{" "}
          page.
        </p>
      </div>

      {result.ok ? (
        <VendorPackageChargesClient charges={result.charges} direction={result.direction} />
      ) : (
        <p className="text-sm text-red-600">{result.error}</p>
      )}
    </div>
  )
}
