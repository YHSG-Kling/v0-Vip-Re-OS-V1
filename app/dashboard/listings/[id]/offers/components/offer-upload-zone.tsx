"use client"

import { useState, useCallback, useRef } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { UploadCloud, FileText, Loader2, CheckCircle2, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"

interface Props {
  listingId: string
  brokerageId: string
  onUploadComplete: (offer: unknown) => void
}

type UploadState = "idle" | "uploading" | "extracting" | "done" | "error"

export function OfferUploadZone({ listingId, brokerageId, onUploadComplete }: Props) {
  const [state, setState] = useState<UploadState>("idle")
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function uploadFile(file: File) {
    if (file.type !== "application/pdf") {
      setError("Only PDF files are accepted")
      setState("error")
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("File exceeds the 20 MB limit")
      setState("error")
      return
    }

    setFileName(file.name)
    setError(null)
    setState("uploading")
    setProgress(20)

    // We need a contact_id — for now we pass a placeholder that the agent fills in.
    // In a full flow this would come from a "select buyer" dropdown first.
    // Here we read from the form data.
    const contactIdInput = document.getElementById("offer-contact-id") as HTMLInputElement | null
    const contactId = contactIdInput?.value?.trim()
    if (!contactId) {
      setError("Please enter the buyer contact ID before uploading")
      setState("error")
      return
    }

    const formData = new FormData()
    formData.append("file", file)
    formData.append("listing_id", listingId)
    formData.append("contact_id", contactId)

    setProgress(50)

    const res = await fetch("/api/offers/upload", { method: "POST", body: formData })
    const json = await res.json()

    if (!res.ok || !json.success) {
      setError(json.error ?? "Upload failed")
      setState("error")
      return
    }

    setProgress(80)
    setState("extracting")

    // Poll extraction status every 3 s, up to 60 s
    const offerId = json.offer_id
    let attempts = 0
    const maxAttempts = 20

    const poll = async () => {
      attempts++
      const { createClient } = await import("@/lib/supabase/client")
      const supabase = createClient()
      const { data: offer } = await supabase
        .from("offers")
        .select("id, ai_extraction_status, offer_price, status")
        .eq("id", offerId)
        .single()

      if (offer?.ai_extraction_status === "completed") {
        setProgress(100)
        setState("done")
        onUploadComplete(offer)
        return
      }

      if (offer?.ai_extraction_status === "failed" || attempts >= maxAttempts) {
        setProgress(100)
        setState("done")
        onUploadComplete(offer)   // still notify — user can edit manually
        return
      }

      setTimeout(poll, 3000)
    }

    setTimeout(poll, 3000)
  }

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) uploadFile(file)
    },
    [listingId, brokerageId]
  )

  return (
    <div className="flex flex-col gap-4 max-w-xl">
      {/* Contact ID input — required before upload */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="offer-contact-id" className="text-sm font-medium text-foreground">
          Buyer Contact ID
        </label>
        <input
          id="offer-contact-id"
          type="text"
          placeholder="UUID of the buyer contact record"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <p className="text-xs text-muted-foreground">Find this in the Contacts section of the dashboard.</p>
      </div>

      {/* Drop zone */}
      <Card
        className={cn(
          "border-2 border-dashed cursor-pointer transition-colors",
          isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/60",
          (state === "uploading" || state === "extracting") && "pointer-events-none opacity-60"
        )}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <CardContent className="flex flex-col items-center justify-center gap-3 py-12">
          {state === "idle" || state === "error" ? (
            <>
              <UploadCloud className="h-10 w-10 text-muted-foreground" />
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">
                  Drag and drop a PDF or click to browse
                </p>
                <p className="text-xs text-muted-foreground mt-1">PDF only, max 20 MB</p>
              </div>
              {error && (
                <div className="flex items-center gap-1.5 text-destructive text-sm">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </div>
              )}
            </>
          ) : state === "uploading" ? (
            <>
              <FileText className="h-10 w-10 text-primary" />
              <p className="text-sm font-medium">{fileName}</p>
              <p className="text-xs text-muted-foreground">Uploading to secure storage...</p>
              <Progress value={progress} className="w-48" />
            </>
          ) : state === "extracting" ? (
            <>
              <Loader2 className="h-10 w-10 text-primary animate-spin" />
              <p className="text-sm font-medium">AI extracting offer terms...</p>
              <p className="text-xs text-muted-foreground">This takes 10–30 seconds</p>
              <Progress value={progress} className="w-48" />
            </>
          ) : (
            <>
              <CheckCircle2 className="h-10 w-10 text-green-500" />
              <p className="text-sm font-medium text-foreground">Offer uploaded and extracted</p>
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => { e.stopPropagation(); setState("idle"); setProgress(0) }}
              >
                Upload another
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f) }}
      />
    </div>
  )
}
