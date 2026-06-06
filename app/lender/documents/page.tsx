import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Folder, ArrowLeft, FileText } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function LenderDocumentsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: documents } = await supabase
    .from('documents')
    .select('id, title, document_type, status, created_at, storage_url')
    .order('created_at', { ascending: false })
    .limit(30)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/lender/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Folder className="w-6 h-6 text-yellow-600" />
            Loan Documents
          </h1>
          <p className="text-gray-500 text-sm">{documents?.length || 0} documents</p>
        </div>
      </div>
      {(!documents || documents.length === 0) ? (
        <Card><CardContent className="text-center py-12 text-gray-500">No documents found</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {documents.map((doc: any) => (
            <Card key={doc.id}>
              <CardContent className="p-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <FileText className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className="text-sm font-medium">{doc.title || 'Untitled Document'}</p>
                    <p className="text-xs text-gray-500">{doc.document_type} · {new Date(doc.created_at).toLocaleDateString()}</p>
                  </div>
                </div>
                {doc.storage_url ? (
                  <a href={doc.storage_url} target="_blank" rel="noopener noreferrer">
                    <Button size="sm" variant="outline">View</Button>
                  </a>
                ) : (
                  <Button size="sm" variant="outline" disabled>View</Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
