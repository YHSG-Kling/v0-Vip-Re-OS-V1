"use client"

/**
 * MergeContactsDialog — "Find duplicates / Merge" on the contact workspace.
 *
 * Candidates come from findDuplicateContacts (app/actions/crm.ts), which scores
 * with the SAME fuzzy matcher the raw-lead dedup pipeline proves out
 * (lib/lead-pipeline/fuzzy-matcher — name-only matches are shown but never
 * marked confident). The agent picks the SURVIVOR, sees a summary of exactly
 * what moves, and confirms; the extended mergeContacts moves every child table
 * first (checked writes) and aborts before deleting anything if a move fails.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  findDuplicateContacts,
  mergeContacts,
  type DuplicateCandidate,
} from "@/app/actions/crm"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { Loader2, GitMerge, ShieldAlert } from "lucide-react"
import { toast } from "sonner"

export function MergeContactsDialog({
  open,
  onOpenChange,
  contactId,
  contactName,
  agentId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  contactId: string
  contactName: string
  agentId: string
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<DuplicateCandidate[]>([])
  const [selected, setSelected] = useState<DuplicateCandidate | null>(null)
  /** Which record survives: "this" = the open contact, "other" = the candidate. */
  const [survivor, setSurvivor] = useState<"this" | "other">("this")
  const [merging, setMerging] = useState(false)

  useEffect(() => {
    if (!open) return
    setSelected(null)
    setSurvivor("this")
    setError(null)
    setLoading(true)
    findDuplicateContacts(contactId)
      .then((r) => {
        if (r.success) setCandidates(r.candidates)
        else setError(r.error)
      })
      .catch(() => setError("Could not scan for duplicates"))
      .finally(() => setLoading(false))
  }, [open, contactId])

  async function handleMerge() {
    if (!selected) return
    const primaryContactId = survivor === "this" ? contactId : selected.contactId
    const duplicateContactId = survivor === "this" ? selected.contactId : contactId
    setMerging(true)
    try {
      const r = await mergeContacts({ primaryContactId, duplicateContactId, agentId })
      if (r.success) {
        const movedSummary = Object.entries(r.moved ?? {})
          .map(([t, n]) => `${t} (${n})`)
          .join(", ")
        toast.success(`Merged. ${movedSummary ? `Moved: ${movedSummary}.` : "No child rows needed moving."}`)
        onOpenChange(false)
        // Land on the surviving record.
        router.push(`/crm?contact=${primaryContactId}`)
        router.refresh()
      } else {
        toast.error(r.error ?? "Merge failed")
      }
    } catch {
      toast.error("Merge failed")
    } finally {
      setMerging(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-4 w-4" />
            Find duplicates — {contactName}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            No likely duplicates found in this book (scored with the same matcher the
            lead pipeline uses — a shared name alone is never treated as the same person).
          </p>
        ) : !selected ? (
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {candidates.map((c) => (
              <button
                key={c.contactId}
                type="button"
                onClick={() => setSelected(c)}
                className="w-full text-left rounded-md border px-3 py-2 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{c.name}</span>
                  {c.confident ? (
                    <Badge className="text-[10px] bg-emerald-100 text-emerald-700">Strong match</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">Possible — verify first</Badge>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground">score {c.score}</span>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {[c.email, c.phone].filter(Boolean).join(" · ") || "No email or phone on record"}
                </p>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {!selected.confident && (
              <p className="flex items-start gap-1.5 text-xs text-amber-700">
                <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                This match has no shared email or phone — confirm these are truly the
                same person before merging.
              </p>
            )}
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                Which record survives?
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setSurvivor("this")}
                  className={`rounded-md border px-3 py-2 text-left text-sm ${survivor === "this" ? "border-primary bg-primary/5" : ""}`}
                >
                  <span className="font-medium">{contactName}</span>
                  <p className="text-[11px] text-muted-foreground">This contact (open now)</p>
                </button>
                <button
                  type="button"
                  onClick={() => setSurvivor("other")}
                  className={`rounded-md border px-3 py-2 text-left text-sm ${survivor === "other" ? "border-primary bg-primary/5" : ""}`}
                >
                  <span className="font-medium">{selected.name}</span>
                  <p className="text-[11px] text-muted-foreground">{[selected.email, selected.phone].filter(Boolean).join(" · ") || "No identifiers"}</p>
                </button>
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">What happens on merge</p>
              <p>
                All history moves to the survivor first — activities, tasks, messages,
                notes, leads, conversations, portal invites and messages, showings,
                offers, property alerts and interests, segments, and transactions.
              </p>
              <p>
                Then fields merge (survivor&apos;s values win; missing phone/budget/tags/notes
                fill from the duplicate) and the duplicate is soft-deleted. If any history
                fails to move, the merge stops and nothing is deleted.
              </p>
            </div>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => setSelected(null)}>
              ← Back to candidates
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!selected || merging} onClick={handleMerge}>
            {merging && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Merge into survivor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
