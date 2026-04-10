import { Suspense } from "react"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { InboxClient } from "./inbox-client"
import { Skeleton } from "@/components/ui/skeleton"

export const metadata = {
  title: "Universal Inbox | VIP RE OS",
  description: "All your client conversations in one place",
}

interface PageProps {
  searchParams: Promise<{ contact?: string; channel?: string }>
}

function InboxSkeleton() {
  return (
    <div className="flex h-[calc(100vh-80px)] border rounded-lg overflow-hidden bg-background">
      {/* Thread list skeleton */}
      <div className="w-80 border-r p-4 space-y-4 shrink-0">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-8 w-full" />
        <div className="flex gap-1">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-5 w-12 rounded-full" />
          ))}
        </div>
        <div className="space-y-3 pt-2">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="space-y-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          ))}
        </div>
      </div>
      {/* Message panel skeleton */}
      <div className="flex-1 flex flex-col">
        <div className="p-4 border-b">
          <Skeleton className="h-5 w-40" />
        </div>
        <div className="flex-1 p-4 space-y-3">
          <div className="flex justify-start">
            <Skeleton className="h-12 w-48 rounded-2xl" />
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-10 w-56 rounded-2xl" />
          </div>
          <div className="flex justify-start">
            <Skeleton className="h-16 w-52 rounded-2xl" />
          </div>
        </div>
        <div className="p-4 border-t">
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      </div>
    </div>
  )
}

export default async function InboxPage({ searchParams }: PageProps) {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    redirect("/auth/login")
  }

  const { contact: contactId, channel } = await searchParams

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b shrink-0">
        <h1 className="text-xl font-semibold text-foreground">Universal Inbox</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          All client conversations — portal, SMS, email, and voice — in one place.
        </p>
      </div>
      <div className="flex-1 overflow-hidden px-6 py-4">
        <Suspense fallback={<InboxSkeleton />}>
          <InboxClient initialContactId={contactId ?? null} initialChannel={channel ?? null} />
        </Suspense>
      </div>
    </div>
  )
}
