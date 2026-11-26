// THE RECEIPT REVIEW (wave 152, lane 152D) — the page image beside what was read from it, each value with the page
// and the words it came from. Approve runs THE ONE expense writer (logScopedExpense) with the reviewer as the actor;
// decline keeps the receipt and the reading and records nothing. The session gates everything (getReceiptReview).

import { redirect } from "next/navigation"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/server"
import { getReceiptReview } from "@/app/actions/financials"
import { ReceiptReviewClient } from "./receipt-review-client"

export default async function ReceiptReviewPage({ params }: { params: Promise<{ documentId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { documentId } = await params
  const result = await getReceiptReview(documentId)
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/financials/expenses"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <h1 className="text-2xl font-bold">Review scanned receipt</h1>
      </div>
      {result.ok
        ? <ReceiptReviewClient review={result.review} />
        : <div className="rounded-lg border p-4 text-sm">{result.error} <Link className="text-blue-600 hover:underline" href="/dashboard/financials/expenses">Back to expenses</Link></div>}
    </div>
  )
}
