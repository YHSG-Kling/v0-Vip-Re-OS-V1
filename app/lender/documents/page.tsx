import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Folder, ArrowLeft, FileText } from 'lucide-react'
import Link from 'next/link'
import { lenderVendorForUser, lenderVendorTransactionIds } from '@/lib/kernel/lender-linkage'

export const dynamic = 'force-dynamic'

export default async function LenderDocumentsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // SCOPE. This page used to select from `documents` with no filter at all, so a
  // lender saw every document their brokerage tenant holds — including deals they
  // are not on. Documents are now read off the lender's OWN deals: the vendor
  // identity (user_role_assignments.vendor_id → Lender-category vendor) and the
  // transactions that vendor is actually assigned to (vendor_assignments), which is
  // the same rail requireLenderVendorActor enforces per-transaction.
  const lenderVendor = await lenderVendorForUser(supabase, user.id)
  const transactionIds = lenderVendor
    ? await lenderVendorTransactionIds(supabase, lenderVendor.vendorId, lenderVendor.brokerageId)
    : []

  let documents: Array<{
    id: string
    doc_type: string | null
    doc_label: string | null
    status: string | null
    created_at: string | null
    storage_url: string | null
    transaction_id: string
  }> = []
  let loadError: string | null = null

  if (transactionIds.length > 0) {
    const { data, error } = await supabase
      .from('transaction_documents')
      .select('id, doc_type, doc_label, status, created_at, storage_url, transaction_id')
      .in('transaction_id', transactionIds)
      .order('created_at', { ascending: false })
      .limit(60)
    if (error) loadError = error.message
    else documents = data ?? []
  }

  // HONEST empty states — each one names what was actually observed, not a guess.
  const emptyMessage = !lenderVendor
    ? 'No lender vendor record is linked to this signed-in account, so no deals could be resolved.'
    : transactionIds.length === 0
      ? 'This lender is not assigned to any transaction yet.'
      : 'No documents on your assigned transactions.'

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/lender/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Folder className="w-6 h-6 text-yellow-600" />
            Loan Documents
          </h1>
          <p className="text-gray-500 text-sm">{documents.length} documents</p>
        </div>
      </div>
      {loadError ? (
        <Card>
          <CardContent className="text-center py-12 text-red-600 text-sm">
            Documents could not be loaded: {loadError}
          </CardContent>
        </Card>
      ) : documents.length === 0 ? (
        <Card><CardContent className="text-center py-12 text-gray-500">{emptyMessage}</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {documents.map((doc) => (
            <Card key={doc.id}>
              <CardContent className="p-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <FileText className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className="text-sm font-medium">{doc.doc_label || doc.doc_type || 'Untitled Document'}</p>
                    <p className="text-xs text-gray-500">
                      {doc.doc_type}
                      {doc.status ? ` · ${doc.status}` : ''}
                      {doc.created_at ? ` · ${new Date(doc.created_at).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                </div>
                {doc.storage_url ? (
                  <a href={doc.storage_url} target="_blank" rel="noopener noreferrer">
                    <Button size="sm" variant="outline">View</Button>
                  </a>
                ) : (
                  // No storage_url on the row means there is no file to open. A
                  // disabled "View" button promised an action that does not exist;
                  // state the observed fact instead.
                  <span className="text-xs text-gray-400">No file attached</span>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
