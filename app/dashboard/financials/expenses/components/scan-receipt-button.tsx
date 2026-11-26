"use client"

// SCAN A RECEIPT (wave 152, lane 152D). A photo, a PDF or a saved email receipt goes to scanReceiptForReview
// (app/actions/financials.ts), which reads it, proposes the expense fields with page evidence and HOLDS them for a
// person — then this opens the side-by-side review. Nothing is recorded from this button alone.

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Camera, Loader2 } from "lucide-react"
import { scanReceiptForReview } from "@/app/actions/financials"

interface Message { whatHappened: string; whatItAffects: string; saved: string; whoActs: string; action: string }

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? "").replace(/^data:[^;]+;base64,/, ""))
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsDataURL(file)
  })
}

export function ScanReceiptButton() {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  async function onPick(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setMessage(null)
    try {
      const base64 = await toBase64(file)
      const result = await scanReceiptForReview({ base64, mimeType: file.type || "application/octet-stream", fileName: file.name })
      if (result.documentId) {
        router.push(`/dashboard/financials/expenses/receipts/${result.documentId}`)
        return
      }
      setMessage(result.message)
    } catch {
      setMessage({ whatHappened: "Your receipt could not be uploaded.", whatItAffects: "Nothing was recorded.", saved: "Nothing was saved.", whoActs: "Please try again in a moment.", action: "Try again" })
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ""
    }
  }

  return (
    <div className="relative">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,application/pdf,text/plain,text/html"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0])}
      />
      <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Camera className="w-4 h-4 mr-1" />}
        {busy ? "Reading receipt…" : "Scan receipt"}
      </Button>
      {message && (
        <div role="status" className="absolute right-0 z-10 mt-2 w-80 rounded-md border bg-background p-3 text-xs shadow-md space-y-1">
          <p className="font-medium">{message.whatHappened}</p>
          <p className="text-muted-foreground">{message.whatItAffects} {message.saved}</p>
          <p className="text-muted-foreground">{message.whoActs}</p>
          <button type="button" className="text-blue-600 hover:underline" onClick={() => { setMessage(null); input.current?.click() }}>{message.action}</button>
        </div>
      )}
    </div>
  )
}
