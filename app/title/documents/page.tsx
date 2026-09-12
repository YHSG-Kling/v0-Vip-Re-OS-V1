import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FileText, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function TitleDocumentsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // SCOPE. This page used to select from `documents` with no filter at all, so a
  // title company saw every document the brokerage tenant holds. Documents are now
  // read off the title company's OWN files, resolved the same way getTitleDashboard
  // resolves them: title_company_users (this signed-in user) → the escrow rows that
  // name that company's email → those transactions' documents.
  const { data: titleUser, error: titleUserError } = await supabase
    .from('title_company_users')
    .select('id, email')
    .eq('user_id', user.id)
    .maybeSingle()

  let transactionIds: string[] = []
  let escrowError: string | null = titleUserError?.message ?? null

  if (titleUser?.email) {
    const { data: escrowRows, error } = await supabase
      .from('transaction_title_escrow')
      .select('transaction_id')
      .eq('title_company_email', titleUser.email)
    if (error) escrowError = error.message
    else transactionIds = (escrowRows ?? []).map((r) => r.transaction_id).filter(Boolean) as string[]
  }

  let documents: Array<{
    id: string
    doc_type: string | null
    doc_label: string | null
    status: string | null
    created_at: string | null
    storage_url: string | null
  }> = []
  let loadError: string | null = escrowError

  if (!loadError && transactionIds.length > 0) {
    const { data, error } = await supabase
      .from('transaction_documents')
      .select('id, doc_type, doc_label, status, created_at, storage_url')
      .in('transaction_id', transactionIds)
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
                  <FileText className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className="text-sm font-medium">{doc.doc_label || doc.doc_type || 'Untitled'}</p>
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
                  // No storage_url means there is no file to open. A disabled "View"
                  // button promised an action that does not exist.
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
