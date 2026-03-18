'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FileText, Download, CheckCircle2, AlertCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface DocumentTrackingPanelProps {
  brokerageId: string
}

export function DocumentTrackingPanel({ brokerageId }: DocumentTrackingPanelProps) {
  const [documents, setDocuments] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    const fetchDocuments = async () => {
      try {
        const { data } = await supabase
          .from('transaction_documents')
          .select(`
            id,
            transaction_id,
            document_type,
            filename,
            status,
            signed,
            uploaded_at,
            expires_at
          `)
          .eq('brokerage_id', brokerageId)
          .order('uploaded_at', { ascending: false })
          .limit(15)

        setDocuments(data || [])
      } catch (error) {
        console.error('Error fetching documents:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchDocuments()
  }, [brokerageId, supabase])

  const getStatusIcon = (signed: boolean, status: string) => {
    if (status === 'missing') return <AlertCircle className="h-4 w-4 text-destructive" />
    if (signed) return <CheckCircle2 className="h-4 w-4 text-green-600" />
    return <FileText className="h-4 w-4 text-gray-400" />
  }

  const signedCount = documents.filter(d => d.signed).length
  const missingCount = documents.filter(d => d.status === 'missing').length

  return (
    <Card className="border-l-4 border-l-purple-500">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Document Tracking</CardTitle>
            <CardDescription>Transaction documents and signatures</CardDescription>
          </div>
          <FileText className="h-5 w-5 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <div className="p-2 rounded-lg bg-green-50">
            <p className="text-xs text-muted-foreground">Signed</p>
            <p className="text-lg font-bold text-green-700">{signedCount}</p>
          </div>
          <div className="p-2 rounded-lg bg-red-50">
            <p className="text-xs text-muted-foreground">Missing</p>
            <p className="text-lg font-bold text-red-700">{missingCount}</p>
          </div>
        </div>

        <div className="space-y-2 max-h-80 overflow-y-auto">
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">Loading documents...</div>
          ) : documents.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No documents found</div>
          ) : (
            documents.map(doc => (
              <div
                key={doc.id}
                className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2 flex-1">
                  {getStatusIcon(doc.signed, doc.status)}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{doc.document_type}</p>
                    <p className="text-xs text-muted-foreground truncate">{doc.filename}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {doc.signed && <Badge className="bg-green-100 text-green-800">Signed</Badge>}
                  <Button variant="ghost" size="sm">
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
