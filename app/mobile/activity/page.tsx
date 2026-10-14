/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AGENT'S OWN ACTIVITY LOG — the reader for everything the field surfaces write.
 *
 * `app/actions/activities.ts` has three live writers on the mobile/CRM surfaces
 * (field-quick-actions, contact-command-strip, contact-header-card all call
 * `logActivity`, and mobile-followup-panel calls `completeActivity`) and a read
 * that nothing ever called: `getAgentActivities`. So an agent could log a door
 * knock, a call and a note from the field and had no screen anywhere that showed
 * them back. Its sibling `getPendingFollowups` is wired; this one is the FULL
 * history behind that queue, including everything already completed.
 *
 * AUTHORITY IS THE ACTION'S, NOT THIS PAGE'S. `getAgentActivities` is a
 * `"use server"` export — a public HTTP endpoint — and it resolves the agent from
 * the SESSION, refusing any requested id that is not the caller's own
 * (`resolveOwnAgentId`). The id passed below is therefore a convenience, not a
 * grant: substituting someone else's is refused by the action.
 *
 * OWED, AND NOW PAID (orphan-route sweep, lane G). This docblock used to end
 * "there is no NAV ENTRY for this route yet" — and it was worse than that: the
 * revalidatePath evidence it leaned on was later REMOVED from the sweep as a false
 * pass (a cache invalidation is not a way for a human to arrive), so this page was
 * an outright orphan.
 *
 * The entry now exists at app/mobile/components/os/mobile-command-strip.tsx:52 —
 * the "Activity" tile in the expanded command strip, rendered on /mobile/assistant
 * and /mobile/voice. It cost nothing to add because that tile was ALREADY THERE
 * pointing at `/mobile/log`, a route that has never existed. The link with no page
 * and the page with no link were each other's missing half.
 *
 * FILTERING IS A URL, NOT A CLIENT BUNDLE. The status filter rides searchParams so
 * this stays a server component and no activity row is ever shipped to the client
 * beyond what is rendered — `activities` rows carry free-text notes, which are the
 * most sensitive thing the field collects.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { getAgentActivities } from "@/app/actions/activities"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Activity | Mobile",
  description: "Everything you logged from the field",
}

/** The statuses `logActivity` / `completeActivity` actually write. */
const FILTERS = [
  { key: "", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "completed", label: "Completed" },
] as const

export default async function MobileActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const { status } = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { agentId } = await getAgentContext()
  if (!agentId) {
    return (
      <div className="p-4">
        <h1 className="text-lg font-semibold">Activity</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Activities hang off an agent profile and this account does not have one yet.
        </p>
      </div>
    )
  }

  const selected = FILTERS.some((f) => f.key === status) ? (status as string) : ""

  const { activities, error } = await getAgentActivities(agentId, {
    limit: 100,
    ...(selected ? { status: selected } : {}),
  })

  return (
    <div className="space-y-4 p-4 pb-24">
      <div>
        <h1 className="text-lg font-semibold">Activity</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Everything you logged from the field, newest first.
        </p>
      </div>

      <div className="flex gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key || "all"}
            href={f.key ? `/mobile/activity?status=${f.key}` : "/mobile/activity"}
            className={
              "rounded-full border px-3 py-1 text-xs " +
              (selected === f.key ? "bg-foreground text-background" : "text-muted-foreground")
            }
          >
            {f.label}
          </Link>
        ))}
      </div>

      {/* The action returns its refusal rather than throwing, and an unreported
          refusal would render as "you have logged nothing" — the exact lie the
          `error` destructuring inside it exists to prevent. */}
      {error ? (
        <p className="text-sm text-destructive">Your activity could not be loaded: {error}</p>
      ) : activities.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {selected ? `Nothing ${selected} right now.` : "Nothing logged yet."}
        </p>
      ) : (
        <ul className="space-y-2">
          {activities.map((a: Record<string, any>) => (
            <li key={a.id} className="rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{a.title ?? "Activity"}</p>
                  {a.description ? (
                    <p className="mt-0.5 text-sm text-muted-foreground">{a.description}</p>
                  ) : null}
                  {/* The note is the perishable part — what the seller actually said
                      at the door. It is captured on completion and shown here. */}
                  {a.notes ? (
                    <p className="mt-1 rounded bg-muted/50 p-2 text-sm">{a.notes}</p>
                  ) : null}
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {a.completed_at
                    ? new Date(a.completed_at).toLocaleDateString()
                    : a.scheduled_at
                      ? new Date(a.scheduled_at).toLocaleDateString()
                      : a.created_at
                        ? new Date(a.created_at).toLocaleDateString()
                        : ""}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                {a.activity_type ? <span>{String(a.activity_type).replace(/_/g, " ")}</span> : null}
                <span>· {a.status ?? "pending"}</span>
                {a.priority ? <span>· {a.priority}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
