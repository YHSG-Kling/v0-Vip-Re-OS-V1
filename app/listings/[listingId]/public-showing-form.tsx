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

type RepresentationStatus = "unrepresented" | "represented" | "prefer_not_to_say"

export function PublicShowingForm({ listingId }: Props) {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle")
  const [agentName, setAgentName] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // NAR Code of Ethics Article 16 — captured here so the listing agent doesn't auto-take
  // a buyer who already has another agent. Server side blocks conversion when "represented".
  const [representation, setRepresentation] = useState<RepresentationStatus | "">("")

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!representation) {
      setErrorMsg("Please tell us whether you're currently working with another real estate agent.")
      setStatus("error")
      return
    }
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
        representationStatus: representation,
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

      <fieldset className="space-y-1.5 border-t border-blue-100 pt-2">
        <legend className="text-xs font-medium text-blue-900">
          Are you currently working with another real estate agent? *
        </legend>
        {[
          { value: "unrepresented",     label: "No, I'm not working with an agent" },
          { value: "represented",       label: "Yes, I have an agent already" },
          { value: "prefer_not_to_say", label: "Prefer not to say" },
        ].map(opt => (
          <label key={opt.value} className="flex items-center gap-2 cursor-pointer text-xs text-blue-800">
            <input
              type="radio"
              name="representation"
              value={opt.value}
              checked={representation === opt.value}
              onChange={() => setRepresentation(opt.value as RepresentationStatus)}
              className="h-3.5 w-3.5"
            />
            <span>{opt.label}</span>
          </label>
        ))}
        {representation === "represented" && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 leading-snug">
            Thanks — we'll forward your showing request without taking you on as a buyer,
            so your existing agent can coordinate the tour.
          </p>
        )}
      </fieldset>

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
