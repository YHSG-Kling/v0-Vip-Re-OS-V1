"use client"

/**
 * AI TRANSACTION COORDINATOR — the surface for app/actions/ai-transaction-coordinator.ts.
 *
 * Four capabilities were complete, exported, and had ZERO callers. Nothing on
 * any page could reach them, so nothing they wrote ever existed:
 *
 *   generateSmartTasks           -> transaction_tasks
 *   predictAndManageDeadlines    -> transaction_deadlines
 *   draftTransactionCommunication-> transaction_communications  (+ the reader,
 *                                   listTransactionCommunications)
 *   generatePostClosingPlan      -> scheduled_touchpoints
 *
 * plus one pure-advisory reader with no write of its own:
 *   aiGenerateDocumentReminders  (app/actions/ai-document-intelligence.ts)
 *
 * EVERY CONTROL HERE REPORTS THE SERVER'S VERDICT, NOT AN OPTIMISTIC ONE.
 * These actions return a proposedCount (what the model suggested) alongside a
 * createdCount / scheduledCount (what the DATABASE now agrees with) and a
 * `skipped` list of per-row refusals. The panel renders the difference. A run
 * that proposes 8 tasks and lands 0 says so — it does not say "Success!".
 */

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Brain,
  CalendarClock,
  CheckSquare,
  Loader2,
  Mail,
  AlertTriangle,
  Bell,
  HeartHandshake,
} from "lucide-react"
import {
  generateSmartTasks,
  predictAndManageDeadlines,
  draftTransactionCommunication,
  generatePostClosingPlan,
  listTransactionCommunications,
} from "@/app/actions/ai-transaction-coordinator"
import { aiGenerateDocumentReminders } from "@/app/actions/ai-document-intelligence"

// The recipient roles + communication types the action's own parameter union
// accepts. Kept in one place so a control can never offer a value the server
// would reject.
const RECIPIENT_ROLES = ["buyer", "seller", "lender", "title", "attorney", "other_agent"] as const
const COMMUNICATION_TYPES = ["update", "request", "reminder", "negotiation", "congratulations"] as const

type RecipientRole = (typeof RECIPIENT_ROLES)[number]
type CommunicationType = (typeof COMMUNICATION_TYPES)[number]

interface CommunicationRow {
  id: string
  recipient_role: string | null
  communication_type: string | null
  ai_draft: string | null
  final_content: string | null
  status: string | null
  sent_at: string | null
  created_at: string | null
}

/** What the server said. Never a hard-coded "Success!". */
interface Verdict {
  ok: boolean
  headline: string
  detail?: string
  skipped?: string[]
}

