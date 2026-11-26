import { documentOpenHref } from "@/lib/storage/signed-doc-url"
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FileText, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { IssuerCorrectionButton } from '@/app/lender/documents/issuer-correction-button'

export const dynamic = 'force-dynamic'

export default async function TitleDocumentsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // SCOPE. This page used to select from `documents` with no filter at all, so a
  // title company saw every document the brokerage tenant holds. Documents are now
  // read off the title company's OWN files, resolved the same way getTitleDashboard
  // resolves them: the session's TITLE VENDOR seat (lib/kernel/portal-auth.ts
  // resolveTitleVendorActor — title is a vendor category, CLAUDE.md §4) → the
  // transactions that vendor is assigned to in its tenant (vendor_assignments) →
  // those transactions' documents. TOMBSTONE (wave 155, lane 155T3): this used to
  // read title_company_users (0 rows, no writer) and match escrow rows by email.
  const { resolveTitleVendorActor } = await import('@/lib/kernel/portal-auth')
  const { titleVendorTransactionIds } = await import('@/lib/kernel/lender-linkage')
  const seat = await resolveTitleVendorActor(supabase, null)
  const titleUser = seat.ok ? seat.actor : null

  let transactionIds: string[] = []
  let escrowError: string | null = !seat.ok && seat.reason === 'refused' ? seat.detail : null

  if (titleUser) {
    const own = await titleVendorTransactionIds(supabase, titleUser.vendorId, titleUser.brokerageId)
    if (!own.ok) escrowError = own.error
    else transactionIds = own.ids
  }

  let documents: Array<{
    id: string
    doc_type: string | null
    doc_label: string | null
    status: string | null
    created_at: string | null
    storage_url: string | null
    transaction_id: string
  }> = []
  let loadError: string | null = escrowError

  if (!loadError && transactionIds.length > 0) {
    const { data, error } = await supabase
      .from('transaction_documents')
      .select('id, doc_type, doc_label, status, created_at, storage_url, transaction_id')
      .in('transaction_id', transactionIds)
      .eq('brokerage_id', titleUser?.brokerageId ?? '')
      .order('created_at', { ascending: false })
      .limit(60)
    if (error) loadError = error.message
    else documents = data ?? []
  }

  // HONEST empty states — each names what was actually observed.
  const emptyMessage = !titleUser
    ? 'No title company record is linked to this signed-in account, so no files could be resolved.'
    : transactionIds.length === 0
      ? 'No transactions name this title company yet.'
      : 'No documents on your files.'

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/title/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <FileText className="w-6 h-6 text-blue-600" />
          Title Documents
        </h1>
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
                  <FileText className="w-4 h-4 text-gray-500" />
                  <div>
                    <p className="text-sm font-medium">{doc.doc_label || doc.doc_type || 'Untitled'}</p>
                    <p className="text-xs text-gray-500">
                      {doc.doc_type}
                      {doc.status ? ` · ${doc.status}` : ''}
                      {doc.created_at ? ` · ${new Date(doc.created_at).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {doc.storage_url ? (
                    <a href={documentOpenHref(doc.storage_url) ?? undefined} target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="outline">View</Button>
                    </a>
                  ) : (
                    // No storage_url means there is no file to open. A disabled "View"
                    // button promised an action that does not exist.
                    <span className="text-xs text-gray-500">No file attached</span>
                  )}
                  {/* WAVE 153 (lane 153D): title corrects ITS OWN document (the server checks issuer, assignment and tenant). */}
                  <IssuerCorrectionButton transactionId={doc.transaction_id} documentId={doc.id} as="title" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
