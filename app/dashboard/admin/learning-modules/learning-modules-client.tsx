"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  createLearningModuleAction,
  publishLearningModuleAction,
} from "@/app/actions/learning-modules"

type Channel =
  | "article" | "blog" | "video" | "podcast"
  | "newsletter" | "email" | "social" | "quiz" | "portal_lesson"

const CHANNEL_OPTIONS: { value: Channel; label: string; hint: string }[] = [
  { value: "article",       label: "Article",        hint: "knowledge_articles row, published" },
  { value: "blog",          label: "Blog post",      hint: "knowledge_articles tagged 'blog'" },
  { value: "video",         label: "Training video", hint: "training_videos placeholder until uploaded" },
  { value: "podcast",       label: "Podcast",        hint: "podcast_episodes draft with script" },
  { value: "newsletter",    label: "Newsletter",     hint: "newsletter_brokers_templates draft" },
  { value: "email",         label: "Email campaign", hint: "newsletter_brokers_templates email-flavored" },
  { value: "social",        label: "Social post",    hint: "social_posts draft (broker picks platform)" },
  { value: "quiz",          label: "Inline quiz",    hint: "Renders quiz_questions inline; no fan-out" },
  { value: "portal_lesson", label: "Portal lesson",  hint: "Surfaces in customer portal stream by milestone" },
]

const AUDIENCE_ROLE_OPTIONS = [
  { value: "agent",              label: "Agents" },
  { value: "tc",                 label: "Transaction Coordinators" },
  { value: "compliance_officer", label: "Compliance Officers" },
  { value: "team_lead",          label: "Team Leads" },
  { value: "customer",           label: "Customers" },
]

const PERSONA_OPTIONS = [
  "first_time_buyer", "investor", "downsizer", "luxury_buyer", "relocator",
  "expired", "fsbo", "divorce", "estate", "downsize_seller", "luxury_seller",
]

const GENERATION_OPTIONS = ["gen_z", "millennial", "gen_x", "boomer", "silent"]
const AGE_SEG_OPTIONS    = ["18-30", "30-50", "50-65", "65+"]

const STAGE_TAG_SUGGESTIONS = [
  "offer_submitted", "offer_accepted", "inspection_scheduled", "inspection_deadline",
  "appraisal_ordered", "financing_deadline", "clear_to_close_received", "closing_date",
  "listing_live", "first_showing", "offer_received", "under_contract", "closing_prep",
]

const GAP_TAG_SUGGESTIONS = [
  "slow_lead_response", "no_sphere_touchpoints", "low_ai_isa_adoption", "low_drip_enrollment",
  "open_deal_interventions", "open_listing_interventions", "long_dom", "low_close_rate",
  "tc_workload_spike", "tc_closing_backlog", "unresolved_compliance_events",
  "open_tenant_safety_findings", "team_pattern_adoption_pending", "staff_onboarding",
]

interface ModuleRow {
  id:               string
  title:            string
  summary:          string | null
  status:           string
  channels:         string[]
  publishedAt:      string | null
  displayPriority:  number
}

interface Props {
  initialModules: ModuleRow[]
}

