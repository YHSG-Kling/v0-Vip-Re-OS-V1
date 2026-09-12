"use client"

// TestimonialCard — the newly-closed / lifetime client shares their experience IN THE PORTAL: a few
// written words OR a short video. It lands in agent_reviews (is_published=false) for the agent to
// approve + use in marketing. Two tabs: Write / Record. Once submitted, shows a thank-you (idempotent
// in the session).
//
// The video upload went through @vercel/blob/client's `upload()` until the owner ruled that all file
// storage lives in Supabase buckets. Survivor: lib/storage/browser-upload.ts#uploadViaSignedUrl, which
// keeps the browser→storage direct PUT (so a testimonial clip is still not capped at Vercel's 4.5 MB
// function body limit) and drops the client-chosen path — this component used to name
// `testimonials/${contactId}/…` with a contactId that arrives as a PROP, so any signed-in caller could
// write under any contact. The path is now built server-side from the session's brokerage.

import { useState } from "react"
import { uploadViaSignedUrl } from "@/lib/storage/browser-upload"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Quote, Video, Loader2, CheckCircle2 } from "lucide-react"
import { submitClientTestimonial } from "@/app/actions/portal-lifetime"

export function TestimonialCard({ contactId, agentFirstName }: { contactId: string; agentFirstName?: string | null }) {
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submitText() {
    setErr(null)
    if (body.trim().length < 8) { setErr("Please share a few words about your experience."); return }
    setBusy(true)
    const res = await submitClientTestimonial({ contactId, kind: "text", body })
    setBusy(false)
    if (res.ok) setDone(true); else setErr(res.error ?? "Something went wrong — please try again.")
  }

  async function submitVideo(file: File) {
    setErr(null)
    setBusy(true)
    try {
      const stored = await uploadViaSignedUrl({ purpose: "portal_testimonial", file })
      if (!stored.ok) {
        // The server's wording carries the real ceiling and the real reason, so
        // it is shown rather than replaced with a generic failure.
        setErr(stored.error)
        return
      }
      const res = await submitClientTestimonial({ contactId, kind: "video", videoUrl: stored.url })
      if (res.ok) setDone(true); else setErr(res.error ?? "Couldn't save your video — please try again.")
    } catch {
      setErr("Upload failed — please try a shorter clip or check your connection.")
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Card className="shadow-lg border-0">
        <CardContent className="p-6 text-center space-y-2">
          <CheckCircle2 className="h-8 w-8 text-emerald-600 mx-auto" />
          <p className="font-semibold text-foreground">Thank you!</p>
          <p className="text-sm text-muted-foreground">
            {agentFirstName ? `${agentFirstName} will` : "Your agent will"} love this. It means the world.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="shadow-lg border-0">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Quote className="h-4 w-4 text-violet-600" />
          Share your experience
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Would you share a few words{agentFirstName ? ` about working with ${agentFirstName}` : ""}? A short note — or a quick video — helps more than you know. No pressure.
        </p>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="write">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="write">Write a few words</TabsTrigger>
            <TabsTrigger value="video" className="gap-1.5"><Video className="h-3.5 w-3.5" />Record a video</TabsTrigger>
          </TabsList>

          <TabsContent value="write" className="space-y-3 pt-3">
            <Textarea
              placeholder="What was your experience like? (a sentence or two is perfect)"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              maxLength={1500}
              disabled={busy}
            />
            <Button onClick={submitText} disabled={busy} className="w-full">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Share my testimonial"}
            </Button>
          </TabsContent>

          <TabsContent value="video" className="space-y-3 pt-3">
            <p className="text-xs text-muted-foreground">
              Record a quick selfie video on your phone, then upload it here. 20–30 seconds is perfect.
            </p>
            <input
              type="file"
              accept="video/*"
              disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void submitVideo(f) }}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-violet-600 file:px-3 file:py-2 file:text-white"
            />
            {busy && <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" />Uploading…</p>}
          </TabsContent>
        </Tabs>
        {err && <p className="text-xs text-destructive mt-2">{err}</p>}
      </CardContent>
    </Card>
  )
}
