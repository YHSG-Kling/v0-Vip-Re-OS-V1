"use client"

/**
 * ReassignContactDialog — the per-contact "Reassign" affordance on the contact
 * workspace header. Principal/manager-gated server-side
 * (app/actions/contact-reassignment.ts); a regular agent opening this sees the
 * server's Forbidden message rather than a fake picker.
 *
 * What moves (mirrors the bulk successor flow, scoped to one contact): the
 * contact row, their leads, their IN-FLIGHT deal roles, their open tasks, and
 * their active property alerts. Portal linkage is contact-scoped and follows
 * automatically. The result line reports exactly what moved — honest counters.
 */

import { useEffect, useState } from "react"
import {
  listReassignTargetsAction,
  reassignContactAction,
  type ReassignTarget,
} from "@/app/actions/contact-reassignment"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

export function ReassignContactDialog({
  open,
  onOpenChange,
  contactId,
  contactName,
  currentAgentId,
  onReassigned,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  contactId: string
  contactName: string
  /** agents.id currently on the contact — filtered out of the picker. */
  currentAgentId: string | null
  onReassigned?: () => void
}) {
  const [targets, setTargets] = useState<ReassignTarget[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [toAgentId, setToAgentId] = useState<string>("")
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setLoadError(null)
    setToAgentId("")
    listReassignTargetsAction()
      .then((r) => {
        if (r.ok) setTargets(r.targets.filter((t) => t.agentId !== currentAgentId))
        else setLoadError(r.error)
      })
      .catch(() => setLoadError("Could not load agents"))
      .finally(() => setLoading(false))
  }, [open, currentAgentId])

  async function handleReassign() {
    if (!toAgentId) return
    setSubmitting(true)
    try {
      const r = await reassignContactAction({ contactId, toAgentId })
      if (r.ok) {
        const parts = [
          "contact moved",
          r.leadsMoved > 0 ? `${r.leadsMoved} lead(s)` : null,
          r.dealRolesMoved > 0 ? `${r.dealRolesMoved} in-flight deal role(s)` : null,
          r.openTasksMoved > 0 ? `${r.openTasksMoved} open task(s)` : null,
          r.alertsMoved > 0 ? `${r.alertsMoved} property alert(s)` : null,
        ].filter(Boolean)
        toast.success(`Reassigned: ${parts.join(", ")}. Portal access follows the contact.`)
        onOpenChange(false)
        onReassigned?.()
      } else {
        toast.error(r.error ?? "Reassignment failed")
      }
    } catch {
      toast.error("Reassignment failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reassign {contactName}</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <p className="text-sm text-red-600">{loadError}</p>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-xs">New agent</Label>
              <Select value={toAgentId} onValueChange={setToAgentId}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Pick an active agent" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={t.agentId} value={t.agentId}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              Moves the contact plus their leads, in-flight deal roles, open tasks, and
              active property alerts. Closed deals and completed tasks keep their history
              with the current agent. Portal access follows the contact automatically.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!toAgentId || submitting || loading || !!loadError} onClick={handleReassign}>
            {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
