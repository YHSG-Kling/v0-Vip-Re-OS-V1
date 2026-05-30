"use client"

import { useState } from "react"
import { Calendar, AlertTriangle, CheckCircle2, Pencil, Check, X, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { updateListingDate } from "@/app/actions/listing-dates"

interface LifecycleEvent {
  id: string
  event_type: string
  metadata: Record<string, any> | null
  actor_user_id: string | null
  created_at: string
}

interface Listing {
  id: string
  go_live_date: string | null
  open_house_marketing_date: string | null
  open_house_event_date: string | null
}

interface Props {
  listing: Listing
  lifecycleEvents: LifecycleEvent[]
}

type DateField = "go_live_date" | "open_house_marketing_date" | "open_house_event_date"

function fmtDate(iso: string | null) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
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

export function StageTimeline({ listing, lifecycleEvents }: Props) {
  // Descending order for display
  const events = [...lifecycleEvents].reverse()

  // Inline-edit state
  const [editingField, setEditingField] = useState<DateField | null>(null)
  const [editValue, setEditValue] = useState("")
  const [saving, setSaving] = useState(false)

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
    const result = await updateListingDate(listing.id, field, editValue || null)
    if (result.success) {
      setDates(prev => ({ ...prev, [field]: editValue || null }))
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

        <EditableDateCard
          label="MLS Live"
          field="go_live_date"
          value={fmtDate(dates.go_live_date)}
          icon={<Calendar className="w-3.5 h-3.5" />}
          editing={editingField === "go_live_date"}
          editValue={editValue}
          saving={saving && editingField === "go_live_date"}
          onEdit={() => startEdit("go_live_date")}
          onCancel={cancelEdit}
          onSave={() => saveEdit("go_live_date")}
          onChangeEditValue={setEditValue}
        />
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
