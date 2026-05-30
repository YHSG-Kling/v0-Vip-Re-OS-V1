"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CheckCircle2, Loader2 } from "lucide-react"
import { submitDataSubjectRequestAction, type DSARType } from "@/app/actions/privacy/data-subject-requests"

const REQUEST_TYPES: Array<{ id: DSARType; label: string; desc: string }> = [
  { id: "export",         label: "Get a copy of my data",        desc: "Receive a JSON export of all personal information we hold" },
  { id: "delete",         label: "Delete my data",               desc: "Anonymize PII; transaction records retained per state law" },
  { id: "correction",     label: "Correct my data",              desc: "Fix inaccurate personal information" },
  { id: "opt_out_sale",   label: "Opt out of sale of my data",   desc: "CCPA — we do not sell, but you can confirm" },
  { id: "opt_out_sharing",label: "Opt out of sharing for ads",   desc: "CPRA — limit how your data is used for cross-context advertising" },
  { id: "access",         label: "Know what categories you have",desc: "Receive a summary of data categories collected and sources" },
]

export function DSARForm() {
  const [requestType, setRequestType] = useState<DSARType>("export")
  const [email, setEmail]   = useState("")
  const [name, setName]     = useState("")
  const [phone, setPhone]   = useState("")
  const [notes, setNotes]   = useState("")
  const [feedback, setFeedback] = useState<{ kind: "error"|"success"; message: string; dueDate?: string } | null>(null)
  const [isPending, startTransition] = useTransition()

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFeedback(null)
    startTransition(async () => {
      const r = await submitDataSubjectRequestAction({
        requestType, subjectEmail: email,
        subjectName: name || undefined, subjectPhone: phone || undefined,
        notes: notes || undefined,
      })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Submit failed" }); return }
      setFeedback({
        kind: "success",
        message: `Request received. We'll respond by ${r.dueDate ? new Date(r.dueDate).toLocaleDateString() : "within 45 days"}.`,
        dueDate: r.dueDate,
      })
    })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">1. What do you want us to do?</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {REQUEST_TYPES.map(t => (
            <Card key={t.id} onClick={() => setRequestType(t.id)}
              className={`cursor-pointer transition ${requestType === t.id ? "ring-2 ring-primary border-primary" : "hover:border-muted-foreground/40"}`}>
              <CardContent className="pt-3 pb-3">
                <div className="flex justify-between items-start">
                  <span className="font-medium text-sm">{t.label}</span>
                  {requestType === t.id && <CheckCircle2 className="h-4 w-4 text-primary shrink-0 ml-2" />}
                </div>
                <p className="text-xs text-muted-foreground mt-1">{t.desc}</p>
              </CardContent>
            </Card>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">2. Who are you?</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="email">Email *</Label>
            <Input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
            <p className="text-xs text-muted-foreground mt-1">
              Required for identity verification. We&apos;ll send confirmations here.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="name">Full name</Label>
              <Input id="name" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" value={phone} onChange={e => setPhone(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="notes">Anything else we should know?</Label>
            <textarea id="notes" rows={3} value={notes} onChange={e => setNotes(e.target.value)}
              className="w-full text-sm border rounded p-2"
              placeholder="e.g. I'm requesting on behalf of my deceased mother; I worked with Agent Jane Doe at Acme Realty." />
          </div>
        </CardContent>
      </Card>

      {feedback && (
        <div className={`rounded-md border p-4 text-sm ${
          feedback.kind === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"
        }`}>{feedback.message}</div>
      )}

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={isPending}>
          {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Submitting…</> : "Submit request"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground text-center">
        We&apos;ll verify your identity before fulfilling the request. Response within 45 days (CCPA) or 30 days (GDPR).
      </p>
    </form>
  )
}
