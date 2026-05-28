"use client"

import { useState, useTransition } from "react"
import {
  Star, MoreVertical, Trash2, Loader2, AlertCircle, CheckCircle2, Clock,
} from "lucide-react"
import { Card } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/app/components/ui/dropdown-menu"
import { toast } from "sonner"
import { setDefaultTwin, deleteTwin, type Twin } from "@/app/actions/twin-studio"

interface Props {
  twin: Twin
  canEdit: boolean
}

export function TwinCard({ twin, canEdit }: Props) {
  const [pending, startTransition] = useTransition()
  const [hoverPreview, setHoverPreview] = useState(false)

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
        {twin.sourceType === "video" ? (
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

        <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
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
        </div>

        {twin.approvalStatus === "rejected" && twin.rejectionReason && (
          <div className="mt-2 rounded border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive flex gap-1.5">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{twin.rejectionReason}</span>
          </div>
        )}
      </div>
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
