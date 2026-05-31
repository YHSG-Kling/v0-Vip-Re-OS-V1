"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { submitShowingRequest } from "@/app/actions/listing-landing"
import { Checkbox } from "@/components/ui/checkbox"
import { Calendar, CheckCircle2, Loader2 } from "lucide-react"

type RepresentationStatus = "unrepresented" | "represented" | "prefer_not_to_say"

interface ShowingRequestFormProps {
  listingId: string
  sessionToken: string
  agentName: string
}

export function ShowingRequestForm({
  listingId,
  sessionToken,
  agentName,
}: ShowingRequestFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmedAgentName, setConfirmedAgentName] = useState<string>("")
  const [tcpaConsent, setTcpaConsent] = useState(false)
  // NAR Code of Ethics Article 16 — if the buyer already has an agent, our agent
  // can't take them on. We capture the disclosure here so the conversion gate
  // (app/actions/convert-outside-inquiry.ts) can refuse promotion later.
  const [representation, setRepresentation] = useState<RepresentationStatus | "">("")

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!representation) {
      setError("Please tell us whether you're currently working with another real estate agent.")
      return
    }
    setIsSubmitting(true)
    setError(null)

    const formData = new FormData(e.currentTarget)

    const result = await submitShowingRequest({
      listingId,
      firstName: formData.get("firstName") as string,
      lastName: formData.get("lastName") as string,
      phone: formData.get("phone") as string,
      email: formData.get("email") as string,
      preferredDateTime: formData.get("preferredDateTime") as string,
      notes: formData.get("notes") as string,
      sessionToken,
      tcpaConsent,
      representationStatus: representation,
    })

    setIsSubmitting(false)

    if (result.success) {
      setIsSuccess(true)
      setConfirmedAgentName(result.agentName || agentName)
    } else {
      setError(result.error || "Failed to submit request. Please try again.")
    }
  }

  if (isSuccess) {
    return (
      <Card id="showing-request-form" className="border-green-200 bg-green-50/50">
        <CardContent className="pt-6">
          <div className="flex flex-col items-center text-center gap-4">
            <div className="p-3 rounded-full bg-green-100">
              <CheckCircle2 className="h-8 w-8 text-green-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground">Request Sent!</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {confirmedAgentName} will confirm your showing soon.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card id="showing-request-form">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          Schedule a Showing
        </CardTitle>
        <CardDescription>
          Fill out the form below and {agentName} will contact you to confirm.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="firstName">First Name *</Label>
              <Input
                id="firstName"
                name="firstName"
                required
                placeholder="John"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">Last Name *</Label>
              <Input
                id="lastName"
                name="lastName"
                required
                placeholder="Doe"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone">Phone *</Label>
            <Input
              id="phone"
              name="phone"
              type="tel"
              required
              placeholder="(555) 123-4567"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email *</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              placeholder="john@example.com"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="preferredDateTime">Preferred Date & Time *</Label>
            <Input
              id="preferredDateTime"
              name="preferredDateTime"
              type="datetime-local"
              required
              min={new Date().toISOString().slice(0, 16)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes (Optional)</Label>
            <Textarea
              id="notes"
              name="notes"
              placeholder="Any special requests or questions..."
              rows={3}
            />
          </div>

          {/* Representation disclosure — NAR Code of Ethics Article 16. {agentName}
              can only take on a buyer who is not already represented; the disclosure
              determines whether this inquiry is routed for representation or just
              forwarded to the buyer's existing agent. */}
          <fieldset className="space-y-2 border-t pt-3">
            <legend className="text-sm font-medium">
              Are you currently working with another real estate agent? *
            </legend>
            <div className="space-y-1.5">
              {[
                { value: "unrepresented",       label: "No, I'm not working with an agent" },
                { value: "represented",         label: "Yes, I have an agent already" },
                { value: "prefer_not_to_say",   label: "Prefer not to say" },
              ].map(opt => (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer text-sm">
                  <input
                    type="radio"
                    name="representation"
                    value={opt.value}
                    checked={representation === opt.value}
                    onChange={() => setRepresentation(opt.value as RepresentationStatus)}
                    className="h-4 w-4"
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
            {representation === "represented" && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                Thanks for letting us know. {agentName} won't be able to take you on as a
                buyer (NAR Code of Ethics requires us to honor your existing agency
                relationship), but we'll still pass your showing request along so your
                agent can coordinate the tour with us.
              </p>
            )}
          </fieldset>

          {/* TCPA consent — governs channel permission, not lead creation */}
          <label className="flex items-start gap-2 cursor-pointer">
            <Checkbox
              id="tcpa-showing"
              checked={tcpaConsent}
              onCheckedChange={(v) => setTcpaConsent(!!v)}
              className="mt-0.5 shrink-0"
            />
            <span className="text-xs text-muted-foreground leading-relaxed">
              I agree to receive calls, texts, and emails from {agentName} and this brokerage regarding
              real estate services. Consent is not required for purchase. Message and data rates may apply.
            </span>
          </label>

          {!tcpaConsent && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              Without consent, we can only follow up by email.
            </p>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Submitting...
              </>
            ) : (
              "Request Showing"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
