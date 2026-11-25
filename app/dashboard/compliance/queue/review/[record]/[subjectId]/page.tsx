import Link from "next/link"
import { notFound } from "next/navigation"
import { RepresentationReviewPanel } from "@/app/dashboard/compliance/queue/representation-review-panel"

/**
 * ONE EXECUTED PACKET'S REVIEW, BY LINK (wave 156, lane 156B round 2) — the page a queue item, a notification or an offer's agent
 * opens: /dashboard/compliance/queue/review/<listing_agreement|purchase_offer>/<id>. Who may see it and who may decide it is decided
 * server-side by app/actions/compliance/representation-review.ts (reviewer: decide; the packet's agent / coordinator: read only).
 */
export default async function RepresentationReviewPage({ params }: { params: Promise<{ record: string; subjectId: string }> }) {
  const { record, subjectId } = await params
  if (record !== "listing_agreement" && record !== "purchase_offer") notFound()
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <Link href="/dashboard/compliance/queue" className="text-sm text-muted-foreground hover:underline">← Compliance queue</Link>
      <h1 className="text-2xl font-semibold">{record === "listing_agreement" ? "Listing agreement" : "Executed offer"} — compliance review</h1>
      <RepresentationReviewPanel record={record} subjectId={subjectId} />
    </div>
  )
}
