/**
 * ─────────────────────────────────────────────────────────────────────────────
 * COACHING SESSIONS — the surface the two coaching handlers were written for.
 *
 * `app/actions/copilot.ts` carried two capabilities that were built, hardened and
 * then left with no caller, each with the SAME named blocker written into its
 * docblock: "the coaching dashboard renders suggestions and offers no verb for
 * them" / "what is still missing is a 'book a session' control on the coaching
 * dashboard".
 *
 *   · handleCoachingSessionBooked — the ONLY writer of a coaching booking in the
 *     tree (`grep -rn` for a second `event_type: "coaching"` calendar_events
 *     insert returns exactly one). Without a caller, no coaching session has ever
 *     been booked through this product.
 *   · handleSuggestionAccepted — the ONLY writer of the `accepted` status on
 *     smart_assistant_suggestions. scripts/1082-broaden-smart-assistant-
 *     suggestions-status-check.sql:9-14 defines `accepted` ("agent agreed but
 *     hasn't completed the action yet") apart from `actioned` ("agent took the
 *     action"), so with no accept verb the middle of that lifecycle was
 *     unreachable and every suggestion went straight from pending to nothing.
 *
 * WHY A SIBLING ROUTE AND NOT A CARD ON /dashboard/coaching. `coaching-dashboard-
 * client.tsx` is owned by another lane this wave; the doctrine forbids half-
 * building across a lane boundary, and it equally forbids leaving a finished
 * capability dark. A sibling route is the resolution: /dashboard/coaching/sessions
 * is reachable, renders, and does the work — the same shape the existing
 * /dashboard/coaching/practice sibling already uses. The one line that still needs
 * to land on the parent client (a link to this route beside the suggestions card)
 * is REPORTED rather than written here.
 *
 * STILL OWED — SAID PLAINLY SO NOBODY READS A GREEN GUARD AS A FINISHED JOB. There is
 * no NAV LINK to this route yet. `test:orphan-routes` counts it as referenced only
 * because `handleSuggestionAccepted` and `handleCoachingSessionBooked` now
 * `revalidatePath("/dashboard/coaching/sessions")` — those revalidations are correct on
 * their own merits (both surfaces below are server-rendered and both actions change
 * them), but a cache invalidation is NOT a way for a human to get here. The real entry
 * is one line in app/config/navigation-config.ts beside the two existing coaching
 * entries at :227-228:
 *   { id: 'coaching-sessions', label: 'Coaching Sessions',
 *     href: '/dashboard/coaching/sessions', icon: 'CalendarPlus' }
 * That file belongs to another lane and the line is reported, not written.
 *
 * READS ARE SCOPED HERE, WRITES ARE SCOPED IN THE ACTION. This page filters
 * suggestions and bookings to the session's own agent/brokerage; the two actions
 * it calls each re-establish the caller independently (authorizeForUser /
 * resolveWriteContext), so nothing on this page is load-bearing for authority.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { CoachingSessionsClient } from "./coaching-sessions-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Coaching Sessions | Dashboard",
  description: "Book a coaching session and act on your pending coaching suggestions",
}

/** Who may be named as the coach on a booking — the tenant's staff roster. */
const COACH_ROLES = ["broker", "broker_admin", "broker_owner", "team_lead", "admin"]

export default async function CoachingSessionsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { agentId, brokerageId } = await getAgentContext()
  if (!brokerageId) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">Coaching Sessions</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your account has no brokerage yet, so there is nothing to coach against. Finish account
          setup and come back.
        </p>
      </div>
    )
  }

  // Every read below destructures `error`: supabase-js RESOLVES a refused query, so
  // without it an RLS refusal renders as "you have no suggestions" — a lie that looks
  // like a clean slate.
  const [coachesResult, suggestionsResult, bookedResult] = await Promise.all([
    supabase
      .from("users")
      .select("id, first_name, last_name, email, user_type")
      .eq("brokerage_id", brokerageId)
      .in("user_type", COACH_ROLES)
      .order("first_name", { ascending: true })
      .limit(50),
    agentId
      ? supabase
          .from("smart_assistant_suggestions")
          .select("id, title, description, suggestion_type, action_type, priority, status, created_at")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .eq("status", "pending")
          .order("priority", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(25)
      : Promise.resolve({ data: [], error: null } as const),
    supabase
      .from("calendar_events")
      .select("id, title, start_at, end_at, attendees")
      .eq("brokerage_id", brokerageId)
      .eq("agent_user_id", user.id)
      .eq("event_type", "coaching")
      .gte("start_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order("start_at", { ascending: true })
      .limit(20),
  ])

  const loadErrors = [
    coachesResult.error && `coach roster: ${coachesResult.error.message}`,
    suggestionsResult.error && `suggestions: ${suggestionsResult.error.message}`,
    bookedResult.error && `booked sessions: ${bookedResult.error.message}`,
  ].filter(Boolean) as string[]

  const coaches = (coachesResult.data ?? []).map((c) => ({
    id: c.id as string,
    label:
      [c.first_name, c.last_name].filter(Boolean).join(" ").trim() ||
      (c.email as string | null) ||
      (c.id as string).slice(0, 8),
    role: (c.user_type as string | null) ?? "",
  }))

  return (
    <CoachingSessionsClient
      userId={user.id}
      hasAgentProfile={Boolean(agentId)}
      coaches={coaches}
      suggestions={(suggestionsResult.data ?? []) as Array<Record<string, unknown>>}
      bookedSessions={(bookedResult.data ?? []) as Array<Record<string, unknown>>}
      loadErrors={loadErrors}
    />
  )
}
