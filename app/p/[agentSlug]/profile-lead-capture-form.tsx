"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react"
import { captureProfileLead } from "@/app/actions/agent-public-profile"

interface Props {
  agentId: string
  agentUserId: string
  brokerageId: string
  agentName: string
  brand: string
}

export function ProfileLeadCaptureForm({
  agentId,
  agentUserId,
  brokerageId,
  agentName,
  brand,
}: Props) {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [message, setMessage] = useState("")
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim() || (!email.trim() && !phone.trim()) || !consent) {
      setError("Name, contact info, and consent are required")
      return
    }
    setSubmitting(true)
    const result = await captureProfileLead({
      agentId,
      agentUserId,
      brokerageId,
      fullName: name.trim(),
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      message: message.trim() || undefined,
      consentToContact: consent,
    })
    setSubmitting(false)
    if (result.success) {
      setSubmitted(true)
    } else {
      setError(result.error ?? "Submission failed")
    }
  }

  if (submitted) {
    return (
      <div className="text-center py-3 space-y-2">
        <CheckCircle2 className="h-8 w-8 text-green-600 mx-auto" />
        <p className="text-sm font-medium">Thanks, {name.split(" ")[0]}!</p>
        <p className="text-xs text-gray-600">
          {agentName.split(" ")[0]} will reach out shortly.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <Label htmlFor="profile-name" className="text-xs">Full Name</Label>
        <Input
          id="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="mt-1 h-9"
        />
      </div>
      <div>
        <Label htmlFor="profile-email" className="text-xs">Email</Label>
        <Input
          id="profile-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 h-9"
        />
      </div>
      <div>
        <Label htmlFor="profile-phone" className="text-xs">Phone</Label>
        <Input
          id="profile-phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="mt-1 h-9"
        />
      </div>
      <div>
        <Label htmlFor="profile-msg" className="text-xs">Message (optional)</Label>
        <Input
          id="profile-msg"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What can I help with?"
          className="mt-1 h-9"
        />
      </div>

      <label className="flex items-start gap-2 text-[11px] text-gray-600 pt-1">
        <Checkbox
          checked={consent}
          onCheckedChange={(c) => setConsent(Boolean(c))}
          className="mt-0.5"
        />
        <span>
          I agree to be contacted by {agentName} about real estate services via the
          contact methods I provided. I understand I can opt out at any time.
        </span>
      </label>

      {error && (
        <p className="text-xs text-red-600 flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      )}

      <Button
        type="submit"
        disabled={submitting}
        className="w-full text-white gap-1.5"
        style={{ backgroundColor: brand }}
      >
        {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Send Message
      </Button>
    </form>
  )
}
