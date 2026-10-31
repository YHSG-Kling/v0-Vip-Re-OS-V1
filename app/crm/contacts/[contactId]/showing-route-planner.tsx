"use client"

/**
 * THE SHORTLIST STEP OF THE TOUR LANE — AND ITS ON-RAMP INTO IT.
 *
 * ─── THE DRIFT THIS CARD USED TO BE (resolved this wave) ────────────────────
 * Owner ruling, verbatim: "you have smart showing route but there is also tour
 * planning which was what we built originally. you have to be careful and not
 * create more drifts we are trying to solve."
 *
 * This card shipped as "Build a showing route" — a SECOND route planner on a
 * contact page that already links the tour lane (tours + tour_stops + showings,
 * the kernel optimizer, scheduling, confirmation, day-of, portal). Two doors,
 * two engines, one fact: ROUTE ORDER AND DRIVE TIME.
 *
 * The verdict was NOT to delete a capability. A RECOMMENDATION — which of this
 * buyer's saved homes are worth seeing, resolved against whichever property
 * source serves the tenant, with the ones no source could answer named — exists
 * NOWHERE else in the product, and it is genuinely a different act from planning
 * an agreed tour. What is not different is the ORDER and the MINUTES, so those
 * come from lib/kernel/tour-optimizer.ts now (real coordinates, haversine at a
 * documented 30mph ESTIMATE, un-geocodable homes kept in place with no invented
 * drive) instead of from a model.
 *
 * So this is ONE door, not two: shortlist here → "Plan this as a tour" on the
 * plan card below (ShowingPlanTourHandoff, same file) →
 * app/actions/tour-planner.ts:createTourFromShowingRecommendation → the tour
 * lane at /crm/contacts/[contactId]/tours, where a tour can actually be
 * scheduled, confirmed, walked and recapped. Nothing here schedules anything;
 * that is the tour lane's job and it keeps it.
 *
 * ─── THE ORIGINAL NOTE, KEPT: THE DOOR THE "AI SHOWING PLAN" CARD NEVER HAD ──
 *
 * app/crm/contacts/[contactId]/page.tsx renders an "AI Showing Plan" card off
 * `smart_showing_recommendations`. That card is complete — it resolves both
 * target classes (the contact directly, or any of the contact's leads) and
 * renders the ordered route with arrival times and talking points — and it has
 * never shown a row to anybody, because the ONLY writer of that table,
 * app/actions/ai-predictions.ts:optimizeShowingRoute, had no caller anywhere in
 * the product.
 *
 * The note on that writer says so in as many words and names the reason the wire
 * was left undone: "That reader lives on app/crm/**, which is outside the surface
 * set this pass may edit, so the wire is left for the pass that owns it." This is
 * that wire (orphan doctrine §1.2 — one half was built, the other half is built
 * here, and nothing is deleted).
 *
 * WHY THIS SURFACE AND NOT A NEW PAGE: the route is built FOR one buyer out of
 * the homes that buyer has saved, and both of those already live here — the
 * buyer's contact record and their `saved_properties`. A separate route-planner
 * page would have to re-establish both.
 *
 * IDENTITY CLASS. `contactId` is a contacts.id and the action refuses anything
 * else outright ("Showing routes are built for contacts only") — it is the class
 * the row's `contact_id` column takes and the class this page is keyed on. No
 * leads.id is passed and none is substituted.
 *
 * TENANT. Nothing here supplies a brokerage: optimizeShowingRoute resolves the
 * tenant from the SESSION (users.brokerage_id for the signed-in caller) and
 * stamps the row with it, which is also what makes the row readable at all —
 * `smart_showing_recommendations_select` is has_brokerage_access(brokerage_id),
 * and has_brokerage_access(NULL) is false for everyone.
 *
 * WHAT WE SEND PER SAVED HOME, AND WHY IT IS TWO IDENTIFIERS AND NOT ONE.
 * The action resolves each home through whichever source serves this tenant —
 * the PLATFORM's RentCast by default, the tenant's own IDX Broker feed when they
 * have connected one (owner ruling; the precedence lives in
 * lib/property/listing-source.ts). The two sources do not resolve a home the same
 * way: an IDX feed takes a free-text query, and an MLS number is the precise form
 * of it, while RentCast resolves a POSTAL ADDRESS. Sending only the IDX query —
 * which is what this surface used to send — left every MLS-numbered saved home
 * unresolvable the moment RentCast, the default, was the source.
 *
 * So each home goes out with both: `idxQuery` (MLS number, else the address) and
 * `address` (null when the saved home has none on file). A saved home that
 * carries NEITHER an MLS number nor an address cannot be looked up by any source,
 * so it is shown as un-selectable rather than silently dropped from a route the
 * agent thinks it is in — and a home that a source simply could not answer comes
 * back named in `unresolved` and is shown here, for the same reason.
 */

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Route, Loader2, CalendarPlus } from "lucide-react"
import { optimizeShowingRoute } from "@/app/actions/ai-predictions"
import { createTourFromShowingRecommendation } from "@/app/actions/tour-planner"

