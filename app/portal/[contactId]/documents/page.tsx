import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { DocumentsClient } from "./DocumentsClient"

export default async function DocumentsPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // 1. Query transactions first
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id")
    .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)

  const transactionIds = transactions?.map(t => t.id) ?? []

  // 2. Query client_documents
  const { data: clientDocuments } = await supabase
    .from("client_documents")
    .select("id, name, document_type, file_url, uploaded_at, uploaded_by, review_status, notes")
    .eq("contact_id", contactId)
    .order("uploaded_at", { ascending: false })

  // 3. Query transaction_documents if transactionIds exist
  let transactionDocuments: any[] = []
  if (transactionIds.length > 0) {
    const { data } = await supabase
      .from("transaction_documents")
      .select("id, name, document_type, file_url, uploaded_at, required, status, transaction_id")
      .in("transaction_id", transactionIds)
      .order("uploaded_at", { ascending: false })
    
    transactionDocuments = data ?? []
  }

  // 4. Query document_checklist if transactionIds exist
  let documentChecklist: any[] = []
  if (transactionIds.length > 0) {
    const { data } = await supabase
      .from("document_checklist")
      .select("id, item_name, required, status, due_date, notes, transaction_id")
      .in("transaction_id", transactionIds)
      .order("due_date", { ascending: true })
    
    documentChecklist = data ?? []
  }

  return (
    <DocumentsClient
      contactId={contactId}
      clientDocuments={clientDocuments ?? []}
      transactionDocuments={transactionDocuments}
      documentChecklist={documentChecklist}
    />
  )
}