function VerdictNote({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return null
  return (
    <Alert variant={verdict.ok ? "default" : "destructive"} className="mt-2">
      <AlertDescription className="text-xs space-y-1">
        <p className="font-medium">{verdict.headline}</p>
        {verdict.detail ? <p>{verdict.detail}</p> : null}
        {verdict.skipped && verdict.skipped.length > 0 ? (
          <ul className="list-disc pl-4 space-y-0.5">
            {verdict.skipped.map((s, i) => (
              <li key={i} className="text-[11px] break-words">
                {s}
              </li>
            ))}
          </ul>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

export function AiCoordinatorPanel({
  transactionId,
  stage,
  closeDate,
}: {
  transactionId: string
  stage: string | null
  closeDate: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)

  const [tasksVerdict, setTasksVerdict] = useState<Verdict | null>(null)
  const [deadlinesVerdict, setDeadlinesVerdict] = useState<Verdict | null>(null)
  const [draftVerdict, setDraftVerdict] = useState<Verdict | null>(null)
  const [postCloseVerdict, setPostCloseVerdict] = useState<Verdict | null>(null)
  const [remindersVerdict, setRemindersVerdict] = useState<Verdict | null>(null)

  const [recipientRole, setRecipientRole] = useState<RecipientRole>("buyer")
  const [communicationType, setCommunicationType] = useState<CommunicationType>("update")
  const [draftContext, setDraftContext] = useState("")
  const [draftText, setDraftText] = useState<string | null>(null)

  const [reminders, setReminders] = useState<
    Array<{ documentName: string; deadline: string; daysRemaining: number; priority: string; reminderMessage: string; suggestedAction: string }>
  >([])

  const [communications, setCommunications] = useState<CommunicationRow[]>([])
  const [commsError, setCommsError] = useState<string | null>(null)

  // The recorded drafts — the reader that makes the write visible. If this read
  // fails, the panel says so rather than showing an empty (and therefore
  // reassuring) list.
  const loadCommunications = async () => {
    const res = await listTransactionCommunications(transactionId)
    if (!res.success) {
      setCommsError(res.error ?? "Could not load the recorded drafts.")
      setCommunications([])
      return
    }
    setCommsError(null)
    setCommunications(res.communications as CommunicationRow[])
  }

  useEffect(() => {
    void loadCommunications()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactionId])

  const runSmartTasks = () => {
    setBusy("tasks")
    setTasksVerdict(null)
    startTransition(async () => {
      const res: any = await generateSmartTasks({ transactionId, stage: stage ?? undefined })
      setBusy(null)
      if (!res?.success) {
        setTasksVerdict({ ok: false, headline: res?.error ?? "Task generation failed." })
        return
      }
      const created = res.createdCount ?? 0
      const proposed = res.proposedCount ?? 0
      setTasksVerdict({
        ok: created > 0,
        headline:
          created > 0
            ? `${created} of ${proposed} suggested task${proposed === 1 ? "" : "s"} written to this deal.`
            : `The model suggested ${proposed} task${proposed === 1 ? "" : "s"} and NONE were written.`,
        detail:
          created < proposed && (res.skipped?.length ?? 0) === 0
            ? "The rest already existed on this deal."
            : undefined,
        skipped: res.skipped,
      })
      router.refresh()
    })
  }

  const runDeadlines = () => {
    setBusy("deadlines")
    setDeadlinesVerdict(null)
    startTransition(async () => {
      const res: any = await predictAndManageDeadlines({ transactionId })
      setBusy(null)
      if (!res?.success) {
        setDeadlinesVerdict({ ok: false, headline: res?.error ?? "Deadline prediction failed." })
        return
      }
      const created = res.createdCount ?? 0
      const proposed = res.proposedCount ?? 0
      setDeadlinesVerdict({
        ok: true,
        headline: `Predicted close ${res.deadlineAnalysis?.predictedCloseDate ?? "unknown"} — ${created} of ${proposed} suggested deadline${proposed === 1 ? "" : "s"} created.`,
        detail:
          created < proposed && (res.skipped?.length ?? 0) === 0
            ? "The rest already exist on this deal."
            : undefined,
        skipped: res.skipped,
      })
      router.refresh()
    })
  }

  const runDraft = () => {
    setBusy("draft")
    setDraftVerdict(null)
    setDraftText(null)
    startTransition(async () => {
      const res: any = await draftTransactionCommunication({
        transactionId,
        recipientRole,
        communicationType,
        context: draftContext.trim() || undefined,
      })
      setBusy(null)
      if (!res?.success) {
        // The action FAILS when the draft could not be recorded, precisely so the
        // agent is never handed text the system did not keep.
        setDraftVerdict({ ok: false, headline: res?.error ?? "Draft failed." })
        return
      }
      setDraftText(res.communication ?? null)
      setDraftVerdict({
        ok: true,
        headline: `Draft recorded (${res.status}) for ${res.recipientName ?? recipientRole}.`,
        detail: res.recipientEmail ? `On file: ${res.recipientEmail}` : undefined,
      })
      void loadCommunications()
    })
  }

  const runPostClosing = () => {
    setBusy("postclose")
    setPostCloseVerdict(null)
    startTransition(async () => {
      const res: any = await generatePostClosingPlan({ transactionId })
      setBusy(null)
      if (!res?.success) {
        setPostCloseVerdict({ ok: false, headline: res?.error ?? "Post-closing plan failed." })
        return
      }
      const scheduled = res.scheduledCount ?? 0
      const proposed = res.proposedCount ?? 0
      setPostCloseVerdict({
        ok: scheduled > 0,
        headline:
          scheduled > 0
            ? `${scheduled} of ${proposed} immediate touchpoint${proposed === 1 ? "" : "s"} scheduled.`
            : `The plan proposed ${proposed} touchpoint${proposed === 1 ? "" : "s"} and NONE were scheduled.`,
        skipped: res.skipped,
      })
      router.refresh()
    })
  }

  const runReminders = () => {
    setBusy("reminders")
    setRemindersVerdict(null)
    startTransition(async () => {
      const res: any = await aiGenerateDocumentReminders({ transactionId })
      setBusy(null)
      if (!res?.success) {
        setReminders([])
        setRemindersVerdict({ ok: false, headline: res?.error ?? "Reminder generation failed." })
        return
      }
      setReminders(res.reminders ?? [])
      setRemindersVerdict({
        ok: true,
        // HONEST about what this one is: it writes nothing. It is a read of the
        // deal plus a model pass. Nothing is persisted, so nothing is claimed to be.
        headline: `${res.reminders?.length ?? 0} document reminder(s) — advisory only, nothing was saved.`,
      })
    })
  }

  const isClosing = ["CLOSING_PREP", "CLOSED"].includes(String(stage ?? "").toUpperCase())

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Brain className="h-4 w-4 text-violet-600" />
          AI Transaction Coordinator
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Generates the tasks, deadlines, client messages and post-closing plan for this deal — and
          reports exactly how much of it the database accepted.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ── SMART TASKS ─────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5">
                <CheckSquare className="h-3.5 w-3.5" />
                Stage tasks
              </p>
              <p className="text-xs text-muted-foreground">
                Writes to this deal&apos;s task list for the <b>{stage ?? "current"}</b> stage.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={runSmartTasks} disabled={pending}>
              {busy === "tasks" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Generate tasks
            </Button>
          </div>
          <VerdictNote verdict={tasksVerdict} />
        </section>

        {/* ── DEADLINES ───────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5">
                <CalendarClock className="h-3.5 w-3.5" />
                Predict &amp; fill deadlines
              </p>
              <p className="text-xs text-muted-foreground">
                Predicts the realistic close date and creates any missing deadline this deal should
                already have.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={runDeadlines} disabled={pending}>
              {busy === "deadlines" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Predict deadlines
            </Button>
          </div>
          <VerdictNote verdict={deadlinesVerdict} />
        </section>

        {/* ── DOCUMENT REMINDERS (advisory) ───────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5">
                <Bell className="h-3.5 w-3.5" />
                Document reminders
              </p>
              <p className="text-xs text-muted-foreground">
                Advisory read — what is missing, expiring, or waiting on a signature. Nothing is
                written.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={runReminders} disabled={pending}>
              {busy === "reminders" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Check documents
            </Button>
          </div>
          <VerdictNote verdict={remindersVerdict} />
          {reminders.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {reminders.map((r, i) => (
                <li key={i} className="text-xs border rounded p-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-[10px] capitalize">
                      {r.priority}
                    </Badge>
                    <span className="font-medium">{r.documentName}</span>
                    <span className="text-muted-foreground">
                      {r.deadline} · {r.daysRemaining}d
                    </span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{r.reminderMessage}</p>
                  <p className="mt-0.5">{r.suggestedAction}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/* ── COMMUNICATION DRAFTING ──────────────────────────────────────── */}
        <section className="border-t pt-4">
          <p className="text-sm font-medium flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5" />
            Draft a message
          </p>
          <p className="text-xs text-muted-foreground mb-2">
            The draft is RECORDED on this transaction before you see it — if it cannot be recorded,
            the action fails rather than handing you text nothing kept.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Recipient</Label>
              <Select value={recipientRole} onValueChange={(v) => setRecipientRole(v as RecipientRole)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECIPIENT_ROLES.map((r) => (
                    <SelectItem key={r} value={r} className="text-xs capitalize">
                      {r.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Message type</Label>
              <Select
                value={communicationType}
                onValueChange={(v) => setCommunicationType(v as CommunicationType)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMMUNICATION_TYPES.map((c) => (
                    <SelectItem key={c} value={c} className="text-xs capitalize">
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-2">
            <Label className="text-xs">Anything specific to say? (optional)</Label>
            <Textarea
              value={draftContext}
              onChange={(e) => setDraftContext(e.target.value)}
              rows={2}
              className="text-xs"
              placeholder="e.g. the appraisal came in $8k under and we want an extension"
            />
          </div>

          <Button size="sm" className="mt-2" onClick={runDraft} disabled={pending}>
            {busy === "draft" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
            Draft &amp; record
          </Button>

          <VerdictNote verdict={draftVerdict} />

          {draftText ? (
            <pre className="mt-2 text-xs whitespace-pre-wrap border rounded p-2 bg-muted/40 overflow-x-auto">
              {draftText}
            </pre>
          ) : null}

          {/* The reader — proves the write landed. */}
          <div className="mt-3">
            <p className="text-xs font-medium">Recorded drafts</p>
            {commsError ? (
              <Alert variant="destructive" className="mt-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                <AlertDescription className="text-xs">{commsError}</AlertDescription>
              </Alert>
            ) : communications.length === 0 ? (
              <p className="text-xs text-muted-foreground mt-1">None recorded yet.</p>
            ) : (
              <ul className="mt-1 divide-y border rounded">
                {communications.map((c) => (
                  <li key={c.id} className="px-2 py-1.5 text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {c.status}
                      </Badge>
                      <span className="capitalize">
                        {c.communication_type} &rarr; {String(c.recipient_role ?? "").replace(/_/g, " ")}
                      </span>
                      <span className="text-muted-foreground">
                        {c.created_at ? new Date(c.created_at).toLocaleString() : ""}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* ── POST-CLOSING PLAN ───────────────────────────────────────────── */}
        <section className="border-t pt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5">
                <HeartHandshake className="h-3.5 w-3.5" />
                Post-closing plan
              </p>
              <p className="text-xs text-muted-foreground">
                Schedules the immediate follow-up touchpoints for this client.
                {isClosing ? "" : " Most useful once the deal reaches closing prep."}
                {closeDate ? ` Close date on file: ${closeDate}.` : ""}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={runPostClosing} disabled={pending}>
              {busy === "postclose" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Build plan
            </Button>
          </div>
          <VerdictNote verdict={postCloseVerdict} />
        </section>
      </CardContent>
    </Card>
  )
}
