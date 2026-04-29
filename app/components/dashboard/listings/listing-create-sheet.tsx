"use client"
/**
 * app/dashboard/listings/components/listing-create-sheet.tsx
 *
 * Slide-over sheet for creating a new listing.
 * Now hosts the full multi-step ListingInitiationFlow (mirrors offer flow).
 *
 * UI behavior:
 * - Opens when URL contains ?action=new (controlled by parent via searchParams).
 * - On success: navigates to /dashboard/listings/${id}/lifecycle.
 * - On cancel: removes ?action=new from URL via router.replace.
 */

import { useRouter } from "next/navigation"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { ListingInitiationFlow } from "./listing-initiation-flow"

type PrefillContact = {
  firstName:  string
  lastName:   string
  email:      string
  phone:      string
  contactId:  string
  agentName:  string
  agentEmail: string
  agentUserId: string
  brokerageId: string
}

type ListingCreateSheetProps = {
  open:            boolean
  prefillContact?: PrefillContact
  /** Pre-fill address when launched from a listing or CRM property link */
  prefillAddress?: string
}

export function ListingCreateSheet({ open, prefillContact, prefillAddress }: ListingCreateSheetProps) {
  const router = useRouter()

  function handleClose() {
    router.replace("/dashboard/listings")
  }

  function handleSuccess(listingId: string) {
    router.push(`/dashboard/listings/${listingId}/lifecycle`)
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
            Complete the steps below to create a new listing and send the agreement for signatures.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <ListingInitiationFlow
            agentUserId={prefillContact?.agentUserId ?? ""}
            agentName={prefillContact?.agentName ?? ""}
            agentEmail={prefillContact?.agentEmail ?? ""}
            brokerageId={prefillContact?.brokerageId ?? ""}
            initialFirstName={prefillContact?.firstName}
            initialLastName={prefillContact?.lastName}
            initialEmail={prefillContact?.email}
            initialPhone={prefillContact?.phone}
            initialAddress={prefillAddress}
            onSuccess={handleSuccess}
            onCancel={handleClose}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
