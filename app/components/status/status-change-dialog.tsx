"use client"

// app/components/status/status-change-dialog.tsx
// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT C23 — the ONE place a person gives the reason (and, where the value needs it, the proof) for a manual status
// change (wave 148, lane 148I; owner ruling 13: "manual status picking is always a choice but human needs to provide proof
// or reason of the change"). Every status picker opens this before it calls its server door; the server door asks the SAME
// decision (lib/kernel/status-override.ts decideStatusOverride) — this dialog is the courtesy, the door is the gate.

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  OVERRIDE_REASON_MIN_CHARS, STATUS_ENTITIES, STATUS_EVIDENCE_LABELS, statusLabel,
  type StatusEntity, type StatusEvidence, type StatusEvidenceKind, type StatusValuePolicy,
} from "@/lib/kernel/status-override"

export interface StatusChange { reason: string; evidence: StatusEvidence | null }

interface StatusChangeDialogProps {
  entity: StatusEntity
  from: string | null
  to: string | null
  open: boolean
  pending?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (change: StatusChange) => void
}

export function StatusChangeDialog({ entity, from, to, open, pending, onOpenChange, onConfirm }: StatusChangeDialogProps) {
  const [reason, setReason] = useState("")
  const policy: StatusValuePolicy | undefined = to ? (STATUS_ENTITIES[entity].policy as Record<string, StatusValuePolicy>)[to] : undefined
  const kinds = (policy?.evidence ?? []) as readonly StatusEvidenceKind[]
  const [kind, setKind] = useState<StatusEvidenceKind | "">("")
  const [ref, setRef] = useState("")
  const needsEvidence = kinds.length > 0
  const reasonOk = reason.trim().length >= OVERRIDE_REASON_MIN_CHARS
  const evidenceOk = !needsEvidence || (!!kind && ref.trim().length >= 3)

  const reset = () => { setReason(""); setKind(""); setRef("") }
  const close = (o: boolean) => { if (!o) reset(); onOpenChange(o) }
  const confirm = () => {
    if (!reasonOk || !evidenceOk) return
    onConfirm({ reason: reason.trim(), evidence: needsEvidence && kind ? { kind, ref: ref.trim() } : null })
    reset()
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change status to {statusLabel(entity, to)}</DialogTitle>
          <DialogDescription>
            {statusLabel(entity, from)} → {statusLabel(entity, to)}. Every manual status change is recorded with who made it and why
            {needsEvidence ? ", and this one needs proof" : ""}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="status-change-reason">Reason</Label>
            <Textarea
              id="status-change-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What happened, and how you know"
              aria-describedby="status-change-reason-hint"
            />
            <p id="status-change-reason-hint" className="text-xs text-muted-foreground">
              At least {OVERRIDE_REASON_MIN_CHARS} characters ({reason.trim().length} so far).
            </p>
          </div>
          {needsEvidence && (
            <div className="space-y-2">
              <Label htmlFor="status-change-evidence-kind">Proof</Label>
              <p className="text-xs text-muted-foreground">{policy?.evidenceHint ?? "A reference the office can check."}</p>
              <Select value={kind} onValueChange={(v) => setKind(v as StatusEvidenceKind)}>
                <SelectTrigger id="status-change-evidence-kind" aria-label="Kind of proof"><SelectValue placeholder="Choose the kind of proof" /></SelectTrigger>
                <SelectContent>
                  {kinds.map((k) => <SelectItem key={k} value={k}>{STATUS_EVIDENCE_LABELS[k]}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input aria-label="Proof reference" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Document id, MLS number or file number" />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={pending}>Keep {statusLabel(entity, from)}</Button>
          <Button onClick={confirm} disabled={pending || !reasonOk || !evidenceOk}>Change status</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
