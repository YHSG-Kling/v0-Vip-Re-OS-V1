"use client"
/**
 * app/dashboard/listings/components/listing-edit-form.tsx
 *
 * Reusable form for listing property fields.
 * Used by: ListingCreateSheet (create mode) and lifecycle page (edit mode).
 *
 * UI behavior:
 * - All fields map 1:1 to live schema columns.
 * - Seller section: search by name/email → select existing OR inline-create.
 * - Validation: address + city + state required. All others optional.
 * - On submit: calls onSubmit(formData). Parent owns the action.
 * - Pending state: disables all fields and shows spinner on the submit button.
 */

import { useState, useTransition, useId } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2 } from "lucide-react"

export type ListingFormData = {
  // Seller contact (create mode — identifies or creates the seller)
  sellerFirstName: string
  sellerLastName: string
  sellerEmail: string
  sellerPhone: string
  // Property
  address: string
  city: string
  state: string
  zip: string
  listPrice: string
  bedrooms: string
  bathrooms: string
  sqft: string
  propertyType: string
}

type ListingEditFormProps = {
  defaultValues?: Partial<ListingFormData>
  /** Show seller fields (true for create; false when editing an existing listing) */
  showSellerFields?: boolean
  submitLabel?: string
  onSubmit: (data: ListingFormData) => Promise<void>
  onCancel?: () => void
  error?: string | null
}

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
]

const PROPERTY_TYPES = [
  { value: "residential",    label: "Single Family" },
  { value: "condo",          label: "Condo / Townhouse" },
  { value: "multi_family",   label: "Multi-Family" },
  { value: "land",           label: "Land" },
  { value: "commercial",     label: "Commercial" },
]

const EMPTY_FORM: ListingFormData = {
  sellerFirstName: "",
  sellerLastName:  "",
  sellerEmail:     "",
  sellerPhone:     "",
  address:         "",
  city:            "",
  state:           "",
  zip:             "",
  listPrice:       "",
  bedrooms:        "",
  bathrooms:       "",
  sqft:            "",
  propertyType:    "residential",
}

export function ListingEditForm({
  defaultValues,
  showSellerFields = true,
  submitLabel = "Create Listing",
  onSubmit,
  onCancel,
  error,
}: ListingEditFormProps) {
  const uid = useId()
  const [isPending, startTransition] = useTransition()
  const [form, setForm] = useState<ListingFormData>({ ...EMPTY_FORM, ...defaultValues })
  const [validationError, setValidationError] = useState<string | null>(null)

  function set(key: keyof ListingFormData, value: string) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  function validate(): string | null {
    if (!form.address.trim()) return "Property address is required"
    if (!form.city.trim())    return "City is required"
    if (!form.state)          return "State is required"
    if (showSellerFields && !form.sellerFirstName.trim()) return "Seller first name is required"
    return null
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const err = validate()
    if (err) { setValidationError(err); return }
    setValidationError(null)
    startTransition(() => { onSubmit(form) })
  }

  const displayError = validationError ?? error

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      {/* Seller section */}
      {showSellerFields && (
        <fieldset className="space-y-3" disabled={isPending}>
          <legend className="text-sm font-semibold text-foreground">Seller Contact</legend>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor={`${uid}-sfn`}>First Name *</Label>
              <Input
                id={`${uid}-sfn`}
                value={form.sellerFirstName}
                onChange={e => set("sellerFirstName", e.target.value)}
                placeholder="Jane"
                autoComplete="given-name"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-sln`}>Last Name</Label>
              <Input
                id={`${uid}-sln`}
                value={form.sellerLastName}
                onChange={e => set("sellerLastName", e.target.value)}
                placeholder="Smith"
                autoComplete="family-name"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor={`${uid}-sem`}>Email</Label>
              <Input
                id={`${uid}-sem`}
                type="email"
                value={form.sellerEmail}
                onChange={e => set("sellerEmail", e.target.value)}
                placeholder="jane@email.com"
                autoComplete="email"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${uid}-sph`}>Phone</Label>
              <Input
                id={`${uid}-sph`}
                type="tel"
                value={form.sellerPhone}
                onChange={e => set("sellerPhone", e.target.value)}
                placeholder="(555) 000-0000"
                autoComplete="tel"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            An existing contact matching this email or phone will be attached automatically.
          </p>
        </fieldset>
      )}

      {/* Property section */}
      <fieldset className="space-y-3" disabled={isPending}>
        <legend className="text-sm font-semibold text-foreground">Property Details</legend>

        <div className="space-y-1">
          <Label htmlFor={`${uid}-addr`}>Street Address *</Label>
          <Input
            id={`${uid}-addr`}
            value={form.address}
            onChange={e => set("address", e.target.value)}
            placeholder="123 Maple Street"
            autoComplete="street-address"
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 space-y-1">
            <Label htmlFor={`${uid}-city`}>City *</Label>
            <Input
              id={`${uid}-city`}
              value={form.city}
              onChange={e => set("city", e.target.value)}
              placeholder="Houston"
              autoComplete="address-level2"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${uid}-state`}>State *</Label>
            <Select value={form.state} onValueChange={v => set("state", v)}>
              <SelectTrigger id={`${uid}-state`}>
                <SelectValue placeholder="TX" />
              </SelectTrigger>
              <SelectContent>
                {US_STATES.map(s => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={`${uid}-zip`}>ZIP Code</Label>
            <Input
              id={`${uid}-zip`}
              value={form.zip}
              onChange={e => set("zip", e.target.value)}
              placeholder="77001"
              maxLength={10}
              autoComplete="postal-code"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${uid}-type`}>Property Type</Label>
            <Select value={form.propertyType} onValueChange={v => set("propertyType", v)}>
              <SelectTrigger id={`${uid}-type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROPERTY_TYPES.map(pt => (
                  <SelectItem key={pt.value} value={pt.value}>{pt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`${uid}-price`}>List Price</Label>
          <Input
            id={`${uid}-price`}
            type="number"
            value={form.listPrice}
            onChange={e => set("listPrice", e.target.value)}
            placeholder="450000"
            min={0}
            step={1000}
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label htmlFor={`${uid}-beds`}>Beds</Label>
            <Input
              id={`${uid}-beds`}
              type="number"
              value={form.bedrooms}
              onChange={e => set("bedrooms", e.target.value)}
              placeholder="3"
              min={0}
              max={99}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${uid}-baths`}>Baths</Label>
            <Input
              id={`${uid}-baths`}
              type="number"
              value={form.bathrooms}
              onChange={e => set("bathrooms", e.target.value)}
              placeholder="2"
              min={0}
              max={99}
              step={0.5}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${uid}-sqft`}>Sq Ft</Label>
            <Input
              id={`${uid}-sqft`}
              type="number"
              value={form.sqft}
              onChange={e => set("sqft", e.target.value)}
              placeholder="1800"
              min={0}
              step={50}
            />
          </div>
        </div>
      </fieldset>

      {displayError && (
        <p role="alert" className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
          {displayError}
        </p>
      )}

      <div className="flex items-center gap-3 pt-1">
        <Button type="submit" disabled={isPending} className="flex-1">
          {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {isPending ? "Saving..." : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}
