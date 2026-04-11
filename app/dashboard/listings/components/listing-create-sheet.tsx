"use client"
/**
 * app/dashboard/listings/components/listing-create-sheet.tsx
 *
 * Slide-over sheet for creating a new listing inline on the listings list page.
 *
 * UI behavior:
 * - Opens when URL contains ?action=new (controlled by parent via searchParams).
 * - On success: calls router.push to `/dashboard/listings/${id}/lifecycle`.
 * - On cancel: removes ?action=new from URL via router.replace.
 * - Error state: displayed inline in the form via ListingEditForm.
 * - Never navigates away on error — keeps the form open with the error visible.
 */

import { useRouter } from "next/navigation"
import { useState } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { ListingEditForm, type ListingFormData } from "./listing-edit-form"
import { createListingWithSellerContact } from "@/app/actions/listings-kernel"

type PrefillContact = {
  firstName: string
  lastName: string
  email: string
  phone: string
  contactId: string
}

type ListingCreateSheetProps = {
  open: boolean
  prefillContact?: PrefillContact
}

export function ListingCreateSheet({ open, prefillContact }: ListingCreateSheetProps) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  function handleClose() {
    // Remove ?action=new from the URL without a full navigation
    router.replace("/dashboard/listings")
  }

  async function handleSubmit(data: ListingFormData) {
    setError(null)

    const result = await createListingWithSellerContact({
      sellerFirstName: data.sellerFirstName,
      sellerLastName:  data.sellerLastName,
      sellerEmail:     data.sellerEmail     || undefined,
      sellerPhone:     data.sellerPhone     || undefined,
      address:         data.address,
      city:            data.city,
      state:           data.state,
      zip:             data.zip,
      listPrice:       data.listPrice  ? Number(data.listPrice)  : undefined,
      bedrooms:        data.bedrooms   ? Number(data.bedrooms)   : undefined,
      bathrooms:       data.bathrooms  ? Number(data.bathrooms)  : undefined,
      sqft:            data.sqft       ? Number(data.sqft)       : undefined,
      propertyType:    data.propertyType || undefined,
    })

    if (!result.success) {
      setError(result.error ?? "Failed to create listing")
      return
    }

    // Navigate to the lifecycle command center for this new listing
    router.push(`/dashboard/listings/${result.listingId}/lifecycle`)
  }

  return (
    <Sheet open={open} onOpenChange={isOpen => { if (!isOpen) handleClose() }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl md:max-w-2xl flex flex-col p-0"
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b shrink-0">
          <SheetTitle>New Listing</SheetTitle>
          <SheetDescription>
            Enter the seller and property details to create a new listing record at the LEAD stage.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <ListingEditForm
            showSellerFields
            submitLabel="Create Listing"
            onSubmit={handleSubmit}
            onCancel={handleClose}
            error={error}
            defaultValues={prefillContact ? {
              sellerFirstName: prefillContact.firstName,
              sellerLastName:  prefillContact.lastName,
              sellerEmail:     prefillContact.email,
              sellerPhone:     prefillContact.phone,
            } : undefined}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
