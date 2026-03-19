import { Suspense } from "react"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getLessonFeed } from "@/app/actions/portal-education"
import { logPortalAccess } from "@/lib/kernel/portal"
import LearnClient from "./learn-client"
import { Skeleton } from "@/app/components/ui/skeleton"

interface LearnPageProps {
  params: Promise<{ contactId: string }>
}

function LearnSkeleton() {
  return (
    <div className="space-y-6">
      {/* Progress skeleton */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-2 w-full" />

      {/* Spotlight skeleton */}
      <Skeleton className="h-48 w-full rounded-lg" />

      {/* Filter tabs skeleton */}
      <div className="flex gap-2">
        <Skeleton className="h-10 w-20" />
        <Skeleton className="h-10 w-20" />
        <Skeleton className="h-10 w-24" />
      </div>

      {/* Lesson cards skeleton */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-40 w-full rounded-lg" />
        ))}
      </div>
    </div>
  )
}

export default async function LearnPage({ params }: LearnPageProps) {
  const { contactId } = await params
  const supabase = await createClient()

  // Verify contact exists
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, agent_id")
    .eq("id", contactId)
    .single()

  if (contactError || !contact) {
    redirect("/portal?error=contact_not_found")
  }

  // Get initial lesson feed
  const feed = await getLessonFeed(contactId)

  // Log portal access (non-blocking)
  logPortalAccess(supabase, contactId, "learn", "view", contact.agent_id).catch(() => {})

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Learn</h1>
        <p className="text-muted-foreground">
          Educational resources tailored to your real estate journey
        </p>
      </div>

      <Suspense fallback={<LearnSkeleton />}>
        <LearnClient
          contactId={contactId}
          initialFeed={feed}
        />
      </Suspense>
    </div>
  )
}
