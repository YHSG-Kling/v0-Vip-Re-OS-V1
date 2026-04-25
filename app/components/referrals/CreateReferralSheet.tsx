"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { createReferral, createPartner } from "@/app/actions/referrals/referral-actions"
import { toast } from "sonner"

export function CreateReferralSheet() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const isOpen = searchParams.get("action") === "create"
  const [isLoading, setIsLoading] = useState(false)
  const [formData, setFormData] = useState({
    referrer_name: "",
    contact_email: "",
    contact_phone: "",
    status: "new",
    notes: "",
  })

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      router.push("/referrals")
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    
    try {
      // createReferral requires a partnerId — create a partner record from the
      // referrer name first, then attach the referred contact's details.
      const partner = await createPartner({
        partnerName: formData.referrer_name,
        partnerType: "individual",
        agreementType: "referral",
      })
      await createReferral({
        partnerId: partner.id,
        referredPerson: {
          email: formData.contact_email || undefined,
          phone: formData.contact_phone || undefined,
        },
        referralSource: formData.notes || undefined,
      })
      toast.success("Referral created successfully")
      router.push("/referrals")
    } catch (error) {
      toast.error("An error occurred while creating the referral")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Create New Referral</SheetTitle>
        </SheetHeader>
        
        <form onSubmit={handleSubmit} className="space-y-6 mt-6">
          <div className="space-y-2">
            <Label htmlFor="referrer-name">Referrer Name</Label>
            <Input
              id="referrer-name"
              placeholder="Name of person referring"
              value={formData.referrer_name}
              onChange={(e) => setFormData({ ...formData, referrer_name: e.target.value })}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="contact-email">Email</Label>
            <Input
              id="contact-email"
              type="email"
              placeholder="Email address"
              value={formData.contact_email}
              onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="contact-phone">Phone</Label>
            <Input
              id="contact-phone"
              type="tel"
              placeholder="Phone number"
              value={formData.contact_phone}
              onChange={(e) => setFormData({ ...formData, contact_phone: e.target.value })}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="status">Status</Label>
            <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value })}>
              <SelectTrigger id="status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="contacted">Contacted</SelectItem>
                <SelectItem value="qualified">Qualified</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              placeholder="Additional notes about this referral..."
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              className="resize-none"
              rows={3}
            />
          </div>

          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isLoading}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading} className="flex-1">
              {isLoading ? "Creating..." : "Create Referral"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
