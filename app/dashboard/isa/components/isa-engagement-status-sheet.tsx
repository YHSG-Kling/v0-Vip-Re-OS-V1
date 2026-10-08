"use client"

/**
 * WHAT THE ISA ACTUALLY DID — the read side of AI-ISA engagement.
 *
 * `app/actions/ai-isa/initiate-engagement.ts` has two exports. The WRITE side,
 * `initiateAIISAEngagement`, is wired in four places including the button beside
 * this one. The READ side, `getAIISAEngagementStatus`, had no caller anywhere —
 * so the console could dispatch an email, a call or a mail piece to a lead and
 * then had no way to show what had already been sent to that same lead.
 *
 * Three defects were fixed in the action before it was given this surface, and
 * two of them change what this panel is allowed to claim:
 *
 *   · Its activity read matched `activities.contact_id` against a LEADS id, a
 *     column the ISA's own writer sets to NULL on purpose. The list was always
 *     empty. Fixed to read (entity_type='lead', entity_id), so what is rendered
 *     here is the real touch history rather than a guaranteed blank.
 *   · It ran on the service client with no session and no tenant predicate.
 *     Fixed — this now only ever shows a lead in the caller's own brokerage.
 *
 * INBOUND IS NOT A MEASUREMENT. A lead has no message thread until it converts
 * to a contact, so inbound is a structural zero (`inboundTracked: false`) and is
 * labelled that way. Rendering "0 replies" beside "4 sent" would read as a lead
 * ignoring the agent, when in fact nothing was ever counted.
 */

import { useState } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { History, Loader2 } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { getAIISAEngagementStatus } from "@/app/actions/ai-isa/initiate-engagement"

type Status = Awaited<ReturnType<typeof getAIISAEngagementStatus>>
type StatusOk = Extract<Status, { success: true }>

export function IsaEngagementStatusSheet({
  leadId,
  leadName,
}: {
  leadId: string
  leadName: string
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<StatusOk | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const result = await getAIISAEngagementStatus(leadId)
      if (!result.success) {
        // Unauthorized, a lead outside this brokerage, or a blocked read. None
        // of those is "the ISA has not touched this lead".
        setError(result.error)
        setStatus(null)
        return
      }
      setStatus(result)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void load()
      }}
    >
      <SheetTrigger asChild>
        <Button size="sm" variant="ghost" className="w-full justify-start">
          <History className="mr-1.5 h-3.5 w-3.5" />
          ISA History
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader className="pb-4">
          <SheetTitle className="text-base">AI-ISA engagement</SheetTitle>
          <p className="truncate text-xs text-muted-foreground">{leadName}</p>
        </SheetHeader>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && !loading && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {status && !loading && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border p-2">
                <p className="text-sm font-semibold capitalize">
                  {String(status.currentStage).replace(/_/g, " ")}
                </p>
                <p className="text-[10px] text-muted-foreground">Stage</p>
              </div>
              <div className="rounded-md border p-2">
                <p className="text-sm font-semibold">{status.leadScore}</p>
                <p className="text-[10px] text-muted-foreground">Lead score</p>
              </div>
              <div className="rounded-md border p-2">
                <p className="text-sm font-semibold">
                  {status.assignedToAgent ? "Yes" : "No"}
                </p>
                <p className="text-[10px] text-muted-foreground">Assigned</p>
              </div>
            </div>

            <div className="rounded-md border bg-muted/40 p-3 text-xs">
              <p className="font-medium">
                {status.conversationStats.outboundMessages} ISA outreach
                {status.conversationStats.outboundMessages === 1 ? "" : "es"} logged
              </p>
              <p className="mt-0.5 text-muted-foreground">
                Replies are not counted for a lead — a message thread only exists once the
                lead becomes a contact. This is not a count of zero replies.
              </p>
            </div>

            <div>
              <p className="text-sm font-medium">Touch history</p>
              {status.activities.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  No AI-ISA email, conversation, qualification or direct-mail activity is
                  recorded against this lead.
                </p>
              ) : (
                <div className="mt-1.5 space-y-1.5">
                  {status.activities.map((a) => (
                    <div key={a.id as string} className="rounded-md border p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {String(a.activity_type ?? "").replace(/^ai_isa_/, "").replace(/_/g, " ")}
                        </Badge>
                        {a.status && (
                          <span
                            className={
                              a.status === "failed"
                                ? "text-destructive"
                                : "text-muted-foreground"
                            }
                          >
                            {String(a.status)}
                          </span>
                        )}
                        {a.created_at && (
                          <span className="ml-auto text-muted-foreground">
                            {formatDistanceToNow(new Date(a.created_at as string), { addSuffix: true })}
                          </span>
                        )}
                      </div>
                      {a.title && <p className="mt-1 font-medium">{String(a.title)}</p>}
                      {a.description && (
                        <p className="text-muted-foreground">{String(a.description)}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
