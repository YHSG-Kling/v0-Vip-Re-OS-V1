"use client"

/**
 * WHO LEADS THIS DEAL, WHAT YOU MAY DO HERE, AND THE REVIEW NOTES (wave 153, lane 153C; directive §153C C1).
 *
 * The agent takes charge; the TC sees and assists active deals and can flag problems (never acts as the agent); compliance reviews
 * and annotates throughout and decides the closing approval. The capabilities shown come from the server's stage-aware rule
 * (lib/auth/deal-work-ownership.ts) — this panel never decides access itself. Notes persist on the existing note store.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Users } from "lucide-react"
import { addDealReviewNoteAction, type listDealReviewNotesAction } from "@/app/actions/deal-review-notes"

type Initial = Awaited<ReturnType<typeof listDealReviewNotesAction>>

const ROLE_WORDS: Record<string, string> = { compliance_officer: "Compliance", tc: "Coordinator", agent: "Agent", team_lead: "Team lead", admin: "Admin" }

export function DealOwnershipSection({ entityType, entityId, initial }: { entityType: "transaction" | "listing"; entityId: string; initial: Initial }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [body, setBody] = useState("")
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  if (!initial.success) {
    return <Card className="mt-6"><CardHeader><CardTitle className="text-base">Roles and review notes</CardTitle></CardHeader><CardContent><p className="text-sm text-muted-foreground">{initial.error}</p></CardContent></Card>
  }
  const a = initial.access
  const submit = (kind: "review_note" | "flag") => start(async () => {
    setMessage(null)
    const r = await addDealReviewNoteAction({ entityType, entityId, kind, body })
    setMessage(r.success ? { ok: true, text: kind === "flag" ? "Flag saved — the agent was notified." : "Review note saved." } : { ok: false, text: r.error })
    if (r.success) { setBody(""); router.refresh() }
  })
  const can: Array<[boolean, string]> = [
    [a.canActAsAgent, "Lead the client side and the deal's decisions"],
    [a.canAssist, "Tasks, documents and follow-ups"],
    [a.canFlag, "Flag a problem"],
    [a.canAnnotate, "Add compliance review notes"],
    [a.closingApproval, "Decide the closing compliance approval"],
  ]

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4" />Roles and review notes</CardTitle>
        <CardDescription>{a.summary}{a.active ? "" : " This deal is no longer active."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-2">
          {can.filter(([ok]) => ok).map(([, label]) => <Badge key={label} variant="secondary">{label}</Badge>)}
        </div>
        {(a.canAnnotate || a.canFlag) && (
          <div className="space-y-2">
            <Textarea rows={3} placeholder={a.canAnnotate ? "Add a review note or flag a problem" : "Flag a problem for the agent"} value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              {a.canAnnotate && <Button size="sm" disabled={pending || body.trim().length < 3} onClick={() => submit("review_note")}>Save review note</Button>}
              {a.canFlag && <Button size="sm" variant="outline" disabled={pending || body.trim().length < 3} onClick={() => submit("flag")}>Flag for the agent</Button>}
            </div>
          </div>
        )}
        {message && <p className={message.ok ? "text-emerald-700" : "text-red-700"}>{message.text}</p>}
        {initial.notes.length === 0 ? (
          <p className="text-muted-foreground">No review notes or flags yet.</p>
        ) : (
          <ul className="space-y-2">
            {initial.notes.map((n) => (
              <li key={n.id} className="rounded border p-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={n.kind === "flag" ? "destructive" : "secondary"}>{n.kind === "flag" ? "Flag" : "Review note"}</Badge>
                  <span>{ROLE_WORDS[n.role ?? ""] ?? "Staff"}{n.mine ? " (you)" : ""}</span>
                  <span>{new Date(n.createdAt).toLocaleString("en-US")}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap">{n.body}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