interface SavedHome {
  id: string
  property_address: string | null
  mls_number: string | null
  city: string | null
  state: string | null
  list_price: number | null
}

/** What each source needs to resolve this home — or null when neither can. */
interface HomeReference {
  /** The free-text query an IDX feed resolves by. MLS number first, else the address. */
  idxQuery: string
  /** The postal address RentCast resolves by. Null when the home has none on file. */
  address: string | null
  /** What to call this home when a source could not answer for it. */
  label: string
}

function referenceFor(h: SavedHome): HomeReference | null {
  const mls = h.mls_number?.trim()
  const street = h.property_address?.trim()
  const address = street ? [street, h.city?.trim(), h.state?.trim()].filter(Boolean).join(", ") : null
  const idxQuery = mls || address
  if (!idxQuery) return null
  return { idxQuery, address, label: street || (mls ? `MLS ${mls}` : "Saved home") }
}

export function ShowingRoutePlanner({ contactId }: { contactId: string }) {
  const router = useRouter()
  const [homes, setHomes] = useState<SavedHome[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [date, setDate] = useState<string>(() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  })
  const [startLocation, setStartLocation] = useState("")
  /** The day's start clock. The kernel walks it stop by stop to produce arrival
   *  times, and `createTourPlan` needs it if this shortlist becomes a tour. */
  const [startTime, setStartTime] = useState("10:00")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Homes the chosen source could not answer for, with the reason it gave. */
  const [unresolved, setUnresolved] = useState<Array<{ home: string; why: string }>>([])
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()
    supabase
      .from("saved_properties")
      .select("id, property_address, mls_number, city, state, list_price")
      .eq("contact_id", contactId)
      .eq("dismissed", false)
      .order("saved_at", { ascending: false })
      .then(({ data, error }: { data: SavedHome[] | null; error: { message: string } | null }) => {
        if (cancelled) return
        // A REFUSED READ IS NOT AN EMPTY SHORTLIST. supabase-js resolves a denied
        // query, so returning [] here would tell the agent this buyer has saved
        // nothing when the truth is that we could not look.
        if (error) { setLoadError(error.message); setHomes([]); return }
        setHomes(data ?? [])
      })
    return () => { cancelled = true }
  }, [contactId])

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function build() {
    setError(null)
    setNotice(null)
    setUnresolved([])

    const chosen = (homes ?? []).filter((h) => selected.has(h.id))
    const queries = chosen.map(referenceFor).filter((q): q is HomeReference => !!q)
    if (queries.length < 2) {
      setError("Pick at least two saved homes — a route needs somewhere to go and somewhere to go next.")
      return
    }
    if (!startLocation.trim()) {
      setError("Where does the day start? The order is measured from that point.")
      return
    }
    if (!/^\d{1,2}:\d{2}$/.test(startTime)) {
      setError("Pick a start time — the arrival times are walked forward from it.")
      return
    }

    startTransition(async () => {
      try {
        const res = await optimizeShowingRoute({
          contactId,
          properties: queries,
          preferredDate: date,
          startLocation: startLocation.trim(),
          startTime,
        })
        // HOMES THE SOURCE COULD NOT ANSWER ARE SHOWN WHETHER OR NOT THE PLAN
        // SAVED. They come back on both outcomes — a plan built over four of six
        // homes is a different plan from the one the agent asked for, and a
        // refusal (an exhausted vendor budget, an unset platform key) names itself
        // here instead of looking like "this buyer's homes are not for sale".
        setUnresolved(res?.unresolved ?? [])
        // The action reports a REFUSED insert as { success: false, error } while
        // still handing back the route it built. Saying "plan saved" over that
        // would be the exact lie the card was built to avoid — the plan is not on
        // the record, so the card will not show it.
        if (!res?.success) {
          setError(res?.error ?? "The showing plan could not be saved.")
          return
        }
        setNotice(
          "Shortlist saved — it is on the AI Showing Plan card below, ordered by the tour route optimizer. Turn it into a tour from there.",
        )
        setSelected(new Set())
        router.refresh()
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "The showing route could not be built.")
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Route className="h-4 w-4 text-primary" />
          Shortlist homes to tour
        </CardTitle>
        <CardDescription className="text-xs">
          Pick the saved homes worth seeing. Each is looked up in this brokerage&apos;s property
          source, then ordered by the same tour route optimizer the tour lane runs — real
          coordinates, straight-line drive estimates, nothing invented for a home it cannot
          place. The shortlist lands on the AI Showing Plan card below, where it can become a
          real tour.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {homes === null ? (
          <p className="text-xs text-muted-foreground">Loading this buyer&apos;s saved homes…</p>
        ) : loadError ? (
          <p className="text-xs text-destructive">
            Could not read this buyer&apos;s saved homes: {loadError}
          </p>
        ) : homes.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No saved homes yet — save a few from the buyer&apos;s search and the route builds from those.
          </p>
        ) : (
          <ul className="space-y-1.5 max-h-64 overflow-y-auto">
            {homes.map((h) => {
              const query = referenceFor(h)
              return (
                <li key={h.id}>
                  <label
                    className={`flex items-start gap-2.5 rounded-md border p-2 text-sm ${
                      query ? "cursor-pointer" : "opacity-60"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selected.has(h.id)}
                      disabled={!query || isPending}
                      onChange={() => toggle(h.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {h.property_address ?? "Saved home"}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {[
                          [h.city, h.state].filter(Boolean).join(", ") || null,
                          h.list_price != null ? `$${Number(h.list_price).toLocaleString()}` : null,
                          h.mls_number ? `MLS ${h.mls_number}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {!query && (
                        <span className="block text-xs text-amber-700">
                          No MLS number and no address on this saved home — no property source can look it up.
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="showing-route-date" className="text-xs">Tour date</Label>
            <Input
              id="showing-route-date"
              type="date"
              value={date}
              disabled={isPending}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="showing-route-time" className="text-xs">Start time</Label>
            <Input
              id="showing-route-time"
              type="time"
              value={startTime}
              disabled={isPending}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="showing-route-start" className="text-xs">Starting point</Label>
            <Input
              id="showing-route-start"
              placeholder="Office, or the buyer's address"
              value={startLocation}
              disabled={isPending}
              onChange={(e) => setStartLocation(e.target.value)}
            />
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {notice && <p className="text-xs text-emerald-700">{notice}</p>}

        {unresolved.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-2">
            <p className="text-xs font-medium text-amber-900">
              {unresolved.length === 1
                ? "One home is not in this plan:"
                : `${unresolved.length} homes are not in this plan:`}
            </p>
            <ul className="mt-1 space-y-0.5">
              {unresolved.map((u, i) => (
                <li key={`${u.home}-${i}`} className="text-xs text-amber-800">
                  <span className="font-medium">{u.home}</span> — {u.why}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Button size="sm" onClick={build} disabled={isPending || !homes || homes.length === 0}>
          {isPending && <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />}
          Build the shortlist
        </Button>
      </CardContent>
    </Card>
  )
}

/**
 * THE ONE DOOR OUT OF THE RECOMMENDATION AND INTO THE TOUR LANE.
 *
 * The card above produces a recommendation; this turns it into the real thing.
 * app/actions/tour-planner.ts:createTourFromShowingRecommendation writes the
 * tour, its stops and its showings through `createTourPlan` — every gate intact
 * (session tenant, agent seat, buyer financially verified) — and then runs
 * lib/kernel/tour-optimizer.ts over the SAVED tour, which is what stamps
 * tours.total_drive_time_minutes and the showing_routes audit row.
 *
 * WHY A BUTTON AND NOT A SECOND PLANNER: the tour lane already owns scheduling,
 * confirmation, the day-of run and the buyer portal. Rebuilding any of that here
 * is the exact drift this wave was sent to collapse — so the agent lands IN that
 * lane (/crm/contacts/[contactId]/tours) rather than in a parallel copy of it.
 *
 * A REFUSAL IS SHOWN, NOT SWALLOWED. "The buyer is not financially verified" and
 * "the plan was saved" must never render as the same screen.
 */
export function ShowingPlanTourHandoff({
  contactId,
  recommendationId,
}: {
  contactId: string
  recommendationId: string
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function plan() {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      try {
        const res = await createTourFromShowingRecommendation({ recommendationId })
        if (!res.success || !res.tourId) {
          setError(res.error ?? "The tour could not be created from this plan.")
          return
        }
        setNotice(
          `Tour created — ${res.stopCount} stop${res.stopCount === 1 ? "" : "s"}. ${res.optimized ?? ""} Opening the tour lane…`,
        )
        router.push(`/crm/contacts/${contactId}/tours?tab=confirm`)
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "The tour could not be created from this plan.")
      }
    })
  }

  return (
    <div className="space-y-2 pt-1">
      <Button size="sm" variant="outline" onClick={plan} disabled={isPending}>
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
        ) : (
          <CalendarPlus className="h-3.5 w-3.5 mr-2" />
        )}
        Plan this as a tour
      </Button>
      <p className="text-xs text-muted-foreground">
        Creates the tour, its stops and its showings in the tour lane, then re-runs the same
        route optimizer over the saved tour. Scheduling, confirmations and the day-of run
        happen there.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {notice && <p className="text-xs text-emerald-700">{notice}</p>}
    </div>
  )
}
