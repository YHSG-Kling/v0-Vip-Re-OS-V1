"use client"

import { useState, useTransition } from "react"
import { stageVideoAction, approveStagedVideoAction } from "./actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

interface StagedVideo {
  id: string
  title: string | null
  videoType: string | null
  stage: string
  blockers: string[]
  channels: string[]
  approverUserIds: string[]
  approvalStatus: string | null
}

const STAGE_LABEL: Record<string, string> = {
  generated: "Generated",
  playable: "Playable",
  rights_branding_checked: "Rights & branding checked",
  audience_channel_chosen: "Audience & channel chosen",
  approver_assigned: "Awaiting the assigned approver",
  approved: "Approved",
  published: "Published",
}

export function VideoStagingClient({ videos, userId }: { videos: StagedVideo[]; userId: string }) {
  const [note, setNote] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const stage = (id: string) => startTransition(async () => {
    const r = await stageVideoAction(id)
    setNote(r.success ? `Staged: ${r.stage ? STAGE_LABEL[r.stage] ?? r.stage : "not staged"}${r.blockers.length ? ` — ${r.blockers.join("; ")}` : ""}` : `Not staged: ${r.error}`)
  })
  const approve = (id: string) => startTransition(async () => {
    const r = await approveStagedVideoAction(id)
    setNote(r.success ? "Approved — it publishes on the channels its staging chose, under your brokerage's policy." : `Not approved: ${r.error}`)
  })

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Video staging</h1>
        <p className="text-sm text-muted-foreground">Non-listing videos are checked for rights and branding, given an audience and channels, and approved by the person your authority settings assign before anything is published.</p>
      </div>
      {note && <p role="status" className="text-sm text-foreground">{note}</p>}
      {videos.length === 0 ? (
        <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">Nothing staged yet — no non-listing video is waiting for its checks or its approver.</p></CardContent></Card>
      ) : (
        <ul className="space-y-3">
          {videos.map((v) => {
            const mayApprove = v.stage === "approver_assigned" && v.approverUserIds.includes(userId)
            return (
              <li key={v.id}>
                <Card>
                  <CardContent className="p-4 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{v.title ?? (v.videoType ?? "video").replace(/_/g, " ")}</span>
                      <span className="text-xs font-medium text-muted-foreground">{STAGE_LABEL[v.stage] ?? v.stage}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {(v.videoType ?? "video").replace(/_/g, " ")} · channels: {v.channels.length ? v.channels.join(", ").replace("landing_page", "landing page") : "none chosen"}
                    </p>
                    {v.blockers.length > 0 && (
                      <ul className="list-disc pl-5 text-xs text-destructive">
                        {v.blockers.map((b) => <li key={b}>{b}</li>)}
                      </ul>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" className="h-9" disabled={pending} onClick={() => stage(v.id)}>Re-run staging checks</Button>
                      {mayApprove && <Button size="sm" className="h-9" disabled={pending} onClick={() => approve(v.id)}>Approve for publication</Button>}
                    </div>
                  </CardContent>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
