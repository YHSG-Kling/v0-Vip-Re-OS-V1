"use client"

/**
 * app/dashboard/videos/create/describe-video-card.tsx — "DESCRIBE A VIDEO"
 * (wave 81C). OWNER: "make sure user can create any type of video to use with
 * real estate not just the ones we listed."
 *
 * The agent describes the video (who it is for, what it should do, who
 * carries it, how long they wish, what they have on hand) and the archetype
 * RULE (lib/video/custom-video-archetypes.ts) answers with the shape it
 * derived — purpose, band, composition, cuts — BEFORE anything is staged.
 * A description the rule cannot place is shown as a refusal with the reason
 * (what to say, what is missing), never a silent default. Commissioning rides
 * the same Director rail as every listed kind: pending_review, nothing
 * auto-publishes. Every verdict shown is the SERVER's.
 */

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Wand2, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react"
import { CUSTOM_VIDEO_ARCHETYPES } from "@/lib/video/custom-video-archetypes"
import {
  previewDescribedVideoAction, createDescribedVideoAction,
  type DescribeVideoInput, type DescribeVideoPreview, type DescribeVideoResult,
} from "@/app/actions/custom-video"

const HOST_LABELS: Record<DescribeVideoInput["host"], string> = {
  voiceover: "Voiceover (your cloned voice or the brokerage voice)",
  avatar: "Your avatar on camera (D-ID twin)",
  silent: "On-screen copy only, no narration",
}

function lines(text: string): string[] {
  return text.split(/\n+/).map((s) => s.trim()).filter(Boolean)
}

