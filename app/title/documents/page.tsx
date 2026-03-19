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

  const { data: documents } = await supabase
    .from('documents')
    .select('id, title, document_type, status, created_at')
    .order('created_at', { ascending: false })
    .limit(30)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/title/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <FileText className="w-6 h-6 text-blue-600" />
          Title Documents
        </h1>
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
                    <p className="text-sm font-medium">{doc.title || 'Untitled'}</p>
                    <p className="text-xs text-gray-500">{doc.document_type} · {new Date(doc.created_at).toLocaleDateString()}</p>
                  </div>
                </div>
                <Button size="sm" variant="outline">View</Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
