"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth/client"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, ArrowLeft, User } from "lucide-react"
import Link from "next/link"
import { createContact } from "@/app/actions/contacts"
import { CONTACT_TYPES as CANONICAL_CONTACT_TYPES, type ContactType } from "@/lib/contact-types"
import { LEAD_SOURCES, LEAD_SOURCE_LABELS } from "@/lib/constants"

// Exactly the values contacts.contact_type accepts. The form used to offer
// "tenant", "landlord" and "referral"; the column has never accepted any of
// them, so choosing one made the INSERT fail and the agent saw only a generic
// create error. Tenant/landlord are deliberately NOT added to the column —
// this OS is not a property-management product — and "referral" was simply
// the wrong word for referral_partner.
//
// IT HAPPENED AGAIN, and this time the hand-kept list was the reason. The menu
// still offered "past_client", which m539 retired from the CHECK in favour of
// `lifetime_customer` — so the same generic create error was one click away for
// every agent filing a past client. The OFFERED SET IS NOW DERIVED from
// lib/contact-types.ts:CONTACT_TYPES rather than retyped, so the menu cannot
// offer a value the column refuses; only the LABELS live here.
//
// AND THE DERIVATION EARNED ITS KEEP AGAIN AT m563, which removed 'client' from
// the CHECK (owner: "client isn't a type"). Because both structures below are
// keyed/typed by `ContactType`, dropping the member made the stale entries a
// COMPILE ERROR rather than a menu item that fails on submit — which is the whole
// point of typing them off the vocabulary instead of retyping it.
const CONTACT_TYPE_LABELS: Record<ContactType, string> = {
  lead:              "Lead",
  prospect:          "Prospect",
  // TOMBSTONE (§1): `client: "Client"` stood here. Removed by m563 — a represented
  // client picks the side they are on (Buyer / Seller / Buyer & Seller / Investor);
  // the representation itself is contacts.status, not a contact_type.
  lifetime_customer: "Lifetime Customer (past client)",
  sphere:            "Sphere",
  vendor:            "Vendor",
  referral_partner:  "Referral Partner",
  investor:          "Investor",
  buyer:             "Buyer",
  seller:            "Seller",
  both:              "Buyer & Seller",
  other:             "Other",
}

// The order agents actually pick in, filtered to what the column admits.
const CONTACT_TYPE_ORDER: readonly ContactType[] = [
  "buyer", "seller", "both", "lead", "prospect",
  "investor", "referral_partner", "vendor", "sphere", "lifetime_customer", "other",
]

const CONTACT_TYPES = CONTACT_TYPE_ORDER
  .filter((v) => (CANONICAL_CONTACT_TYPES as readonly string[]).includes(v))
  .map((value) => ({ value, label: CONTACT_TYPE_LABELS[value] }))

// TOMBSTONE (§1.1 / §6): the private `LEAD_SOURCES` value/label array that stood
// here is DELETED. SURVIVOR: lib/constants/index.ts:101 LEAD_SOURCES +
// LEAD_SOURCE_LABELS, which this list was merged ONTO first — zillow,
// realtor_com, cold_call and door_knock were unique to this copy and are now in
// the survivor, so nothing was lost. The survivor also carries "manual", the
// value lib/kernel/crm.ts:396 writes by default and which this list could never
// produce. Enforcement of the same vocabulary now runs server-side in
// app/actions/contacts.ts createContact, because contacts.source has NO CHECK
// constraint and a TS array cannot bind an HTTP request.
const LEAD_SOURCE_OPTIONS = LEAD_SOURCES.map((value) => ({
  value,
  label: LEAD_SOURCE_LABELS[value],
}))

export default function NewContactPage() {
  const router = useRouter()
  const { userContext } = useAuth()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    contactType: "buyer",
    leadSource: "",
    notes: "",
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!userContext?.agentId) {
      // This tests for an AGENT PROFILE, not for a session. It used to say "You
      // must be logged in", which is a fix the reader cannot perform: they ARE
      // logged in, and logging in again will never produce the agents row this
      // needs. Name the thing that is actually missing, and where to get it.
      setError("Your account has no agent profile yet — finish setup in Settings → Profile, then create the contact.")
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const result = await createContact({
        first_name: formData.firstName,
        last_name: formData.lastName,
        email: formData.email || undefined,
        phone: formData.phone || undefined,
        contact_type: formData.contactType as any,
        source: formData.leadSource || undefined,
        notes: formData.notes || undefined,
      })

      if (result.success && result.contact) {
        router.push(`/crm/contacts/${result.contact.id}`)
      } else {
        setError(result.error || "Failed to create contact")
      }
    } catch (err) {
      setError("An unexpected error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <div className="flex items-center gap-4">
            <Link href="/crm">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Contacts
              </Button>
            </Link>
            <div className="h-8 w-px bg-border" />
            <div>
              <h1 className="text-2xl font-bold text-foreground">New Contact</h1>
              <p className="text-sm text-muted-foreground">Add a new contact to your CRM</p>
            </div>
          </div>
        </div>
      </div>

      {/* Form */}
      <div className="max-w-3xl mx-auto px-6 py-8">
        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5" />
                Contact Information
              </CardTitle>
              <CardDescription>Basic contact details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First Name *</Label>
                  <Input
                    id="firstName"
                    placeholder="John"
                    value={formData.firstName}
                    onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last Name *</Label>
                  <Input
                    id="lastName"
                    placeholder="Doe"
                    value={formData.lastName}
                    onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="john@example.com"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    type="tel"
                    placeholder="(555) 123-4567"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="contactType">Contact Type *</Label>
                  <Select
                    value={formData.contactType}
                    onValueChange={(value) => setFormData({ ...formData, contactType: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTACT_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="leadSource">Lead Source</Label>
                  <Select
                    value={formData.leadSource}
                    onValueChange={(value) => setFormData({ ...formData, leadSource: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select source" />
                    </SelectTrigger>
                    <SelectContent>
                      {LEAD_SOURCE_OPTIONS.map((source) => (
                        <SelectItem key={source.value} value={source.value}>
                          {source.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  id="notes"
                  placeholder="Add any additional notes about this contact..."
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows={3}
                />
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex items-center justify-end gap-4">
            <Link href="/crm">
              <Button variant="outline" type="button">Cancel</Button>
            </Link>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Contact"
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
