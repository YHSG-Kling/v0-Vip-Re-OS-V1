"use client"

/**
 * app/dashboard/videos/create/describe-video-card.tsx — "DESCRIBE A VIDEO"
 * (wave 81C; AI-guided + topic pool, wave 82C).
 *
 * OWNER (2026-09-24): "make sure user can create any type of video to use with
 * real estate not just the ones we listed."
 * OWNER (2026-09-25): "on the describe video card, when you pick this kind of
 * video, the ai then tells the user what they will need and assist on their
 * wording in the text boxes during the process (so an ai helping and guiding
 * them so they feel supported especially if they are not techy). on the card
 * they can also pick from the topic pool."
 *
 * The agent describes the video (who it is for, what it should do, who
 * carries it, how long they wish, what they have on hand) and the archetype
 * RULE (lib/video/custom-video-archetypes.ts) answers with the shape it
 * derived — purpose, band, composition, cuts — BEFORE anything is staged.
 * A description the rule cannot place is shown as a refusal with the reason
 * (what to say, what is missing), never a silent default. Commissioning rides
 * the same Director rail as every listed kind: pending_review, nothing
 * auto-publishes. Every verdict shown is the SERVER's.
 *
 * Wave 82C adds three supports, all server-side and all optional:
 *   · PICK FROM YOUR TOPIC POOL — listVideoTopicPoolAction (the ONE pool,
 *     in-season, territory-boosted); a pick pre-fills the kind, the goal and
 *     the viewer, and is claimed for the office once the video is staged.
 *   · WHAT YOU'LL NEED — getVideoGuideAction: a checklist DERIVED from the
 *     registries, phrased warmly by the routed guide (still shown if the guide
 *     is offline).
 *   · WORDING HELP — after a pause in typing (SUGGEST_DEBOUNCE_MS) each text box
 *     asks suggestVideoWordingAction for up to three rewrites; "Use this" puts
 *     one in the box, where it stays editable. Suggestions are fair-housing
 *     scanned before they are shown; a heads-up appears if the typed words would
 *     be stopped at approval. Nothing here blocks typing.
 */

import { useEffect, useRef, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Wand2, Loader2, AlertTriangle, CheckCircle2, Sparkles, Lightbulb, ListChecks } from "lucide-react"
import { CUSTOM_VIDEO_ARCHETYPES, archetypeHosts, type CustomVideoArchetype } from "@/lib/video/custom-video-archetypes"
import { ARCHETYPE_HEADLINES, GUIDE_FIELD_SPECS, SUGGEST_DEBOUNCE_MS, type GuideField } from "@/lib/video/video-guide"
import {
  previewDescribedVideoAction, createDescribedVideoAction, listVideoTopicPoolAction, getVideoGuideAction, suggestVideoWordingAction,
  type DescribeVideoInput, type DescribeVideoPreview, type DescribeVideoResult,
  type VideoTopicOption, type VideoGuideResult, type WordingSuggestionResult,
} from "@/app/actions/custom-video"

const HOST_LABELS: Record<DescribeVideoInput["host"], string> = {
  voiceover: "Your voice over pictures (your cloned voice)",
  avatar: "You on camera (your digital twin)",
  silent: "Words on screen only, no voice",
}

function lines(text: string): string[] {
  return text.split(/\n+/).map((s) => s.trim()).filter(Boolean)
}

interface GuideContext { archetype: string; goal: string; audience: string; topicTitle: string | null }

