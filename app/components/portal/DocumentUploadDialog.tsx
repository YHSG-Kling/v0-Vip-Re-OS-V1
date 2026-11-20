"use client"

import React from "react"

import { useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Upload, FileText, CheckCircle2, AlertCircle, Loader2 } from "lucide-react"
import { uploadDocument } from "@/app/actions/documents"
import { checkUpload } from "@/lib/storage/file-limits"
import { useRouter } from "next/navigation"

interface DocumentUploadDialogProps {
  contactId: string
  transactionId?: string
  documentType?: string
  buttonText?: string
  buttonVariant?: "default" | "outline" | "ghost" | "destructive" | "secondary" | "link"
}

// WAVE 152 (152J): the limit a client is shown is the gate's own ceiling for this transport (lib/storage/file-limits.ts),
// never a guessed figure — the old "up to 10MB" promised more than the server-action body can carry.
const UPLOAD_LIMIT_TEXT = `${Math.max(0.1, Math.floor((checkUpload({ bucket: "client-documents", transport: "server_action_base64", bytes: 0, contentType: "application/pdf" }).ceilingBytes / 1_048_576) * 10) / 10)} MB`

export function DocumentUploadDialog({
  contactId,
  transactionId,
  documentType,
  buttonText = "Upload Document",
  buttonVariant = "default",
}: DocumentUploadDialogProps) {
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const router = useRouter()

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true)
    } else if (e.type === "dragleave") {
      setDragActive(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0])
    }
  }, [])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0])
    }
  }

  const handleFile = async (file: File) => {
    // Validate file type
    const allowedTypes = ["application/pdf", "image/jpeg", "image/png", "image/jpg"]
    if (!allowedTypes.includes(file.type)) {
      setError("Please upload a PDF or image file (JPG, PNG)")
      return
    }

    // COURTESY ONLY — uploadDocument holds the real gate. "10MB" was
    // unreachable: the file is base64-encoded into a Server Action argument, and
    // Vercel caps a function request body at 4.5 MB ahead of the framework, so
    // ~3.4 MB of file is the true ceiling.
    const gate = checkUpload({
      bucket: "client-documents",
      transport: "server_action_base64",
      bytes: file.size,
      contentType: file.type,
    })
    if (!gate.ok) {
      // WAVE 152 (152J): the gate's reason is written for staff (it names the bucket and the transport cap); a client
      // reads the same words the server door returns (lib/portal/upload-feedback.ts).
      const limit = `${Math.max(0.1, Math.floor((gate.ceilingBytes / 1_048_576) * 10) / 10)} MB`
      setError(gate.refusedBy === "size"
        ? `This file is too large to upload here (the limit is ${limit}). Nothing was saved. Next step: upload a smaller copy, such as a PDF or a photo of each page.`
        : gate.refusedBy === "content_type"
          ? "This kind of file can't be uploaded here. Nothing was saved. Next step: save it as a PDF or a photo and upload that."
          : "We couldn't check this file before uploading it. Nothing was saved. Next step: choose the file again and upload it.")
      return
    }

    setUploading(true)
    setError(null)
    setProgress(10)

    try {
      // Convert file to base64
      const base64 = await fileToBase64(file)
      setProgress(30)

      // Upload document
      // uploadDocument reports failure BY RETURN, so the catch below — which
      // carefully translates storage/size errors — never saw the common case.
      // The bar filled to 100%, the dialog said uploaded, and nothing was.
      const r = await uploadDocument(
        {
          name: file.name,
          type: file.type,
          size: file.size,
          base64,
        },
        contactId,
        transactionId
      )
      if (!r?.success) {
        setError((r as any)?.error ?? "The document was not uploaded.")
        setProgress(0)
        return
      }

      setProgress(100)
      setSuccess(true)

      // Refresh and close after delay
      setTimeout(() => {
        setOpen(false)
        setSuccess(false)
        setProgress(0)
        router.refresh()
      }, 1500)
    } catch (err: unknown) {
      // WAVE 152 (152J): the upload action reports every failure BY RETURN in the presenter's words
      // (lib/portal/upload-feedback.ts), so this catch is only the request itself failing (the connection dropped, the
      // page went offline). The raw text stays in the console; the person reads what happened, that nothing was saved,
      // and what to do — never "Storage not configured", a guessed limit, or a provider string.
      console.error("[portal] Upload request failed:", err)
      setError("Your document didn't upload because the connection dropped before it finished. Nothing was saved. Next step: try again. If it keeps happening, your agent can help.")
      setProgress(0)
    } finally {
      setUploading(false)
    }
  }

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.readAsDataURL(file)
      reader.onload = () => {
        const result = reader.result as string
        // Remove data URL prefix
        const base64 = result.split(",")[1]
        resolve(base64)
      }
      reader.onerror = (error) => reject(error)
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={buttonVariant} className={buttonVariant === "outline" ? "bg-transparent" : ""}>
          <Upload className="h-4 w-4 mr-2" />
          {buttonText || `Upload ${documentType ? documentType.replace(/_/g, " ") : "Document"}`}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Document</DialogTitle>
          <DialogDescription>
            {documentType
              ? `Upload your ${documentType.replace(/_/g, " ")}`
              : "Upload documents for your transaction. Supported formats: PDF, JPG, PNG"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Drop Zone */}
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              dragActive ? "border-blue-500 bg-blue-50" : "border-muted-foreground/25"
            } ${uploading ? "pointer-events-none opacity-50" : "cursor-pointer"}`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => document.getElementById("file-upload")?.click()}
          >
            <input
              id="file-upload"
              type="file"
              className="hidden"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={handleFileSelect}
              disabled={uploading}
            />

            {success ? (
              <div className="flex flex-col items-center">
                <CheckCircle2 className="h-12 w-12 text-green-600 mb-3" />
                <p className="text-green-700 font-medium">Document uploaded successfully!</p>
                <p className="text-sm text-muted-foreground mt-1">AI is now analyzing your document...</p>
              </div>
            ) : uploading ? (
              <div className="flex flex-col items-center">
                <Loader2 className="h-12 w-12 text-blue-600 mb-3 animate-spin" />
                <p className="text-blue-600 font-medium">Uploading document...</p>
                <Progress value={progress} className="w-48 h-2 mt-3" />
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <FileText className="h-12 w-12 text-muted-foreground mb-3" />
                <p className="font-medium">Drop your document here</p>
                <p className="text-sm text-muted-foreground mt-1">or click to browse</p>
                <p className="text-xs text-muted-foreground mt-3">PDF, JPG, or PNG up to {UPLOAD_LIMIT_TEXT}</p>
              </div>
            )}
          </div>

          {/* Error Message */}
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-800">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          {/* AI Analysis Note */}
          <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="p-1 bg-blue-100 rounded">
              <FileText className="h-4 w-4 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-blue-800 font-medium">AI-Powered Analysis</p>
              <p className="text-xs text-blue-700 mt-0.5">
                Your document will be automatically analyzed and explained in plain English
              </p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
