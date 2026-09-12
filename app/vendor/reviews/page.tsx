import { redirect } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { getMyVendorReviews } from "@/app/actions/vendor-marketplace"
import { Button } from "@/components/ui/button"
import { MessageSquare, ArrowLeft } from "lucide-react"
import { VendorReviewsClient } from "./reviews-client"

export const dynamic = "force-dynamic"

/**
 * THE VENDOR'S SIDE OF THE REVIEW SYSTEM.
 *
 * The review-as-a-product kernel (lib/kernel/vendor-review-moderation.ts) has
 * shipped verification, weighting, moderation, community flagging and the
 * vendor's one immutable public response — with no screen anywhere that let a
 * vendor read a review of itself, let alone answer one. This is that screen.
 *
 * Ownership is resolved inside getMyVendorReviews from
 * user_role_assignments.vendor_id — the canonical vendor linkage, since the
 * `vendors` table has no user_id.
 */
export default async function VendorReviewsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { vendorId, reviews } = await getMyVendorReviews()

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <Link href="/vendor/dashboard">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MessageSquare className="w-6 h-6 text-blue-600" />
            My Reviews
          </h1>
          <p className="text-gray-500 text-sm">
            {vendorId
              ? `${reviews.length} review${reviews.length === 1 ? "" : "s"} · you may post one public response per review`
              : "This account is not linked to a vendor profile yet."}
          </p>
        </div>
      </div>

      {vendorId ? (
        <VendorReviewsClient initialReviews={reviews as any[]} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Ask the brokerage that invited you to finish linking your login to your vendor
          record — reviews are attached to the vendor, not to the login.
        </p>
      )}
    </div>
  )
}
