"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  Star, MoreVertical, Trash2, Loader2, AlertCircle, CheckCircle2, Clock, Mic, Pencil,
} from "lucide-react"
import { Card } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/app/components/ui/dialog"
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/app/components/ui/dropdown-menu"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Textarea } from "@/app/components/ui/textarea"
import { toast } from "sonner"
import { setDefaultTwin, deleteTwin, updateTwinDetails, type Twin } from "@/app/actions/twin-studio"
import { TwinVoiceStep } from "./twin-voice-step"

interface Props {
  twin: Twin
  canEdit: boolean
}

export function TwinCard({ twin, canEdit }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [hoverPreview, setHoverPreview] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editLabel, setEditLabel] = useState(twin.label)
  const [editPersonality, setEditPersonality] = useState(twin.personality ?? "")

  function handleSaveDetails() {
    startTransition(async () => {
      const res = await updateTwinDetails({
        twinId: twin.id,
        label: editLabel,
        personality: editPersonality,
      })
      if (res.ok) {
        toast.success("Twin updated")
        setEditOpen(false)
        router.refresh()
      } else {
        toast.error(res.error ?? "Couldn't save")
      }
    })
  }

  function handleSetDefault() {
    startTransition(async () => {
      const res = await setDefaultTwin(twin.id)
      if (res.ok) toast.success("Default twin updated")
      else toast.error(res.error ?? "Couldn't update default")
    })
  }

  function handleDelete() {
    if (!confirm(`Delete "${twin.label}"? This can't be undone.`)) return
    startTransition(async () => {
      const res = await deleteTwin(twin.id)
      if (res.ok) toast.success("Twin deleted")
      else toast.error(res.error ?? "Couldn't delete")
    })
  }

  const usable = twin.status === "ready" && twin.approvalStatus === "approved"

  return (
    <Card className="overflow-hidden flex flex-col">
      {/* Avatar preview */}
      <div
        className="aspect-square bg-muted relative"
        onMouseEnter={() => setHoverPreview(true)}
        onMouseLeave={() => setHoverPreview(false)}
      >
        {/* THE FINISHED AVATAR FIRST. `avatarUrl` is the copy we re-hosted in
            our own Supabase bucket once D-ID finished — the url every other
            surface uses, and the only one that does not expire. The raw upload
            is the fallback while processing is still in flight. */}
        {twin.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={twin.avatarUrl} alt={twin.label} className="w-full h-full object-cover" />
        ) : twin.sourceType === "video" ? (
          <video
            src={twin.sourceUrl}
            className="w-full h-full object-cover"
            muted
            playsInline
            autoPlay={hoverPreview}
            loop
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={twin.sourceUrl} alt={twin.label} className="w-full h-full object-cover" />
        )}

        {twin.isDefault && (
          <Badge className="absolute top-2 left-2 bg-primary text-primary-foreground gap-1">
            <Star className="h-3 w-3 fill-current" /> Default
          </Badge>
        )}

        <StatusBadge status={twin.status} approvalStatus={twin.approvalStatus} />
      </div>

      {/* Body */}
      <div className="p-3 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{twin.label}</p>
            {twin.personality && (
              <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{twin.personality}</p>
            )}
          </div>
          {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 -mr-1 -mt-1" disabled={pending}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* `canEdit` promised an edit affordance this card never had —
                    updateTwinDetails was written for exactly this and had no
                    caller, so a twin's name and personality were fixed at
                    creation and the only way to change either was to delete the
                    twin and rebuild it. */}
                <DropdownMenuItem
                  onClick={() => {
                    setEditLabel(twin.label)
                    setEditPersonality(twin.personality ?? "")
                    setEditOpen(true)
                  }}
                >
                  <Pencil className="h-4 w-4 mr-2" /> Rename / edit personality
                </DropdownMenuItem>
                {!twin.isDefault && (
                  <DropdownMenuItem onClick={handleSetDefault} disabled={!usable}>
                    <Star className="h-4 w-4 mr-2" /> Set as default
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={handleDelete} className="text-destructive">
                  <Trash2 className="h-4 w-4 mr-2" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* A TWIN WITH NO VOICE CANNOT SPEAK, so "No voice yet" is a job, not a
            status line. It used to be a dead amber dot: the wizard's voice step
            is skippable and nothing anywhere led the agent back to it, so a
            skipped voice was permanent unless they guessed to build a second
            twin. This opens the SAME step the wizard shows — clone or stock. */}
        <div className="flex items-center justify-between gap-2 mt-2 text-xs text-muted-foreground">
          {twin.voiceId ? (
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Voice ready
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              No voice yet
            </span>
          )}
          {canEdit && !twin.voiceId && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px] gap-1"
              onClick={() => setVoiceOpen(true)}
            >
              <Mic className="h-3 w-3" />
              Add a voice
            </Button>
          )}
        </div>

        {twin.approvalStatus === "rejected" && twin.rejectionReason && (
          <div className="mt-2 rounded border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive flex gap-1.5">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{twin.rejectionReason}</span>
          </div>
        )}
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit this twin</DialogTitle>
            <DialogDescription>
              The name is yours alone. The personality note is added to every conversation this
              twin fronts, so keep it short and specific.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor={`twin-label-${twin.id}`}>Twin name</Label>
              <Input
                id={`twin-label-${twin.id}`}
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                maxLength={64}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor={`twin-personality-${twin.id}`}>Personality</Label>
              <Textarea
                id={`twin-personality-${twin.id}`}
                value={editPersonality}
                onChange={(e) => setEditPersonality(e.target.value)}
                rows={4}
                // Matches the server's own ceiling in updateTwinDetails, which
                // REFUSES rather than truncates — so the box cannot produce a
                // value the action will reject.
                maxLength={2000}
                className="mt-1.5 text-sm"
                placeholder="Warm and reassuring. Lead with empathy. Plain English."
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                {editPersonality.length}/2000
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setEditOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSaveDetails} disabled={pending || !editLabel.trim()}>
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={voiceOpen} onOpenChange={setVoiceOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Give &ldquo;{twin.label}&rdquo; a voice</DialogTitle>
            <DialogDescription>
              Clone your own voice, or pick a professional one from the library.
            </DialogDescription>
          </DialogHeader>
          <TwinVoiceStep
            twinId={twin.id}
            label={twin.label}
            onComplete={() => {
              setVoiceOpen(false)
              // The server action revalidates the Twin Studio path; this pulls
              // the fresh row so the card stops saying "No voice yet".
              router.refresh()
            }}
          />
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function StatusBadge({
  status,
  approvalStatus,
}: { status: Twin["status"]; approvalStatus: Twin["approvalStatus"] }) {
  // Approval state takes precedence over processing state for the badge.
  if (approvalStatus === "rejected") {
    return (
      <Badge variant="destructive" className="absolute top-2 right-2 gap-1">
        <AlertCircle className="h-3 w-3" /> Rejected
      </Badge>
    )
  }
  if (approvalStatus === "pending") {
    return (
      <Badge variant="secondary" className="absolute top-2 right-2 gap-1 bg-amber-100 text-amber-800">
        <Clock className="h-3 w-3" /> Awaiting approval
      </Badge>
    )
  }
  if (status === "pending" || status === "processing") {
    return (
      <Badge variant="secondary" className="absolute top-2 right-2 gap-1 bg-blue-100 text-blue-800">
        <Loader2 className="h-3 w-3 animate-spin" /> Processing
      </Badge>
    )
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="absolute top-2 right-2 gap-1">
        <AlertCircle className="h-3 w-3" /> Failed
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className="absolute top-2 right-2 gap-1 bg-emerald-100 text-emerald-800">
      <CheckCircle2 className="h-3 w-3" /> Ready
    </Badge>
  )
}
