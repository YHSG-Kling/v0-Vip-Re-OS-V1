"use client"

/**
 * OutsideAgentShowingForm — embedded on the listing's public page so a buyer
 * agent at ANOTHER brokerage can request a showing without portal access.
 * Captures their license + brokerage so the in-house listing agent has
 * everything they need to confirm.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, CheckCircle, ChevronDown, ChevronUp, Briefcase } from "lucide-react"
import { submitOutsideAgentShowingRequest } from "@/app/actions/outside-agent-showing"

interface Props {
  listingId: string
}

export function OutsideAgentShowingForm({ listingId }: Props) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle")
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus("submitting")
    setErrorMsg(null)
    const fd = new FormData(e.currentTarget)
    try {
      const result = await submitOutsideAgentShowingRequest({
        listingId,
        buyerAgentName:      String(fd.get("agent_name") ?? "").trim(),
        buyerAgentEmail:     String(fd.get("agent_email") ?? "").trim(),
        buyerAgentPhone:     String(fd.get("agent_phone") ?? "").trim(),
        buyerAgentLicense:   String(fd.get("agent_license") ?? "").trim() || undefined,
        buyerAgentBrokerage: String(fd.get("agent_brokerage") ?? "").trim() || undefined,
        preferredDate:       String(fd.get("preferred_date") ?? ""),
        preferredStartTime:  String(fd.get("preferred_time") ?? ""),
        message:             String(fd.get("notes") ?? "") || undefined,
        buyerName:           String(fd.get("buyer_name") ?? "") || undefined,
      })
      if (result.success) {
        setStatus("success")
      } else {
        setErrorMsg(result.error ?? "Submission failed")
        setStatus("error")
      }
    } catch {
      setErrorMsg("Submission failed. Please try again.")
      setStatus("error")
    }
  }

  if (status === "success") {
    return (
      <div className="rounded-lg border bg-emerald-50 px-4 py-6 text-center">
        <CheckCircle className="h-8 w-8 text-emerald-600 mx-auto mb-2" />
        <p className="font-semibold text-sm">Request sent</p>
        <p className="text-xs text-muted-foreground mt-1">
          The listing agent has been notified. They'll reach out to confirm or suggest an alternative time.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-background">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <Briefcase className="h-4 w-4 text-muted-foreground" />
          I'm a real estate agent representing a buyer
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {open && (
        <form onSubmit={handleSubmit} className="px-4 pb-4 pt-1 space-y-3 border-t">
          <p className="text-xs text-muted-foreground">
            For agent-to-agent showing requests. The listing agent will be notified directly and will follow up with you to confirm.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="agent_name" className="text-xs">Your name *</Label>
              <Input id="agent_name" name="agent_name" required className="mt-1 h-9" />
            </div>
            <div>
              <Label htmlFor="agent_brokerage" className="text-xs">Brokerage</Label>
              <Input id="agent_brokerage" name="agent_brokerage" className="mt-1 h-9" />
            </div>
            <div>
              <Label htmlFor="agent_email" className="text-xs">Email *</Label>
              <Input id="agent_email" name="agent_email" type="email" required className="mt-1 h-9" />
            </div>
            <div>
              <Label htmlFor="agent_phone" className="text-xs">Phone *</Label>
              <Input id="agent_phone" name="agent_phone" type="tel" required className="mt-1 h-9" />
            </div>
            <div>
              <Label htmlFor="agent_license" className="text-xs">License #</Label>
              <Input id="agent_license" name="agent_license" className="mt-1 h-9" />
            </div>
            <div>
              <Label htmlFor="buyer_name" className="text-xs">Buyer name (optional)</Label>
              <Input id="buyer_name" name="buyer_name" className="mt-1 h-9" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="preferred_date" className="text-xs">Preferred date *</Label>
              <Input id="preferred_date" name="preferred_date" type="date" required className="mt-1 h-9" />
            </div>
            <div>
              <Label htmlFor="preferred_time" className="text-xs">Preferred time *</Label>
              <Input id="preferred_time" name="preferred_time" type="time" required className="mt-1 h-9" />
            </div>
          </div>

          <div>
            <Label htmlFor="notes" className="text-xs">Notes (optional)</Label>
            <Textarea id="notes" name="notes" rows={2} className="mt-1 text-sm" placeholder="Anything the listing agent should know" />
          </div>

          {status === "error" && errorMsg && (
            <p className="text-xs text-red-600">{errorMsg}</p>
          )}

          <Button type="submit" disabled={status === "submitting"} className="w-full">
            {status === "submitting"
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Sending…</>
              : "Send showing request"}
          </Button>
        </form>
      )}
    </div>
  )
}
