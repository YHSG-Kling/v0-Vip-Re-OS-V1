"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { submitShowingRequest } from "@/app/actions/listing-landing"
import { Calendar, CheckCircle2, Loader2 } from "lucide-react"

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

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
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

          <p className="text-xs text-muted-foreground text-center">
            By submitting, you agree to be contacted about this property.
          </p>
        </form>
      </CardContent>
    </Card>
  )
}
