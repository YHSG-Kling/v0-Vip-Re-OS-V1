import { redirect } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ArrowLeft } from "lucide-react"
import { getLenderTridStatusAction } from "@/app/actions/trid-disclosure-receipt"
import { getLenderInsuranceCheckpointAction } from "@/app/actions/transaction-hazard-insurance"
import { LenderClosingFileForms } from "./lender-closing-file-forms"

export const dynamic = "force-dynamic"

/**
 * THE LENDER'S CLOSING FILE (wave 153, lane 153C; directive §153C C2 + C3).
 *
 * Owner (verbatim, 2026-11-14): "trid is determined from the lender because the lender sends the final cd to the buyer to sign and
 * should mark when trid starts". The ASSIGNED lender records its Closing Disclosure's delivery and the buyer's receipt (and any
 * revised disclosure), confirms a receipt an agent reported, records its insurance requirement and accepts the insurance evidence.
 * Both reads are gated by lib/kernel/portal-auth.ts requireLenderVendorActor (an unassigned lender sees nothing).
 */
export default async function LenderClosingFilePage({ params }: { params: Promise<{ transactionId: string }> }) {
  const { transactionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const [trid, insurance] = await Promise.all([getLenderTridStatusAction(transactionId), getLenderInsuranceCheckpointAction(transactionId)])
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/lender/underwriting"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold">Closing Disclosure and insurance</h1>
          <p className="text-gray-500 text-sm">Record when the buyer received your Closing Disclosure and what insurance evidence you require.</p>
        </div>
      </div>
      {!trid.success ? (
        <Card><CardContent className="py-8 text-center text-gray-600">{trid.error}</CardContent></Card>
      ) : (
        <LenderClosingFileForms transactionId={transactionId} trid={trid} insurance={insurance} />
      )}
    </div>
  )
}
