import { Suspense } from "react"
import { notFound } from "next/navigation"
import { getContactDetails } from "@/app/actions/contact-details"
import ContactDetailContent from "./contact-detail-content"
import { Skeleton } from "@/components/ui/skeleton"

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const { contact, error } = await getContactDetails(contactId)

  if (error || !contact) {
    notFound()
  }

  return (
    <Suspense fallback={<ContactDetailSkeleton />}>
      <ContactDetailContent contact={contact} />
    </Suspense>
  )
}

function ContactDetailSkeleton() {
  return (
    <div className="container mx-auto py-8">
      <div className="grid lg:grid-cols-4 gap-6">
        <div className="lg:col-span-3 space-y-6">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
        <div className="lg:col-span-1">
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    </div>
  )
}