/** Debounced, non-blocking wording help for one box. Stale replies are ignored. */
function useWordingHelp(field: GuideField, value: string, ctx: GuideContext) {
  const [help, setHelp] = useState<WordingSuggestionResult | null>(null)
  const [thinking, setThinking] = useState(false)
  const seq = useRef(0)
  const lastAsked = useRef("")
  useEffect(() => {
    const text = value.trim()
    if (text.length < GUIDE_FIELD_SPECS[field].minCharsToSuggest || text === lastAsked.current) return
    const mine = ++seq.current
    const timer = setTimeout(async () => {
      lastAsked.current = text
      setThinking(true)
      try {
        const r = await suggestVideoWordingAction({ field, text, archetype: ctx.archetype || null, goal: ctx.goal || null, audience: ctx.audience || null, topicTitle: ctx.topicTitle })
        if (mine === seq.current) setHelp(r)
      } finally {
        if (mine === seq.current) setThinking(false)
      }
    }, SUGGEST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [field, value, ctx.archetype, ctx.goal, ctx.audience, ctx.topicTitle])
  return { help, thinking, accept: (s: string) => { lastAsked.current = s.trim(); seq.current += 1; setHelp(null); setThinking(false) } }
}

function WordingHelp({ field, value, ctx, onUse }: { field: GuideField; value: string; ctx: GuideContext; onUse: (s: string) => void }) {
  const { help, thinking, accept } = useWordingHelp(field, value, ctx)
  return (
    <div className="space-y-1 text-xs">
      <p className="text-muted-foreground">{GUIDE_FIELD_SPECS[field].coach}</p>
      {thinking ? <p className="flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Looking at your wording…</p> : null}
      {help?.warnings?.length ? (
        <p className="flex items-start gap-1 text-amber-700 dark:text-amber-400"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> Heads-up: some words here may be stopped at approval under fair-housing rules. Try describing the home or the situation instead.</p>
      ) : null}
      {help && !help.success && help.error ? <p className="text-muted-foreground">{help.error}</p> : null}
      {help?.suggestions?.length ? (
        <div className="space-y-1 rounded-md border bg-muted/40 p-2">
          <p className="flex items-center gap-1 font-medium"><Sparkles className="h-3 w-3" /> Suggested wording — use one, or keep yours</p>
          {help.why ? <p className="text-muted-foreground">{help.why}</p> : null}
          {help.suggestions.map((s) => (
            <div key={s} className="flex items-start justify-between gap-2">
              <span className="whitespace-pre-wrap">{s}</span>
              <Button type="button" size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" onClick={() => { accept(s); onUse(s) }}>Use this</Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
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
  const [topic, setTopic] = useState<VideoTopicOption | null>(null)
  const [pool, setPool] = useState<{ loading: boolean; season?: string; topics?: VideoTopicOption[]; error?: string } | null>(null)
  const [guide, setGuide] = useState<{ loading: boolean; result?: VideoGuideResult } | null>(null)
  const [busy, setBusy] = useState<"preview" | "create" | null>(null)
  const [preview, setPreview] = useState<DescribeVideoPreview | null>(null)
  const [result, setResult] = useState<DescribeVideoResult | null>(null)

  const ctx: GuideContext = { archetype: archetypeHint, goal, audience, topicTitle: topic?.title ?? null }

  // The kind decides who can carry it (derived from the composition registry) —
  // move the "who carries it" choice for the person instead of letting them hit a refusal.
  useEffect(() => {
    if (!archetypeHint) return
    const hosts = archetypeHosts(archetypeHint as CustomVideoArchetype)
    if (hosts.length > 0 && !hosts.includes(host)) setHost(hosts[0])
  }, [archetypeHint, host])

  // WHAT YOU'LL NEED — whenever the kind (or the picked topic) changes.
  useEffect(() => {
    if (!archetypeHint) { setGuide(null); return }
    let live = true
    setGuide({ loading: true })
    getVideoGuideAction({ archetype: archetypeHint, topicId: topic?.id ?? null })
      .then((r) => { if (live) setGuide({ loading: false, result: r }) })
      .catch(() => { if (live) setGuide({ loading: false }) })
    return () => { live = false }
  }, [archetypeHint, topic?.id])

  async function openPool() {
    setPool({ loading: true })
    const r = await listVideoTopicPoolAction()
    setPool(r.success ? { loading: false, season: r.season, topics: r.topics ?? [] } : { loading: false, error: r.error })
  }

  function pickTopic(t: VideoTopicOption) {
    setTopic(t)
    setArchetypeHint(t.suggestedArchetype)
    setGoal(t.suggestedGoal)
    if (!audience.trim()) setAudience(t.suggestedAudience)
    if (!title.trim()) setTitle(t.title.slice(0, 60))
  }

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
      topicId: topic?.id ?? null,
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

  const checklist = guide?.result?.success ? guide.result.checklist : undefined

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Wand2 className="h-5 w-5" /> Describe a video</CardTitle>
        <CardDescription>
          Any real-estate video — an intro, a buyer guide, a seminar invite, a vendor spotlight, a holiday note, a quarterly recap.
          Pick a kind (or a topic from your pool) and we will tell you what you will need and help with the wording as you go.
          You see the plan before anything is made, and nothing is posted until it is approved.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── the topic pool ── */}
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label className="flex items-center gap-1"><Lightbulb className="h-4 w-4" /> Need an idea? Pick from your topic pool</Label>
            <Button type="button" size="sm" variant="outline" onClick={openPool} disabled={pool?.loading}>
              {pool?.loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} {pool?.topics ? "Refresh topics" : "Show topics"}
            </Button>
          </div>
          {pool?.error ? <p className="text-sm text-muted-foreground">{pool.error}</p> : null}
          {pool?.season ? <p className="text-xs text-muted-foreground">In season now — {pool.season}</p> : null}
          {pool?.topics && pool.topics.length === 0 ? <p className="text-sm text-muted-foreground">Your pool is empty right now — new topics arrive daily. You can still describe any video below.</p> : null}
          {pool?.topics?.length ? (
            <div className="grid gap-2 md:grid-cols-2">
              {pool.topics.map((t) => (
                <button type="button" key={t.id} onClick={() => pickTopic(t)}
                  className={`rounded-md border p-2 text-left text-sm hover:bg-muted ${topic?.id === t.id ? "border-primary bg-muted" : ""}`}>
                  <span className="font-medium">{t.title}</span>
                  {t.angle ? <span className="block text-xs text-muted-foreground">{t.angle}</span> : null}
                  <span className="mt-1 flex flex-wrap gap-1">
                    {t.isLocal || t.geoMatch ? <Badge variant="secondary">local</Badge> : null}
                    <Badge variant="outline">{ARCHETYPE_HEADLINES[t.suggestedArchetype].split(" — ")[0]}</Badge>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {topic ? <p className="text-xs">Using topic: <span className="font-medium">{topic.title}</span> <button type="button" className="underline" onClick={() => setTopic(null)}>clear</button></p> : null}
        </div>

        {/* ── the kind of video ── */}
        <div className="space-y-1">
          <Label htmlFor="dv-archetype">What kind of video? (optional — we can work it out from your description)</Label>
          <select id="dv-archetype" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={archetypeHint} onChange={(e) => setArchetypeHint(e.target.value)}>
            <option value="">Let us work it out</option>
            {CUSTOM_VIDEO_ARCHETYPES.map((a) => <option key={a} value={a}>{ARCHETYPE_HEADLINES[a]}</option>)}
          </select>
        </div>

        {/* ── what you'll need ── */}
        {guide?.loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Getting your checklist ready…</p> : null}
        {checklist ? (
          <Alert>
            <ListChecks className="h-4 w-4" />
            <AlertTitle>What you will need</AlertTitle>
            <AlertDescription className="space-y-2">
              {guide?.result?.reassurance ? <p>{guide.result.reassurance}</p> : <p>{checklist.headline}</p>}
              <ul className="list-disc pl-5 text-sm">
                <li>{checklist.length}.</li>
                <li>Who carries it: {checklist.onCamera.join(" · ")}.</li>
                {checklist.bring.length ? checklist.bring.map((b) => <li key={b}>Have ready: {b}.</li>) : <li>Nothing to gather — just your words.</li>}
                <li>A friendly way to finish: {checklist.nextStep}</li>
              </ul>
              {guide?.result?.tips?.length ? (
                <div className="text-sm"><span className="font-medium">Tips:</span><ul className="list-disc pl-5">{guide.result.tips.map((t) => <li key={t}>{t}</li>)}</ul></div>
              ) : null}
              {guide?.result?.aiAvailable === false ? <p className="text-xs text-muted-foreground">(The writing helper is offline — this checklist is still exact.)</p> : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="dv-audience">{GUIDE_FIELD_SPECS.audience.label}</Label>
            <Input id="dv-audience" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="people thinking about selling this spring · agents I want to recruit · my past clients" />
            <WordingHelp field="audience" value={audience} ctx={ctx} onUse={setAudience} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-length">How long? (seconds — we keep it inside what works for this kind)</Label>
            <Input id="dv-length" inputMode="numeric" value={lengthWish} onChange={(e) => setLengthWish(e.target.value)} placeholder={checklist ? String(checklist.targetSeconds) : "45"} />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="dv-goal">{GUIDE_FIELD_SPECS.goal.label}</Label>
          <Textarea id="dv-goal" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Invite them to our Saturday first-time-buyer workshop · Explain closing costs in three steps · Thank my clients for the year" />
          <WordingHelp field="goal" value={goal} ctx={ctx} onUse={setGoal} />
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
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="dv-script">{GUIDE_FIELD_SPECS.script.label} (checked for compliance before it is made)</Label>
            <Textarea id="dv-script" rows={4} value={script} onChange={(e) => setScript(e.target.value)} />
            <WordingHelp field="script" value={script} ctx={ctx} onUse={setScript} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-title">{GUIDE_FIELD_SPECS.title.label}, then {GUIDE_FIELD_SPECS.bullets.label.toLowerCase()} (one per line)</Label>
            <Input id="dv-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
            <WordingHelp field="title" value={title} ctx={ctx} onUse={setTitle} />
            <Textarea id="dv-bullets" rows={2} value={bullets} onChange={(e) => setBullets(e.target.value)} placeholder="Point one&#10;Point two&#10;Point three" />
            <WordingHelp field="bullets" value={bullets} ctx={ctx} onUse={setBullets} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-photos">Photo links (one per line)</Label>
            <Textarea id="dv-photos" rows={2} value={photos} onChange={(e) => setPhotos(e.target.value)} placeholder="https://…" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-screens">Screenshot links (one per line)</Label>
            <Textarea id="dv-screens" rows={2} value={screenshots} onChange={(e) => setScreenshots(e.target.value)} placeholder="https://…" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-footage">Your client's own clip links (one per line)</Label>
            <Textarea id="dv-footage" rows={2} value={footage} onChange={(e) => setFootage(e.target.value)} placeholder="https://…" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-stats">Numbers to show (label: value, one per line)</Label>
            <Textarea id="dv-stats" rows={2} value={stats} onChange={(e) => setStats(e.target.value)} placeholder="Median price: $742,500&#10;Days on market: 19" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dv-listing">Listing id (optional — a listing video also gets an MLS version)</Label>
            <Input id="dv-listing" value={listingId} onChange={(e) => setListingId(e.target.value)} placeholder="uuid" />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={runPreview} disabled={busy !== null || goal.trim().length < 3}>
            {busy === "preview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Show me the plan first
          </Button>
          <Button size="sm" onClick={runCreate} disabled={busy !== null || goal.trim().length < 3}>
            {busy === "create" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Make it (goes to approval)
          </Button>
        </div>

        {preview && !preview.success ? (
          <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>We could not place this description yet</AlertTitle><AlertDescription>{preview.error}</AlertDescription></Alert>
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
          <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Not made yet</AlertTitle><AlertDescription>{result.error}{result.violations?.length ? ` — ${result.violations.join(", ")}` : ""}</AlertDescription></Alert>
        ) : null}
        {result && result.success ? (
          <Alert><CheckCircle2 className="h-4 w-4" /><AlertTitle>Sent for approval ({result.status})</AlertTitle><AlertDescription>{result.archetype?.replace(/_/g, " ")} on {result.compositionId}; project {result.videoProjectId}{result.mlsVideoProjectId ? `, MLS version ${result.mlsVideoProjectId}` : ""}. Nothing is posted until it is approved.</AlertDescription></Alert>
        ) : null}
      </CardContent>
    </Card>
  )
}
