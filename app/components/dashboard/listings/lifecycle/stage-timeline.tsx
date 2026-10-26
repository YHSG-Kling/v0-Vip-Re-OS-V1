"use client"

import { useState } from "react"
import { Calendar, AlertTriangle, CheckCircle2, Pencil, Check, X, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { updateListingDate } from "@/app/actions/listing-dates"
import { computeDaysOnMarketForListing, resolveMlsLiveDates, ymdOf, type MlsLiveDateColumns } from "@/lib/listings/compute-dom"

interface LifecycleEvent {
  id: string
  event_type: string
  metadata: Record<string, any> | null
  actor_user_id: string | null
  created_at: string
}

interface Listing extends MlsLiveDateColumns {
  id: string
  go_live_date: string | null
  open_house_marketing_date: string | null
  open_house_event_date: string | null
  /** listings.metadata — only `mls_live_check` (the last feed check) is read here. */
  metadata?: { mls_live_check?: { checked_at?: string; verdict?: string } } | null
}

interface Props {
  listing: Listing
  lifecycleEvents: LifecycleEvent[]
  /** The newest listing agreement's ladder state + execution stamp (wave 143, lane 143A). */
  agreement?: { esign_status: string | null; fully_executed_at: string | null } | null
  /** The stage machine's stage — the coming-soon / marketing status is read off it. */
  lifecycleStage?: string | null
  /** Wave 144 (lane 144Z): time in each stage (listing_stage_history via app/actions/listings.ts getListingTimeline).
   *  null = the read failed (said, never rendered as "none"); undefined = not provided. */
  stageDurations?: Array<{ stage: string; enteredAt: string | null; exitedAt: string | null; days: number | null; isOverride: boolean }> | null
}

type DateField = "go_live_date" | "open_house_marketing_date" | "open_house_event_date"

/** A calendar day (yyyy-mm-dd) or a timestamp, rendered without the UTC→local day shift `new Date("2026-10-25")`
 *  causes in every US timezone (it would show the 24th). Timestamps keep their instant; days render as days. */
function fmtDate(iso: string | null) {
  if (!iso) return null
  const day = ymdOf(iso)
  if (day && iso.length <= 10) {
    return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
  }
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

const FEED_LABEL: Record<string, string> = { rentcast: "RentCast", idx: "your IDX feed" }
const BASIS_LABEL: Record<string, string> = { feed_list_date: "the feed's own list date", first_observed: "the first day we saw it live" }
/** The coming-soon / marketing status, read off the stage machine (not a date, not a column). */
function comingSoonLabel(stage: string | null | undefined): string | null {
  if (stage === "COMING_SOON_ACTIVE") return "Coming soon — announced publicly"
  if (stage === "MLS_DATE_CONFIRMED" || stage === "COMING_SOON_PREP" || stage === "REPAIRS_IN_PROGRESS" || stage === "MEDIA_APPROVED" || stage === "MLS_READY") return "Coming soon — in preparation (not public)"
  return null
}

function toInputValue(iso: string | null) {
  if (!iso) return ""
  return iso.slice(0, 10) // "YYYY-MM-DD"
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
}

export function StageTimeline({ listing, lifecycleEvents, agreement = null, lifecycleStage = null, stageDurations }: Props) {
  // PLANNED vs VERIFIED, from the one reader (lib/listings/compute-dom.ts). A planned date is NEVER shown as live.
  const mls = resolveMlsLiveDates(listing)
  // DAYS ON MARKET from the same resolver: counted from the VERIFIED live date; a planned date only counts once it has arrived,
  // and the card says which it is (the legacy go_live_date-only readers elsewhere count the plan as if it were live).
  const dom = computeDaysOnMarketForListing(listing)
  const comingSoon = comingSoonLabel(lifecycleStage)
  const lastCheck = listing.metadata?.mls_live_check ?? null
  // Descending order for display
  const events = [...lifecycleEvents].reverse()

  // Inline-edit state
  const [editingField, setEditingField] = useState<DateField | null>(null)
  const [editValue, setEditValue] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Local date values (optimistically updated on save)
  const [dates, setDates] = useState({
    go_live_date: listing.go_live_date,
    open_house_marketing_date: listing.open_house_marketing_date,
    open_house_event_date: listing.open_house_event_date,
  })

  function startEdit(field: DateField) {
    setEditingField(field)
    setEditValue(toInputValue(dates[field]))
  }

  function cancelEdit() {
    setEditingField(null)
    setEditValue("")
  }

  async function saveEdit(field: DateField) {
    setSaving(true)
    setSaveError(null)
    const result = await updateListingDate(listing.id, field, editValue || null)
    if (result.success) {
      setDates(prev => ({ ...prev, [field]: editValue || null }))
    } else {
      // A refused save is SAID (wave 143, lane 143A) — it used to close the editor as if it had worked.
      setSaveError(result.error ?? "The date was not saved")
    }
    setSaving(false)
    setEditingField(null)
    setEditValue("")
  }

  return (
    <div>
      {/* Date summary cards */}
      <div className="p-4 border-b border-border space-y-2">
        <h2 className="text-sm font-semibold text-foreground mb-3">Key Dates</h2>
        {saveError && <p role="alert" className="text-[11px] text-destructive">{saveError}</p>}

        <EditableDateCard
          label="MLS Live — planned"
          field="go_live_date"
          value={fmtDate(dates.go_live_date)}
          sub={dates.go_live_date
            ? `A plan, not a fact${mls.timezone ? ` · ${mls.timezone}` : ""}${mls.basis === "planned" && mls.plannedInFuture ? " · not yet due" : ""}`
            : "Set it so compliance can move the listing to coming soon"}
          icon={<Calendar className="w-3.5 h-3.5" />}
          editing={editingField === "go_live_date"}
          editValue={editValue}
          saving={saving && editingField === "go_live_date"}
          onEdit={() => startEdit("go_live_date")}
          onCancel={cancelEdit}
          onSave={() => saveEdit("go_live_date")}
          onChangeEditValue={setEditValue}
        />
        {/* VERIFIED — read-only: only a syndication feed writes this; nothing typed here can. */}
        <ReadOnlyDateCard
          label="MLS Live — verified"
          value={mls.actual ? fmtDate(mls.actual) : null}
          emptyText="Not verified yet"
          sub={mls.actual
            ? `Confirmed by ${FEED_LABEL[mls.verifiedSource ?? ""] ?? "a feed"} (${BASIS_LABEL[mls.actualBasis ?? ""] ?? "feed"})`
              + (mls.varianceDays ? ` · ${Math.abs(mls.varianceDays)}d ${mls.varianceDays > 0 ? "after" : "before"} plan` : "")
              + (dom.basis === "verified" && dom.days !== null ? ` · ${dom.days} day${dom.days === 1 ? "" : "s"} on market` : "")
            : lastCheck?.checked_at
              ? `Last checked ${fmtDate(lastCheck.checked_at)} — ${lastCheck.verdict ?? "no verdict"}`
              : "Checked against RentCast / IDX once the listing is launched"}
          icon={<CheckCircle2 className="w-3.5 h-3.5" />}
        />
        <ReadOnlyDateCard
          label="Listing agreement executed"
          value={agreement?.fully_executed_at ? fmtDate(agreement.fully_executed_at) : null}
          emptyText={agreement ? "Awaiting compliance approval" : "No agreement yet"}
          sub={agreement && !agreement.fully_executed_at ? `Signatures: ${agreement.esign_status ?? "pending"} — executed only after compliance approves` : undefined}
          icon={<Calendar className="w-3.5 h-3.5" />}
        />
        {comingSoon && (
          <p className="text-[10px] text-muted-foreground px-1">{comingSoon}</p>
        )}
        <EditableDateCard
          label="OH Marketing"
          field="open_house_marketing_date"
          value={fmtDate(dates.open_house_marketing_date)}
          sub="Friday before go-live"
          icon={<Calendar className="w-3.5 h-3.5" />}
          editing={editingField === "open_house_marketing_date"}
          editValue={editValue}
          saving={saving && editingField === "open_house_marketing_date"}
          onEdit={() => startEdit("open_house_marketing_date")}
          onCancel={cancelEdit}
          onSave={() => saveEdit("open_house_marketing_date")}
          onChangeEditValue={setEditValue}
        />
        <EditableDateCard
          label="OH Event"
          field="open_house_event_date"
          value={fmtDate(dates.open_house_event_date)}
          sub="Saturday after go-live"
          icon={<Calendar className="w-3.5 h-3.5" />}
          editing={editingField === "open_house_event_date"}
          editValue={editValue}
          saving={saving && editingField === "open_house_event_date"}
          onEdit={() => startEdit("open_house_event_date")}
          onCancel={cancelEdit}
          onSave={() => saveEdit("open_house_event_date")}
          onChangeEditValue={setEditValue}
        />
      </div>

      {/* Time in each stage — listing_stage_history (wave 144, lane 144Z) */}
      {stageDurations !== undefined && (
        <div className="px-4 pt-4">
          <h2 className="text-sm font-semibold text-foreground mb-2">Time in each stage</h2>
          {stageDurations === null ? (
            <p className="text-xs text-destructive">The stage durations could not be read.</p>
          ) : stageDurations.length === 0 ? (
            <p className="text-xs text-muted-foreground">No completed stage recorded yet</p>
          ) : (
            <ul className="space-y-1">
              {stageDurations.map((d, i) => (
                <li key={`${d.stage}-${i}`} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-foreground truncate">{d.stage.replace(/_/g, " ").toLowerCase()}{d.isOverride ? " (override)" : ""}</span>
                  <span className="text-muted-foreground shrink-0">{d.days !== null ? `${Math.round(d.days * 10) / 10} d` : d.exitedAt ? "—" : "in progress"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Timeline */}
      <div className="p-4">
        <h2 className="text-sm font-semibold text-foreground mb-3">Stage History</h2>

        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No transitions recorded yet</p>
        ) : (
          <ol className="relative border-l border-border ml-2 space-y-4">
            {events.map((evt) => {
              const isOverride = evt.metadata?.is_override === true
              const isFailed   = evt.event_type?.includes("FAILED")
              const toState    = evt.metadata?.to_state as string | undefined
              const fromState  = evt.metadata?.from_state as string | undefined
              const notes      = evt.metadata?.notes as string | undefined

              return (
                <li key={evt.id} className="ml-4">
                  {/* Dot */}
                  <span className={cn(
                    "absolute -left-1.5 flex h-3 w-3 rounded-full border-2 border-card",
                    isFailed   ? "bg-destructive" :
                    isOverride ? "bg-amber-400" :
                    "bg-primary"
                  )} />

                  <div className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                    {/* Stage transition */}
                    <div className="flex items-center gap-1.5 font-medium text-foreground">
                      {toState ? (
                        <>
                          {fromState && (
                            <span className="text-muted-foreground">
                              {fromState.replace(/_/g, " ").toLowerCase()}
                            </span>
                          )}
                          {fromState && <span className="text-muted-foreground">→</span>}
                          <span>{toState.replace(/_/g, " ").toLowerCase()}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">{evt.event_type}</span>
                      )}
                    </div>

                    {/* Badges */}
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {isOverride && (
                        <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold border border-amber-200">
                          <AlertTriangle className="w-2.5 h-2.5" />
                          OVERRIDE
                        </span>
                      )}
                      {isFailed && (
                        <span className="px-1.5 py-0.5 rounded bg-destructive/10 text-destructive text-[10px] font-semibold border border-destructive/20">
                          FAILED
                        </span>
                      )}
                      {!isFailed && !isOverride && (
                        <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[10px] font-medium border border-emerald-200">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          completed
                        </span>
                      )}
                    </div>

                    {/* Notes */}
                    {notes && (
                      <p className="mt-1.5 text-muted-foreground italic line-clamp-2">{notes}</p>
                    )}

                    {/* Failure reason */}
                    {isFailed && evt.metadata?.failure_reason && (
                      <p className="mt-1 text-destructive">{evt.metadata.failure_reason}</p>
                    )}

                    {/* Timestamp */}
                    <p className="mt-1.5 text-muted-foreground/70">{fmtTime(evt.created_at)}</p>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}

/** A date a person cannot type: it is written only by the system that owns it (a feed, the compliance ladder). */
function ReadOnlyDateCard({
  label, value, emptyText, sub, icon,
}: {
  label: string
  value: string | null
  emptyText: string
  sub?: string
  icon: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2">
      <span className="text-muted-foreground flex-shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
        <p className={cn("text-xs font-semibold", value ? "text-foreground" : "text-muted-foreground")}>{value ?? emptyText}</p>
        {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}

function EditableDateCard({
  label,
  value,
  sub,
  icon,
  editing,
  editValue,
  saving,
  onEdit,
  onCancel,
  onSave,
  onChangeEditValue,
}: {
  label: string
  field: DateField
  value: string | null
  sub?: string
  icon: React.ReactNode
  editing: boolean
  editValue: string
  saving: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
  onChangeEditValue: (v: string) => void
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2">
      <span className="text-muted-foreground flex-shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
        {editing ? (
          <div className="flex items-center gap-1 mt-0.5">
            <input
              type="date"
              value={editValue}
              onChange={e => onChangeEditValue(e.target.value)}
              className="text-xs border border-border rounded px-1 py-0.5 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary w-full"
              autoFocus
            />
            {saving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground shrink-0" />
            ) : (
              <>
                <button
                  onClick={onSave}
                  className="text-green-600 hover:text-green-700 shrink-0"
                  title="Save"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={onCancel}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                  title="Cancel"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 group">
            <p className="text-xs font-semibold text-foreground">{value ?? "Not set"}</p>
            <button
              onClick={onEdit}
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
              title={`Edit ${label}`}
            >
              <Pencil className="w-3 h-3" />
            </button>
          </div>
        )}
        {sub && !editing && <p className="text-[10px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}
