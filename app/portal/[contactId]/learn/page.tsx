// ─── TOMBSTONE (orphan-route sweep, lane G) ──────────────────────────────────
// `/portal/[contactId]/education` — app/portal/[contactId]/education/page.tsx —
// IS DELETED. THIS PAGE IS THE SURVIVOR.
//
// It was a strict, weaker SUBSET of this route, and it was reachable from
// nothing (test:orphan-routes listed it; the portal nav's "Learn" item —
// lib/kernel/portal.ts:504/521/536, moduleKey "education" — points HERE).
//
// What the duplicate did and what the survivor already does better:
//   · lessons — it called `getEducationPlan` directly with a hardcoded
//     `journeyPhase: "active"` and `ageSegment: "30-50"`. This page calls
//     `getLessonFeed` (app/actions/portal-education.ts:191), which calls the SAME
//     `getEducationPlan` with the REAL age segment, the real journey phase and the
//     real current milestone, then folds in completion state.
//   · access — it gated on `getAgentContext()` and then read any contactId off
//     the URL. `getLessonFeed` gates on portal contact access.
//   · portal_access_logs — it wrote none; this page calls `logPortalAccess`.
// Nothing was merged onto the survivor because nothing was missing from it: the
// duplicate's one dependency, `getEducationPlan`, is reached through
// `getLessonFeed` and remains referenced (also app/actions/education-kernel.ts:46,
// app/api/education/*).
// ─────────────────────────────────────────────────────────────────────────────
import { Suspense } from "react"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getLessonFeed } from "@/app/actions/portal-education"
import { logPortalAccess } from "@/lib/kernel/portal"
import { getPersonaMessagingGuidelines } from "@/lib/buyer-search/persona-inference"
import LearnClient from "./learn-client"
import { Skeleton } from "@/app/components/ui/skeleton"
import { BookOpen } from "lucide-react"

interface LearnPageProps {
  params: Promise<{ contactId: string }>
  searchParams: Promise<{ milestone?: string }>
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

export default async function LearnPage({ params, searchParams }: LearnPageProps) {
  const { contactId } = await params
  const { milestone: focusMilestone } = await searchParams
  const supabase = await createClient()

  // Verify contact exists — fetch stage + persona for header
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, agent_id, buyer_stage, contact_persona, contact_type")
    .eq("id", contactId)
    .single()

  if (contactError || !contact) {
    redirect("/portal?error=contact_not_found")
  }

  // Derive persona guidelines for tone-aware framing
  const personaGuidelines = contact.contact_persona
    ? getPersonaMessagingGuidelines(contact.contact_persona as any)
    : getPersonaMessagingGuidelines("first_time_buyer")

  // Map buyer_stage to a plain-language stage label
  const STAGE_LABEL_MAP: Record<string, string> = {
    BUYER_CONTACT_CREATED: "Getting Started",
    BUYER_FINANCIALLY_VERIFIED: "Financially Ready",
    BUYER_TOUR_ELIGIBLE: "Ready to Tour",
    BUYER_TOURING: "Actively Touring",
    BUYER_OFFER_ELIGIBLE: "Ready to Make an Offer",
    BUYER_OFFER_SUBMITTED: "Offer Submitted",
    BUYER_UNDER_CONTRACT: "Under Contract",
    BUYER_CLOSED: "Closed",
    pre_listing: "Preparing to List",
    active: "Listed & Active",
    under_contract: "Under Contract",
    closed: "Sold",
  }

  const stageLabel =
    STAGE_LABEL_MAP[contact.buyer_stage ?? ""] ||
    STAGE_LABEL_MAP[contact.contact_type ?? ""] ||
    "Your Journey"

  // Persona emphasis line — first emphasis item if available
  const personaEmphasis = personaGuidelines.emphasisOn?.[0] ?? null

  // Get initial lesson feed
  const feed = await getLessonFeed(contactId)

  // Log portal access (non-blocking)
  logPortalAccess(supabase, contactId, "learn", "view", contact.agent_id).catch(() => {})

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <BookOpen className="h-6 w-6 text-primary" />
          Your Homebuying Journey
        </h1>
        <p className="text-muted-foreground mt-1">
          {stageLabel} — Here&apos;s what you need to know
        </p>
        {personaEmphasis && (
          <p className="text-xs text-primary/70 mt-1">
            Focus area: {personaEmphasis}
          </p>
        )}
      </div>

      <Suspense fallback={<LearnSkeleton />}>
        <LearnClient
          contactId={contactId}
          initialFeed={feed}
          agentId={contact.agent_id ?? null}
          contactFirstName={contact.first_name ?? null}
          focusMilestone={focusMilestone ?? null}
        />
      </Suspense>
    </div>
  )
}