export function LearningModulesClient({ initialModules }: Props) {
  const [modules, setModules] = useState<ModuleRow[]>(initialModules)
  const [showForm, setShowForm] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [feedback, setFeedback] = useState<string | null>(null)

  // form state
  const [title, setTitle] = useState("")
  const [summary, setSummary] = useState("")
  const [body, setBody] = useState("")
  const [coverImageUrl, setCoverImageUrl] = useState("")
  const [estimatedMinutes, setEstimatedMinutes] = useState<string>("")
  const [displayPriority, setDisplayPriority] = useState<string>("0")
  const [audienceRoles, setAudienceRoles] = useState<string[]>([])
  const [audiencePersonas, setAudiencePersonas] = useState<string[]>([])
  const [audienceGenerations, setAudienceGenerations] = useState<string[]>([])
  const [audienceAgeSegs, setAudienceAgeSegs] = useState<string[]>([])
  const [stageTagsCsv, setStageTagsCsv] = useState("")
  const [gapTagsCsv, setGapTagsCsv] = useState("")
  const [channels, setChannels] = useState<Channel[]>([])

  function toggle<T extends string>(list: T[], setter: (v: T[]) => void, v: T): void {
    setter(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  }

  function reset(): void {
    setTitle(""); setSummary(""); setBody(""); setCoverImageUrl("")
    setEstimatedMinutes(""); setDisplayPriority("0")
    setAudienceRoles([]); setAudiencePersonas([])
    setAudienceGenerations([]); setAudienceAgeSegs([])
    setStageTagsCsv(""); setGapTagsCsv(""); setChannels([])
  }

  function csvToArr(s: string): string[] {
    return s.split(",").map((x) => x.trim()).filter(Boolean)
  }

  function handleCreate(): void {
    if (!title.trim()) {
      setFeedback("Title is required.")
      return
    }
    startTransition(async () => {
      setFeedback(null)
      const result = await createLearningModuleAction({
        title:                title.trim(),
        summary:              summary.trim() || null,
        body:                 body.trim() || null,
        coverImageUrl:        coverImageUrl.trim() || null,
        estimatedMinutes:     estimatedMinutes ? Number(estimatedMinutes) : null,
        displayPriority:      Number(displayPriority) || 0,
        audienceRoles,
        audiencePersonas,
        audienceGenerations,
        audienceAgeSegs,
        stageTags:            csvToArr(stageTagsCsv),
        gapTags:              csvToArr(gapTagsCsv),
        channels,
      })
      if (!result.ok) {
        setFeedback(`Create failed: ${result.error}`)
        return
      }
      // Optimistic add — minimal info; user can refresh for the full row
      setModules((m: ModuleRow[]) => [
        { id: result.id, title: title.trim(), summary: summary.trim() || null, status: "draft", channels, publishedAt: null, displayPriority: Number(displayPriority) || 0 },
        ...m,
      ])
      reset()
      setShowForm(false)
      setFeedback("Module created as draft.")
    })
  }

  function handlePublish(moduleId: string, modChannels: Channel[]): void {
    if (modChannels.length === 0) {
      setFeedback("Pick at least one channel on the module before publishing.")
      return
    }
    startTransition(async () => {
      setFeedback(null)
      const result = await publishLearningModuleAction(moduleId, modChannels)
      if (!("ok" in result) || !result.ok) {
        setFeedback(`Publish failed: ${(result as { error?: string }).error ?? "unknown"}`)
        return
      }
      const ok = result.results.filter((r) => r.status === "published").length
      const fail = result.results.filter((r) => r.status === "failed")
      setModules((m: ModuleRow[]) =>
        m.map((row: ModuleRow) =>
          row.id === moduleId
            ? { ...row, status: ok > 0 ? "published" : row.status, publishedAt: ok > 0 ? new Date().toISOString() : row.publishedAt }
            : row,
        ),
      )
      const failMsg = fail.length > 0 ? ` — ${fail.length} failed: ${fail.map((f) => `${f.channel}(${f.error ?? "?"})`).join(", ")}` : ""
      setFeedback(`Published to ${ok} channel${ok === 1 ? "" : "s"}.${failMsg}`)
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button onClick={() => setShowForm((v: boolean) => !v)} variant={showForm ? "outline" : "default"}>
            {showForm ? "Cancel" : "New module"}
          </Button>
          <span className="text-sm text-muted-foreground">
            {modules.length} module{modules.length === 1 ? "" : "s"} in this brokerage
          </span>
        </div>
        {feedback && (
          <div className="text-sm rounded-md border bg-muted/40 px-3 py-2">{feedback}</div>
        )}
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>Author a new module</CardTitle>
            <CardDescription>
              Write the canonical lesson once. Choose channels — the publisher fans the row out to the
              channel-specific tables (article / video / podcast / newsletter / etc.) and the Router
              intersects audience tags against every actor&apos;s context.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lm-title">Title</Label>
                <Input id="lm-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What to do when your offer is accepted" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lm-cover">Cover image URL</Label>
                <Input id="lm-cover" value={coverImageUrl} onChange={(e) => setCoverImageUrl(e.target.value)} placeholder="https://..." />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lm-summary">Summary (one paragraph)</Label>
              <Textarea id="lm-summary" rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lm-body">Body (markdown)</Label>
              <Textarea id="lm-body" rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="# What to expect..." />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lm-mins">Est. minutes</Label>
                <Input id="lm-mins" type="number" min={0} value={estimatedMinutes} onChange={(e) => setEstimatedMinutes(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lm-prio">Display priority</Label>
                <Input id="lm-prio" type="number" value={displayPriority} onChange={(e) => setDisplayPriority(e.target.value)} />
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium">Audience roles</Label>
              <div className="flex flex-wrap gap-3 mt-2">
                {AUDIENCE_ROLE_OPTIONS.map((r) => (
                  <label key={r.value} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={audienceRoles.includes(r.value)}
                      onCheckedChange={() => toggle(audienceRoles, setAudienceRoles, r.value)}
                    />
                    {r.label}
                  </label>
                ))}
              </div>
              <div className="text-xs text-muted-foreground mt-1">Empty = everyone</div>
            </div>

            <div>
              <Label className="text-sm font-medium">Personas (customer-side)</Label>
              <div className="flex flex-wrap gap-3 mt-2">
                {PERSONA_OPTIONS.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={audiencePersonas.includes(p)}
                      onCheckedChange={() => toggle(audiencePersonas, setAudiencePersonas, p)}
                    />
                    {p}
                  </label>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">Generational cohort</Label>
                <div className="flex flex-wrap gap-3 mt-2">
                  {GENERATION_OPTIONS.map((g) => (
                    <label key={g} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={audienceGenerations.includes(g)}
                        onCheckedChange={() => toggle(audienceGenerations, setAudienceGenerations, g)}
                      />
                      {g}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <Label className="text-sm font-medium">Age segment</Label>
                <div className="flex flex-wrap gap-3 mt-2">
                  {AGE_SEG_OPTIONS.map((a) => (
                    <label key={a} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={audienceAgeSegs.includes(a)}
                        onCheckedChange={() => toggle(audienceAgeSegs, setAudienceAgeSegs, a)}
                      />
                      {a}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lm-stage">Stage tags (comma-separated)</Label>
                <Input id="lm-stage" value={stageTagsCsv} onChange={(e) => setStageTagsCsv(e.target.value)} placeholder={STAGE_TAG_SUGGESTIONS.slice(0, 3).join(", ")} />
                <span className="text-xs text-muted-foreground">Suggestions: {STAGE_TAG_SUGGESTIONS.join(", ")}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lm-gap">Gap tags (comma-separated)</Label>
                <Input id="lm-gap" value={gapTagsCsv} onChange={(e) => setGapTagsCsv(e.target.value)} placeholder={GAP_TAG_SUGGESTIONS.slice(0, 3).join(", ")} />
                <span className="text-xs text-muted-foreground">Suggestions: {GAP_TAG_SUGGESTIONS.join(", ")}</span>
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium">Channels to publish to</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                {CHANNEL_OPTIONS.map((c) => (
                  <label key={c.value} className="flex items-start gap-2 text-sm rounded-md border p-2">
                    <Checkbox
                      checked={channels.includes(c.value)}
                      onCheckedChange={() => toggle(channels, setChannels, c.value)}
                    />
                    <div>
                      <div className="font-medium">{c.label}</div>
                      <div className="text-xs text-muted-foreground">{c.hint}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button onClick={handleCreate} disabled={isPending}>
                {isPending ? "Saving..." : "Create draft"}
              </Button>
              <Button onClick={() => { reset(); setShowForm(false) }} variant="ghost">Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3">
        {modules.length === 0 && (
          <div className="text-sm text-muted-foreground border rounded-md p-6 text-center">
            No modules yet. Click <span className="font-medium">New module</span> to author the first one.
          </div>
        )}

        {modules.map((m) => (
          <Card key={m.id}>
            <CardContent className="py-4 flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{m.title}</span>
                  <Badge variant={m.status === "published" ? "default" : m.status === "archived" ? "secondary" : "outline"}>
                    {m.status}
                  </Badge>
                  {m.displayPriority > 0 && <Badge variant="outline">priority {m.displayPriority}</Badge>}
                </div>
                {m.summary && <p className="text-sm text-muted-foreground truncate mt-0.5">{m.summary}</p>}
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {m.channels.map((c) => (
                    <Badge key={c} variant="secondary">{c}</Badge>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => handlePublish(m.id, m.channels as Channel[])}
                  disabled={isPending || m.channels.length === 0}
                >
                  Publish to {m.channels.length} channel{m.channels.length === 1 ? "" : "s"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
