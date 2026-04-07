"use client"

import { useState, useCallback } from "react"
import { useDropzone } from "react-dropzone"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Upload, FileText, CheckCircle2, AlertCircle, X, Download } from "lucide-react"
import { uploadLenderDocument } from "@/app/actions/lender-portal-actions"
import { createClient } from "@/lib/supabase/client"

interface Document {
  id: string
  document_type: string
  file_name: string
  file_url?: string
  created_at: string
}

const DOCUMENT_TYPES = [
  { value: "loan_commitment", label: "Loan Commitment Letter" },
  { value: "appraisal", label: "Appraisal Report" },
  { value: "closing_disclosure", label: "Closing Disclosure" },
  { value: "loan_conditions", label: "Loan Conditions / Requirements" },
] as const

type DocumentType = typeof DOCUMENT_TYPES[number]["value"]

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function LenderDocumentUpload({
  transactionId,
  lenderId,
  existingDocuments,
}: {
  transactionId: string
  lenderId: string
  existingDocuments: Document[]
}) {
  const [selectedType, setSelectedType] = useState<DocumentType>("loan_commitment")
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length === 0) return

      const file = acceptedFiles[0]
      setUploading(true)
      setError(null)
      setSuccess(false)
      setUploadProgress(0)

      try {
        const progressInterval = setInterval(() => {
          setUploadProgress((prev) => Math.min(prev + 10, 90))
        }, 100)

        // Upload to Supabase Storage — real path, never a local placeholder
        const supabase = createClient()
        const filePath = `transactions/${transactionId}/lender/${Date.now()}_${file.name}`
        const { error: uploadErr } = await supabase.storage
          .from("transaction-documents")
          .upload(filePath, file, { upsert: false, contentType: file.type })

        if (uploadErr) {
          setError(`Upload failed: ${uploadErr.message}`)
          clearInterval(progressInterval)
          return
        }

        const { data: { publicUrl } } = supabase.storage
          .from("transaction-documents")
          .getPublicUrl(filePath)

        await uploadLenderDocument({
          transactionId,
          lenderId,
          documentType: selectedType,
          fileName: file.name,
          fileUrl: publicUrl,
        })

        clearInterval(progressInterval)
        setUploadProgress(100)
        setSuccess(true)

        // Reset after 2 seconds
        setTimeout(() => {
          setSuccess(false)
          setUploadProgress(0)
        }, 2000)
      } catch (err: any) {
        setError(err.message || "Upload failed")
      } finally {
        setUploading(false)
      }
    },
    [transactionId, lenderId, selectedType]
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "image/*": [".png", ".jpg", ".jpeg"],
      "application/msword": [".doc"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    },
    maxFiles: 1,
    disabled: uploading,
  })

  // Group documents by type
  const documentsByType = DOCUMENT_TYPES.map((type) => ({
    ...type,
    documents: existingDocuments.filter((d) => d.document_type === type.value),
  }))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5" />
          Document Upload
        </CardTitle>
        <CardDescription>Upload loan documents for this transaction</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Document Type Selection */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Document Type</label>
          <Select value={selectedType} onValueChange={(v) => setSelectedType(v as DocumentType)}>
            <SelectTrigger>
              <SelectValue placeholder="Select document type" />
            </SelectTrigger>
            <SelectContent>
              {DOCUMENT_TYPES.map((type) => (
                <SelectItem key={type.value} value={type.value}>
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Dropzone */}
        <div
          {...getRootProps()}
          className={`
            border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
            ${isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50"}
            ${uploading ? "opacity-50 cursor-not-allowed" : ""}
          `}
        >
          <input {...getInputProps()} />
          {uploading ? (
            <div className="space-y-3">
              <div className="animate-pulse">
                <Upload className="h-10 w-10 mx-auto text-primary" />
              </div>
              <p className="text-sm font-medium">Uploading...</p>
              <Progress value={uploadProgress} className="w-48 mx-auto" />
            </div>
          ) : success ? (
            <div className="space-y-2">
              <CheckCircle2 className="h-10 w-10 mx-auto text-green-600" />
              <p className="text-sm font-medium text-green-600">Upload successful!</p>
            </div>
          ) : (
            <div className="space-y-2">
              <Upload className="h-10 w-10 mx-auto text-muted-foreground" />
              <p className="text-sm font-medium">
                {isDragActive ? "Drop the file here" : "Drag and drop a file, or click to browse"}
              </p>
              <p className="text-xs text-muted-foreground">PDF, DOC, DOCX, PNG, JPG accepted</p>
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-2 text-red-600 text-sm">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        {/* Existing Documents */}
        <div className="space-y-4">
          <h4 className="font-medium text-sm">Uploaded Documents</h4>
          {documentsByType.map((type) => (
            <div key={type.value}>
              {type.documents.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">{type.label}</p>
                  {type.documents.map((doc) => (
                    <div
                      key={doc.id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{doc.file_name}</p>
                          <p className="text-xs text-muted-foreground">{formatDate(doc.created_at)}</p>
                        </div>
                      </div>
                      {doc.file_url && (
                        <Button variant="ghost" size="icon" asChild>
                          <a href={doc.file_url} target="_blank" rel="noopener noreferrer">
                            <Download className="h-4 w-4" />
                          </a>
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {existingDocuments.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No documents uploaded yet</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
