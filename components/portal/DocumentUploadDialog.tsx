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
import { useRouter } from "next/navigation"

interface DocumentUploadDialogProps {
  contactId: string
  transactionId?: string
  documentType?: string
  buttonText?: string
  buttonVariant?: "default" | "outline" | "ghost" | "destructive" | "secondary" | "link"
}

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

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      setError("File size must be less than 10MB")
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
      await uploadDocument(
        {
          name: file.name,
          type: file.type,
          size: file.size,
          base64,
        },
        contactId,
        transactionId
      )

      setProgress(100)
      setSuccess(true)

      // Refresh and close after delay
      setTimeout(() => {
        setOpen(false)
        setSuccess(false)
        setProgress(0)
        router.refresh()
      }, 1500)
    } catch (err: any) {
      console.error("[v0] Upload error:", err)
      const errorMessage = err?.message || "Failed to upload document"
      if (errorMessage.includes("storage") || errorMessage.includes("bucket")) {
        setError("Storage not configured. Please contact support.")
      } else if (errorMessage.includes("size")) {
        setError("File is too large. Maximum size is 10MB.")
      } else if (errorMessage.includes("type")) {
        setError("Invalid file type. Please upload PDF, JPG, or PNG.")
      } else {
        setError(`Upload failed: ${errorMessage}. Please try again.`)
      }
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
                <p className="text-green-600 font-medium">Document uploaded successfully!</p>
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
                <p className="text-xs text-muted-foreground mt-3">PDF, JPG, or PNG up to 10MB</p>
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
