import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { logEventAndTrigger } from "@/lib/events"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    console.log("[v0] Dotloop webhook received:", body.event)

    const supabase = await createClient()

    if (body.event === "document.signed") {
      const { document_id, loop_id, signer } = body.data

      // Update document status
      const { data: doc, error } = await supabase
        .from("client_documents")
        .update({
          status: "signed",
          signed_at: new Date().toISOString(),
        })
        .eq("dotloop_document_id", document_id)
        .select()
        .single()

      if (!error && doc) {
        // Check if all documents are signed
        const { data: allDocs } = await supabase
          .from("client_documents")
          .select("status")
          .eq("dotloop_loop_id", loop_id)

        const allSigned = allDocs?.every((d) => d.status === "signed")

        if (allSigned && doc.transaction_id) {
          // Emit BOTH legacy and normalized events
          await logEventAndTrigger({
            event_type: "transaction.documents_complete",
            user_id: doc.contact_id,
            payload: {
              transactionId: doc.transaction_id,
              loopId: loop_id,
            },
            source: "webhook",
            dedupe_key: `docs-complete-${doc.transaction_id}`,
          })

          // Emit normalized provider event
          await logEventAndTrigger({
            event_type: "provider.signatures.complete",
            user_id: doc.contact_id,
            payload: {
              transactionId: doc.transaction_id,
              external_id: loop_id,
              provider: "dotloop",
            },
            source: "webhook",
            dedupe_key: `provider-sigs-complete-${doc.transaction_id}`,
          })
        }
      }
    }

    if (body.event === "loop.status.updated") {
      const { loop_id, status } = body.data

      // Update transaction status
      await supabase
        .from("transactions")
        .update({
          status: mapDotloopStatus(status),
        })
        .eq("dotloop_loop_id", loop_id)
    }

    return NextResponse.json({ received: true })
  } catch (error: any) {
    console.error("[v0] Dotloop webhook error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

function mapDotloopStatus(dotloopStatus: string): string {
  const statusMap: Record<string, string> = {
    Active: "under_contract",
    Pending: "pending",
    Closed: "closed",
    Canceled: "cancelled",
  }
  return statusMap[dotloopStatus] || "pending"
}
