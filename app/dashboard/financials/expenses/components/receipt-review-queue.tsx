// RECEIPTS WAITING FOR REVIEW (wave 152, lane 152D) — server component. The caller's own uploads, or every receipt in
// the account for an admin who keeps the books (lib/documents/receipt-intake.ts listReceiptReviews). A refused read is
// said, never rendered as "nothing waiting".

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { listReceiptReviewQueue } from "@/app/actions/financials"

export async function ReceiptReviewQueue() {
  const result = await listReceiptReviewQueue()
  if (!result.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        {result.error} Receipts you scanned are saved; nothing has been recorded from them.
      </div>
    )
  }
  if (result.rows.length === 0) return null
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Receipts waiting for review ({result.rows.length})</CardTitle>
        <CardDescription>These were read for you but are not on your books until someone confirms them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {result.rows.map((r) => (
          <Link key={r.documentId} href={`/dashboard/financials/expenses/receipts/${r.documentId}`} className="flex items-center justify-between rounded border p-2 text-sm hover:bg-muted/50">
            <span className="truncate">{r.summary ?? r.fileName ?? "Scanned receipt"}</span>
            <span className="flex items-center gap-2 shrink-0">
              <Badge variant="outline" className="text-xs">{r.kindLabel}</Badge>
              <span className="text-xs text-muted-foreground">{r.createdAt ? new Date(r.createdAt).toLocaleDateString("en-US") : ""}</span>
            </span>
          </Link>
        ))}
      </CardContent>
    </Card>
  )
}
