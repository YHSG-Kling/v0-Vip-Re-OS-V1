"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  FileText,
  Download,
  Eye,
  PenTool,
  Upload,
  FolderOpen,
  Clock,
  CheckCircle,
  AlertCircle,
  Loader2,
  X,
} from "lucide-react"

interface Document {
  id: string
  document_name: string
  document_type: string
  file_url: string
  signature_status: "not_required" | "pending_signature" | "signed"
  created_at: string
  uploaded_by: string
}

interface ClientDocumentsWidgetProps {
  contactId: string
  compact?: boolean
}

const isValidUUID = (id: string): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return uuidRegex.test(id)
}

const demoDocuments: Document[] = [
  {
    id: "demo-1",
    document_name: "Purchase Agreement.pdf",
    document_type: "contract",
    file_url: "#",
    signature_status: "pending_signature",
    created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    uploaded_by: "agent",
  },
  {
    id: "demo-2",
    document_name: "Pre-Approval Letter.pdf",
    document_type: "financial",
    file_url: "#",
    signature_status: "signed",
    created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    uploaded_by: "client",
  },
  {
    id: "demo-3",
    document_name: "Property Disclosure.pdf",
    document_type: "disclosure",
    file_url: "#",
    signature_status: "not_required",
    created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    uploaded_by: "agent",
  },
]

export function ClientDocumentsWidget({ contactId, compact = false }: ClientDocumentsWidgetProps) {
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const isDemo = !isValidUUID(contactId)

  useEffect(() => {
    loadDocuments()
  }, [contactId])

  const loadDocuments = async () => {
    if (isDemo) {
      setDocuments(demoDocuments)
      setLoading(false)
      return
    }

    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("client_documents")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })

      if (error) throw error
      setDocuments(data || [])
    } catch (error) {
      console.error("Error loading documents:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setSelectedFile(file)
    }
  }

  const handleUpload = async () => {
    if (!selectedFile) return

    setUploading(true)
    try {
      const supabase = createClient()

      // Upload file to storage
      const fileExt = selectedFile.name.split(".").pop()
      const fileName = `${contactId}/${Date.now()}.${fileExt}`

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from("client-documents")
        .upload(fileName, selectedFile)

      if (uploadError) throw uploadError

      // Get public URL
      const {
        data: { publicUrl },
      } = supabase.storage.from("client-documents").getPublicUrl(fileName)

      // Create document record
      const { error: insertError } = await supabase.from("client_documents").insert({
        contact_id: contactId,
        document_name: selectedFile.name,
        document_type: "client_upload",
        file_url: publicUrl,
        signature_status: "not_required",
        uploaded_by: "client",
      })

      if (insertError) throw insertError

      setSelectedFile(null)
      loadDocuments()
    } catch (error) {
      console.error("Error uploading document:", error)
    } finally {
      setUploading(false)
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "signed":
        return (
          <Badge className="bg-green-100 text-green-800">
            <CheckCircle className="w-3 h-3 mr-1" /> Signed
          </Badge>
        )
      case "pending_signature":
        return (
          <Badge className="bg-orange-100 text-orange-800">
            <AlertCircle className="w-3 h-3 mr-1" /> Needs Signature
          </Badge>
        )
      default:
        return null
    }
  }

  const isNew = (createdAt: string) => {
    const hoursSince = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60)
    return hoursSince < 48
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Loader2 className="w-8 h-8 animate-spin mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground mt-2">Loading documents...</p>
        </CardContent>
      </Card>
    )
  }

  if (compact) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <FolderOpen className="w-5 h-5" /> My Documents
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {documents.slice(0, 3).map((doc) => (
              <div key={doc.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-blue-600" />
                  <span className="text-sm font-medium truncate max-w-[150px]">{doc.document_name}</span>
                  {isNew(doc.created_at) && <Badge className="text-xs">NEW</Badge>}
                </div>
                <Button variant="ghost" size="sm">
                  <Eye className="w-4 h-4" />
                </Button>
              </div>
            ))}
            {documents.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No documents yet</p>
            )}
            {documents.length > 3 && (
              <p className="text-xs text-muted-foreground text-center">+{documents.length - 3} more documents</p>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Upload Section */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <Input
                type="file"
                onChange={handleFileSelect}
                accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                className="cursor-pointer"
              />
            </div>
            {selectedFile && (
              <>
                <span className="text-sm text-muted-foreground truncate max-w-[200px]">{selectedFile.name}</span>
                <Button variant="ghost" size="sm" onClick={() => setSelectedFile(null)}>
                  <X className="w-4 h-4" />
                </Button>
              </>
            )}
            <Button onClick={handleUpload} disabled={!selectedFile || uploading}>
              {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
              Upload
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Documents List */}
      {documents.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FolderOpen className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No documents yet</h3>
            <p className="text-muted-foreground">Upload your documents or wait for your agent to share files</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {documents.map((doc) => (
            <Card key={doc.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1">
                    <div className="p-2 bg-blue-50 rounded-lg">
                      <FileText className="w-5 h-5 text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="font-medium truncate">{doc.document_name}</h4>
                        {isNew(doc.created_at) && <Badge className="text-xs">NEW</Badge>}
                        {getStatusBadge(doc.signature_status)}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(doc.created_at).toLocaleDateString()}
                        </span>
                        <span>{doc.document_type}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm">
                      <Eye className="w-4 h-4 mr-1" /> View
                    </Button>
                    <Button variant="outline" size="sm">
                      <Download className="w-4 h-4 mr-1" /> Download
                    </Button>
                    {doc.signature_status === "pending_signature" && (
                      <Button size="sm">
                        <PenTool className="w-4 h-4 mr-1" /> Sign
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
