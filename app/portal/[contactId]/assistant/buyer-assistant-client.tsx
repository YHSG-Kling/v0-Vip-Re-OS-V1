"use client"

/**
 * → app/actions/buyer-execution.ts:handleBuyerVoiceAssistant
 *
 * The action is a `"use server"` export, i.e. its own public HTTP endpoint, and it
 * establishes the caller itself with `requireContactAccess`. Nothing in this file is
 * load-bearing for authority: the `userId` parameter on the action's signature is
 * documented as IGNORED (the house pattern in that module), so it is not sent at all
 * rather than sent and quietly discarded.
 *
 * Every answer is rendered exactly as returned, including the refusal text. The
 * action answers a denied caller with the same neutral sentence it uses for a
 * malformed id ("I had trouble identifying your account") — deliberately, so a
 * probing caller cannot tell "that contact is not yours" from "that contact does not
 * exist". This component must not helpfully improve on that.
 */

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, Send } from "lucide-react"
import { handleBuyerVoiceAssistant } from "@/app/actions/buyer-execution"

/** The intents the action actually routes. Anything else is not answerable. */
const INTENTS = [
  { key: "explain_progress", label: "Where am I?" },
  { key: "whats_next", label: "What's next?" },
  { key: "search_properties", label: "Find properties" },
  { key: "schedule_tour", label: "Book a tour" },
  { key: "general_question", label: "Something else" },
] as const

type Intent = (typeof INTENTS)[number]["key"]

interface Turn {
  question: string
  answer: string
  ok: boolean
  actions?: string[]
}

export function BuyerAssistantClient({
  contactId,
  firstName,
}: {
  contactId: string
  firstName: string
}) {
  const [intent, setIntent] = useState<Intent>("explain_progress")
  const [transcript, setTranscript] = useState("")
  const [turns, setTurns] = useState<Turn[]>([])
  const [pending, startTransition] = useTransition()

  const ask = () => {
    const said = transcript.trim()
    // `explain_progress` and `whats_next` answer from the file and need no words;
    // the free-text intents do. Asking for a sentence that will be ignored is worse
    // than not asking for one.
    const needsWords = intent === "search_properties" || intent === "general_question"
    if (needsWords && !said) return

    startTransition(async () => {
      const res = await handleBuyerVoiceAssistant({
        contactId,
        intent,
        transcript: said || INTENTS.find((i) => i.key === intent)!.label,
      })
      setTurns((prev) => [
        ...prev,
        {
          question: said || INTENTS.find((i) => i.key === intent)!.label,
          answer:
            res?.spokenResponse ??
            "I could not answer that just now. Your agent can pick it up from here.",
          ok: Boolean(res?.success),
          actions: (res as { actionsRequired?: string[] })?.actionsRequired,
        },
      ])
      setTranscript("")
    })
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Hi {firstName} — ask me anything</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Answers come from your own file: your deal, your dates, your next step.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What would you like to know?</CardTitle>
          <CardDescription>Pick a topic, add anything specific, and send.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {INTENTS.map((i) => (
              <button
                key={i.key}
                type="button"
                onClick={() => setIntent(i.key)}
                className={
                  "rounded-full border px-3 py-1 text-sm " +
                  (intent === i.key ? "bg-foreground text-background" : "text-muted-foreground")
                }
              >
                {i.label}
              </button>
            ))}
          </div>

          <Textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            rows={3}
            placeholder={
              intent === "search_properties"
                ? "Three bedrooms, under 600, near the elementary school"
                : intent === "general_question"
                  ? "Type your question"
                  : "Optional — anything specific?"
            }
          />

          <Button onClick={ask} disabled={pending}>
            {pending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            Ask
          </Button>
        </CardContent>
      </Card>

      {turns.length > 0 && (
        <div className="space-y-3">
          {turns.map((t, i) => (
            <div key={i} className="rounded-md border p-4">
              <p className="text-sm font-medium">{t.question}</p>
              <p className={"mt-2 text-sm " + (t.ok ? "" : "text-destructive")}>{t.answer}</p>
              {t.actions && t.actions.length > 0 && (
                <ul className="mt-2 ml-5 list-disc text-sm text-muted-foreground">
                  {t.actions.map((a, j) => (
                    <li key={j}>{a}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
