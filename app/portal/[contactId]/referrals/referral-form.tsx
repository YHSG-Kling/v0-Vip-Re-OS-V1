"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CheckCircle2, Loader2, PartyPopper } from "lucide-react"
import { submitReferral } from "@/app/actions/portal-lifetime"

interface ReferralFormProps {
  contactId: string
}

export function ReferralForm({ contactId }: ReferralFormProps) {
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [relationship, setRelationship] = useState("")
  const [notes, setNotes] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || (!phone.trim() && !email.trim())) return

    setIsSubmitting(true)
    setError(null)

    try {
      const contactInfo = phone.trim() || email.trim()
      await submitReferral({
        contactId,
        referredName: name.trim(),
        referredContact: contactInfo,
        relationship: relationship || undefined,
      })
      setIsSubmitted(true)
      // Reset form after short delay
      setTimeout(() => {
        setName("")
        setPhone("")
        setEmail("")
        setRelationship("")
        setNotes("")
      }, 500)
    } catch (err) {
      setError("Failed to submit referral. Please try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  const resetForm = () => {
    setIsSubmitted(false)
    setName("")
    setPhone("")
    setEmail("")
    setRelationship("")
    setNotes("")
    setError(null)
  }

  if (isSubmitted) {
    return (
      <div className="text-center py-8 space-y-4">
        <div className="relative inline-block">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto">
            <PartyPopper className="h-8 w-8 text-green-600" />
          </div>
        </div>
        <div>
          <p className="text-lg font-semibold text-green-800">Thank you!</p>
          <p className="text-muted-foreground">
            Your agent will reach out to {name} soon.
          </p>
        </div>
        <Button variant="outline" onClick={resetForm}>
          Submit Another Referral
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="referral-name">Their Name *</Label>
        <Input
          id="referral-name"
          placeholder="John Smith"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={isSubmitting}
          required
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="referral-phone">Phone</Label>
          <Input
            id="referral-phone"
            type="tel"
            placeholder="(555) 123-4567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={isSubmitting}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="referral-email">Email</Label>
          <Input
            id="referral-email"
            type="email"
            placeholder="john@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isSubmitting}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="referral-relationship">Relationship</Label>
        <Select value={relationship} onValueChange={setRelationship} disabled={isSubmitting}>
          <SelectTrigger id="referral-relationship">
            <SelectValue placeholder="How do you know them?" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="friend">Friend</SelectItem>
            <SelectItem value="family">Family Member</SelectItem>
            <SelectItem value="coworker">Coworker</SelectItem>
            <SelectItem value="neighbor">Neighbor</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={isSubmitting || !name.trim() || (!phone.trim() && !email.trim())}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Submitting...
          </>
        ) : (
          <>
            <CheckCircle2 className="mr-2 h-4 w-4" />
            Submit Referral
          </>
        )}
      </Button>

      <p className="text-xs text-muted-foreground text-center">
        * Phone or email required
      </p>
    </form>
  )
}