export function DescribeVideoCard() {
  const [audience, setAudience] = useState("")
  const [goal, setGoal] = useState("")
  const [host, setHost] = useState<DescribeVideoInput["host"]>("voiceover")
  const [lengthWish, setLengthWish] = useState("")
  const [archetypeHint, setArchetypeHint] = useState<string>("")
  const [photos, setPhotos] = useState("")
  const [screenshots, setScreenshots] = useState("")
  const [footage, setFootage] = useState("")
  const [stats, setStats] = useState("")
  const [script, setScript] = useState("")
  const [title, setTitle] = useState("")
  const [bullets, setBullets] = useState("")
  const [listingId, setListingId] = useState("")
  const [busy, setBusy] = useState<"preview" | "create" | null>(null)
  const [preview, setPreview] = useState<DescribeVideoPreview | null>(null)
  const [result, setResult] = useState<DescribeVideoResult | null>(null)

  function input(): DescribeVideoInput {
    const wish = Number(lengthWish)
    return {
      audience, goal, host,
      lengthWishSeconds: Number.isFinite(wish) && wish > 0 ? wish : null,
      archetypeHint: archetypeHint || null,
      photoUrls: lines(photos), screenshotUrls: lines(screenshots), clientFootageUrls: lines(footage),
      stats: lines(stats).map((l) => { const [label, ...rest] = l.split(":"); return { label: label.trim(), value: rest.join(":").trim() } }).filter((s) => s.label && s.value),
      script: script.trim() || null, title: title.trim() || null, bullets: lines(bullets),
      listingId: listingId.trim() || null,
    }
  }

  async function runPreview() {
    setBusy("preview"); setResult(null)
    try { setPreview(await previewDescribedVideoAction(input())) } finally { setBusy(null) }
  }
  async function runCreate() {
    setBusy("create")
    try { setResult(await createDescribedVideoAction(input())) } finally { setBusy(null) }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Wand2 className="h-5 w-5" /> Describe a video</CardTitle>
        <CardDescription>
          Any real-estate video — an intro, a buyer guide, a seminar invite, a vendor spotlight, a holiday note, a quarterly recap.
          Say who it is for and what it should do; the director derives the shape, the length band and the format by rule,
          and shows you before anything is made. Listing videos get an MLS cut and a posting cut.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="dv-audience">Who is it for?</Label>
            <Input id="dv-audience" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="first-time buyers in Naples · agents I want to recruit · my past clients" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-length">Length you wish (seconds — clamped to the shape's band)</Label>
            <Input id="dv-length" inputMode="numeric" value={lengthWish} onChange={(e) => setLengthWish(e.target.value)} placeholder="45" />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="dv-goal">What should it do?</Label>
          <Textarea id="dv-goal" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Invite them to our Saturday first-time-buyer workshop · Explain closing costs in three steps · Thank my clients for the year" />
        </div>
        <div className="space-y-1">
          <Label>Who carries it?</Label>
          <div className="flex flex-wrap gap-4 text-sm">
            {(Object.keys(HOST_LABELS) as Array<DescribeVideoInput["host"]>).map((h) => (
              <label key={h} className="flex items-center gap-2">
                <input type="radio" name="dv-host" value={h} checked={host === h} onChange={() => setHost(h)} />
                {HOST_LABELS[h]}
              </label>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="dv-archetype">Shape (optional — the rule picks one from the description when blank)</Label>
          <select id="dv-archetype" className="h-9 rounded-md border bg-background px-3 text-sm" value={archetypeHint} onChange={(e) => setArchetypeHint(e.target.value)}>
            <option value="">Let the rule decide</option>
            {CUSTOM_VIDEO_ARCHETYPES.map((a) => <option key={a} value={a}>{a.replace(/_/g, " ")}</option>)}
          </select>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="dv-script">Narration / on-screen copy (compliance-gated before render)</Label>
            <Textarea id="dv-script" rows={3} value={script} onChange={(e) => setScript(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-title">Title, then bullets (one per line)</Label>
            <Input id="dv-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
            <Textarea id="dv-bullets" rows={2} value={bullets} onChange={(e) => setBullets(e.target.value)} placeholder="Bullet one&#10;Bullet two&#10;Bullet three" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-photos">Photo URLs (one per line)</Label>
            <Textarea id="dv-photos" rows={2} value={photos} onChange={(e) => setPhotos(e.target.value)} placeholder="https://…" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-screens">Screenshot URLs (one per line)</Label>
            <Textarea id="dv-screens" rows={2} value={screenshots} onChange={(e) => setScreenshots(e.target.value)} placeholder="https://…" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-footage">Client's own clip URLs (one per line)</Label>
            <Textarea id="dv-footage" rows={2} value={footage} onChange={(e) => setFootage(e.target.value)} placeholder="https://…" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-stats">Stat cards (label: value, one per line)</Label>
            <Textarea id="dv-stats" rows={2} value={stats} onChange={(e) => setStats(e.target.value)} placeholder="Median price: $742,500&#10;Days on market: 19" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-listing">Listing id (optional — a listing video also gets the MLS cut)</Label>
            <Input id="dv-listing" value={listingId} onChange={(e) => setListingId(e.target.value)} placeholder="uuid" />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={runPreview} disabled={busy !== null || goal.trim().length < 3}>
            {busy === "preview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} What would the director make of this?
          </Button>
          <Button size="sm" onClick={runCreate} disabled={busy !== null || goal.trim().length < 3}>
            {busy === "create" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Commission it (goes to approval)
          </Button>
        </div>

        {preview && !preview.success ? (
          <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>The rule could not place this description</AlertTitle><AlertDescription>{preview.error}</AlertDescription></Alert>
        ) : null}
        {preview && preview.success ? (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle className="flex flex-wrap items-center gap-2">
              <Badge>{preview.archetype?.replace(/_/g, " ")}</Badge>
              <Badge variant="outline">{preview.purpose}</Badge>
              <Badge variant="outline">{preview.compositionId}</Badge>
              <Badge variant="outline">{preview.targetSeconds}s of {preview.band?.minSeconds}-{preview.band?.maxSeconds}s</Badge>
              {preview.cuts?.map((c) => <Badge key={c} variant="secondary">{c} cut</Badge>)}
            </AlertTitle>
            <AlertDescription>{preview.reason}</AlertDescription>
          </Alert>
        ) : null}
        {result && !result.success ? (
          <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Not commissioned</AlertTitle><AlertDescription>{result.error}{result.violations?.length ? ` — ${result.violations.join(", ")}` : ""}</AlertDescription></Alert>
        ) : null}
        {result && result.success ? (
          <Alert><CheckCircle2 className="h-4 w-4" /><AlertTitle>Staged for approval ({result.status})</AlertTitle><AlertDescription>{result.archetype?.replace(/_/g, " ")} on {result.compositionId}; project {result.videoProjectId}{result.mlsVideoProjectId ? `, MLS cut ${result.mlsVideoProjectId}` : ""}. Nothing publishes until it is approved.</AlertDescription></Alert>
        ) : null}
      </CardContent>
    </Card>
  )
}
