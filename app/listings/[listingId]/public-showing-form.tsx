"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, CheckCircle } from "lucide-react"
import { submitShowingRequest } from "@/app/actions/listing-landing"

interface Props {
  listingId: string
}

export function PublicShowingForm({ listingId }: Props) {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle")
  const [agentName, setAgentName] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus("submitting")
    setErrorMsg(null)

    const fd = new FormData(e.currentTarget)

    try {
      const result = await submitShowingRequest({
        listingId,
        firstName: String(fd.get("first_name") ?? ""),
        lastName: String(fd.get("last_name") ?? ""),
        phone: String(fd.get("phone") ?? "").trim(),
        email: String(fd.get("email") ?? ""),
        preferredDateTime: String(fd.get("preferred_date") ?? ""),
        notes: String(fd.get("notes") ?? "") || undefined,
        sessionToken: crypto.randomUUID(),
        tcpaConsent: fd.get("tcpa_consent") === "on",
      })

      if (result.success) {
        setAgentName(result.agentName ?? null)
        setStatus("success")
      } else {
        setErrorMsg(result.error ?? "Something went wrong. Please try again.")
        setStatus("error")
      }
    } catch {
      setErrorMsg("Something went wrong. Please try again.")
      setStatus("error")
    }
  }

  if (status === "success") {
    return (
      <div className="text-center py-4">
        <CheckCircle className="h-10 w-10 text-green-500 mx-auto mb-3" />
        <p className="font-semibold text-gray-900 text-sm">Showing Request Submitted!</p>
        <p className="text-xs text-gray-600 mt-1">
          {agentName ? `${agentName} will` : "The listing agent will"} be in touch shortly to
          confirm your showing.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="showing-first-name" className="text-xs text-blue-800">
            First Name
          </Label>
          <Input
            id="showing-first-name"
            name="first_name"
            required
            placeholder="Jane"
            className="h-8 text-sm bg-white border-blue-200"
          />
        </div>
        <div>
          <Label htmlFor="showing-last-name" className="text-xs text-blue-800">
            Last Name
          </Label>
          <Input
            id="showing-last-name"
            name="last_name"
            required
            placeholder="Smith"
            className="h-8 text-sm bg-white border-blue-200"
          />
        </div>
      </div>

      <div>
        <Label htmlFor="showing-email" className="text-xs text-blue-800">
          Email
        </Label>
        <Input
          id="showing-email"
          name="email"
          type="email"
          required
          placeholder="jane@email.com"
          className="h-8 text-sm bg-white border-blue-200"
        />
      </div>

      <div>
        <Label htmlFor="showing-phone" className="text-xs text-blue-800">
          Phone
        </Label>
        <Input
          id="showing-phone"
          name="phone"
          type="tel"
          placeholder="(555) 000-0000"
          className="h-8 text-sm bg-white border-blue-200"
        />
      </div>

      <div>
        <Label htmlFor="showing-date" className="text-xs text-blue-800">
          Preferred Date &amp; Time
        </Label>
        <Input
          id="showing-date"
          name="preferred_date"
          type="datetime-local"
          required
          className="h-8 text-sm bg-white border-blue-200"
        />
      </div>

      <div>
        <Label htmlFor="showing-notes" className="text-xs text-blue-800">
          Notes (optional)
        </Label>
        <Textarea
          id="showing-notes"
          name="notes"
          rows={2}
          placeholder="Any special requests or questions?"
          className="text-sm bg-white border-blue-200 resize-none"
        />
      </div>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          name="tcpa_consent"
          className="mt-0.5 h-3.5 w-3.5 rounded border-gray-300"
        />
        <span className="text-xs text-blue-700 leading-snug">
          I agree to receive calls, texts, and emails regarding this property. Consent is not
          required to schedule a showing.
        </span>
      </label>

      {errorMsg && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          {errorMsg}
        </p>
      )}

      <Button
        type="submit"
        className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm h-9"
        disabled={status === "submitting"}
      >
        {status === "submitting" ? (
          <>
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            Submitting…
          </>
        ) : (
          "Request Showing"
        )}
      </Button>
    </form>
  )
}
