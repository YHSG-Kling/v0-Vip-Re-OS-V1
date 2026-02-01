"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import type { Contact, ContactStatus } from "@/types/contact"

interface ContactEditFormProps {
  contact: Contact
  onSave: () => void
  onClose: () => void
}

const STATUS_OPTIONS: ContactStatus[] = [
  "new",
  "contacted",
  "qualified",
  "appointment_booked",
  "signed_agreement",
  "pre_listing",
  "active_listing",
  "contingent",
  "pending",
  "sold",
  "lifetime_customer",
]

const STATUS_LABELS: Record<ContactStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  appointment_booked: "Appointment Booked",
  signed_agreement: "Signed Agreement",
  pre_listing: "Pre-Listing",
  active_listing: "Active Listing",
  contingent: "Contingent",
  pending: "Pending",
  sold: "Sold",
  lifetime_customer: "Lifetime Customer",
}

export function ContactEditForm({ contact, onSave, onClose }: ContactEditFormProps) {
  const [formData, setFormData] = useState({
    first_name: contact?.first_name || "",
    last_name: contact?.last_name || "",
    email: contact?.email || "",
    phone: contact?.phone || "",
    status: contact?.status || "new",
    notes: contact?.notes || "",
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }))
    setError(null)
  }

  const validateForm = (): boolean => {
    if (!formData.first_name?.trim()) {
      setError("First name is required")
      return false
    }
    if (!formData.last_name?.trim()) {
      setError("Last name is required")
      return false
    }
    if (!formData.email?.trim()) {
      setError("Email is required")
      return false
    }
    if (!formData.email.includes("@")) {
      setError("Please enter a valid email")
      return false
    }
    return true
  }

  const handleSave = async () => {
    if (!validateForm()) return

    setLoading(true)
    setError(null)

    try {
      const response = await fetch("/api/contacts/update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: contact.id,
          first_name: formData.first_name,
          last_name: formData.last_name,
          email: formData.email,
          phone: formData.phone,
          status: formData.status,
          notes: formData.notes,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to update contact")
      }

      setSuccess(true)
      onSave()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update contact")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6 max-w-2xl">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
          <Input
            value={formData.first_name}
            onChange={(e) => handleChange("first_name", e.target.value)}
            placeholder="First name"
            disabled={loading}
            className="w-full"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
          <Input
            value={formData.last_name}
            onChange={(e) => handleChange("last_name", e.target.value)}
            placeholder="Last name"
            disabled={loading}
            className="w-full"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
        <Input
          type="email"
          value={formData.email}
          onChange={(e) => handleChange("email", e.target.value)}
          placeholder="email@example.com"
          disabled={loading}
          className="w-full"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
        <Input
          value={formData.phone || ""}
          onChange={(e) => handleChange("phone", e.target.value)}
          placeholder="(555) 000-0000"
          disabled={loading}
          className="w-full"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
        <Select value={formData.status} onValueChange={(value) => handleChange("status", value)}>
          <SelectTrigger disabled={loading}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
        <Textarea
          value={formData.notes || ""}
          onChange={(e) => handleChange("notes", e.target.value)}
          placeholder="Add any notes about this contact..."
          disabled={loading}
          rows={4}
          className="w-full"
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm">Contact updated successfully</span>
        </div>
      )}

      <div className="flex gap-3 justify-end pt-4">
        <Button variant="outline" onClick={onClose} disabled={loading}>
          Close
        </Button>
        <Button onClick={handleSave} disabled={loading} className="bg-emerald-600 hover:bg-emerald-700">
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </div>
  )
}

export default ContactEditForm
