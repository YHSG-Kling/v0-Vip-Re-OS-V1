"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Users, ArrowRight, CheckCircle2, Loader2 } from "lucide-react"
import { submitReferral } from "@/app/actions/portal-lifetime"

interface ReferralAskCardProps {
  contactId: string
}

export function ReferralAskCard({ contactId }: ReferralAskCardProps) {
  const [name, setName] = useState("")
  const [contact, setContact] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !contact.trim()) return

    setIsSubmitting(true)
    setError(null)

    try {
      await submitReferral({
        contactId,
        referredName: name.trim(),
        referredContact: contact.trim(),
      })
      setIsSubmitted(true)
      setName("")
      setContact("")
    } catch (err) {
      setError("Failed to submit referral. Please try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-purple-600" />
          <CardTitle className="text-lg">Refer a Friend</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isSubmitted ? (
          <div className="p-4 rounded-lg bg-green-50 border border-green-200 text-center space-y-2">
            <CheckCircle2 className="h-8 w-8 text-green-600 mx-auto" />
            <p className="font-medium text-green-800">Thanks for the referral!</p>
            <p className="text-sm text-green-700">
              Your agent will follow up with them soon.
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsSubmitted(false)}
              className="mt-2"
            >
              Refer Someone Else
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Know someone who wants to buy or sell? Your referrals mean the world to us.
            </p>

            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="referral-name" className="text-sm">
                  Their Name
                </Label>
                <Input
                  id="referral-name"
                  placeholder="John Smith"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isSubmitting}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="referral-contact" className="text-sm">
                  Phone or Email
                </Label>
                <Input
                  id="referral-contact"
                  placeholder="john@email.com or 555-123-4567"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  disabled={isSubmitting}
                />
              </div>

              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={isSubmitting || !name.trim() || !contact.trim()}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  "Send Referral"
                )}
              </Button>
            </form>
          </>
        )}

        <div className="pt-2 border-t">
          <Button variant="ghost" size="sm" className="w-full" asChild>
            <Link href={`/portal/${contactId}/referrals`}>
              View Referral History
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
