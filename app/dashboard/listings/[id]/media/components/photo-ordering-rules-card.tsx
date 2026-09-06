"use client"

/**
 * PHOTO ORDERING RULES — the missing writer's surface.
 *
 * optimizePhotoOrder honours the caller's ACTIVE photo_ordering_rule, and
 * savePhotoOrderingRule/getPhotoOrderingRules existed complete and tenant-safe
 * (agent resolved from the session) with no caller anywhere — so "Optimize
 * order" could only ever apply the MLS default. This card lets the agent build
 * a room sequence and save it; the newest saved rule becomes the active one.
 */

import { useEffect, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, ListPlus, X } from "lucide-react"
import { getPhotoOrderingRules, savePhotoOrderingRule } from "@/app/actions/photo-management"
import { toast } from "sonner"

/** Same vocabulary optimizePhotoSequence orders by (DEFAULT_ROOM_SEQUENCE). */
const ROOM_TYPES = [
  "exterior_front", "living_room", "kitchen", "primary_bedroom",
  "bathroom", "dining_room", "bedroom", "exterior_back",
]

export function PhotoOrderingRulesCard() {
  const [rules, setRules] = useState<any[]>([])
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [sequence, setSequence] = useState<string[]>([])
  const [prioritizeQuality, setPrioritizeQuality] = useState(true)
  const [isPending, startTransition] = useTransition()

  useEffect(() => { getPhotoOrderingRules().then(setRules) }, [])
  const active = rules.find((r: any) => r.is_active)

  const handleSave = () => {
    startTransition(async () => {
      const result = await savePhotoOrderingRule({ ruleName: name.trim(), roomSequence: sequence, prioritizeHighQuality: prioritizeQuality })
      if (!result.success) { toast.error(result.error ?? "Could not save the rule"); return }
      toast.success(`"${name.trim()}" saved — it is now your active ordering rule`)
      setOpen(false); setName(""); setSequence([])
      setRules(await getPhotoOrderingRules())
    })
  }

  return (
    <div className="mt-3 rounded border bg-muted/40 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground">
          Ordering rule:{" "}
          {active
            ? <span className="text-foreground font-medium">"{active.rule_name}" ({(active.room_sequence ?? []).map((r: string) => r.replace(/_/g, " ")).join(" → ")})</span>
            : <span>none — "Optimize order" uses the MLS default sequence</span>}
        </p>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setOpen((o) => !o)}>
          <ListPlus className="h-3 w-3 mr-1" /> {open ? "Cancel" : active ? "New rule" : "Create rule"}
        </Button>
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rule name (e.g. Luxury flow)"
            className="w-full rounded border bg-background px-2 py-1" />
          <p className="text-muted-foreground">Tap rooms in the order photos should appear:</p>
          <div className="flex flex-wrap gap-1">
            {ROOM_TYPES.filter((r) => !sequence.includes(r)).map((r) => (
              <button key={r} type="button" onClick={() => setSequence((s) => [...s, r])}
                className="rounded border bg-background px-2 py-0.5 capitalize hover:border-primary">{r.replace(/_/g, " ")}</button>
            ))}
          </div>
          {sequence.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {sequence.map((r, i) => (
                <Badge key={r} variant="secondary" className="text-[10px] capitalize">
                  {i + 1}. {r.replace(/_/g, " ")}
                  <button type="button" className="ml-1" onClick={() => setSequence((s) => s.filter((x) => x !== r))}><X className="h-2.5 w-2.5" /></button>
                </Badge>
              ))}
            </div>
          )}
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={prioritizeQuality} onChange={(e) => setPrioritizeQuality(e.target.checked)} />
            Within a room, put higher-quality photos first
          </label>
          <Button size="sm" className="h-7" onClick={handleSave} disabled={isPending || !name.trim() || sequence.length === 0}>
            {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null} Save & make active
          </Button>
        </div>
      )}
    </div>
  )
}
