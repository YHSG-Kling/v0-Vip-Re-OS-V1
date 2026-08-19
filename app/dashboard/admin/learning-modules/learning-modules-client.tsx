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
  updateLearningModuleAction,
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
  // Academy (staff training) vs Client Education (customer content) — the same
  // learning_modules rail, switched by whether 'customer' is in audience_roles.
  // This framing makes the split explicit at authoring time.
  const [audienceType, setAudienceType] = useState<"academy" | "client" | "">("")
  const [audienceRoles, setAudienceRoles] = useState<string[]>([])

  const STAFF_ROLES = ["agent", "tc", "compliance_officer", "team_lead"]
  function chooseAudienceType(type: "academy" | "client") {
    setAudienceType(type)
    if (type === "academy") {
      // default to all staff; the admin can narrow below
      setAudienceRoles((prev) => prev.filter((r) => r !== "customer").length ? prev.filter((r) => r !== "customer") : ["agent"])
    } else {
      setAudienceRoles(["customer"])
    }
  }
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
    setAudienceType(""); setAudienceRoles([]); setAudiencePersonas([])
    setAudienceGenerations([]); setAudienceAgeSegs([])
    setStageTagsCsv(""); setGapTagsCsv(""); setChannels([])
  }

  function csvToArr(s: string): string[] {
    return s.split(",").map((x) => x.trim()).filter(Boolean)
  }

  // ── EDIT / ARCHIVE ────────────────────────────────────────────────────────
  // `updateLearningModuleAction` — the edit half of the authoring rail — had no
  // caller: a module could be CREATED and PUBLISHED from this screen but never
  // corrected and never retired. A typo in a title fanned out to every channel
  // with no way back, and `learning_modules.status` could only ever move
  // forward to 'published' even though the column's CHECK admits 'archived'.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState("")
  const [editSummary, setEditSummary] = useState("")
  const [editPriority, setEditPriority] = useState("0")

  function beginEdit(m: ModuleRow): void {
    setEditingId(m.id)
    setEditTitle(m.title)
    setEditSummary(m.summary ?? "")
    setEditPriority(String(m.displayPriority ?? 0))
    setFeedback(null)
  }

  function handleSaveEdit(id: string): void {
    if (!editTitle.trim()) {
      setFeedback("Title is required.")
      return
    }
    startTransition(async () => {
      setFeedback(null)
      const result = await updateLearningModuleAction(id, {
        title:           editTitle.trim(),
        summary:         editSummary.trim() || null,
        displayPriority: Number(editPriority) || 0,
      })
      // The action RETURNS { ok:false, error } for a non-admin caller and for a
      // refused write, and its update is scoped `.eq("brokerage_id", …)` so a
      // module outside the caller's tenant simply matches nothing. Painting the
      // new title into the list on a refusal would show an edit that did not
      // land.
      if (!result.ok) {
        setFeedback(result.error)
        return
      }
      setModules((prev) =>
        prev.map((row) =>
          row.id === id
            ? { ...row, title: editTitle.trim(), summary: editSummary.trim() || null, displayPriority: Number(editPriority) || 0 }
            : row,
        ),
      )
      setEditingId(null)
      setFeedback("Module updated.")
    })
  }

  function handleSetStatus(id: string, status: "draft" | "archived"): void {
    startTransition(async () => {
      setFeedback(null)
      // 'draft' | 'published' | 'archived' are three of the five values
      // learning_modules_status_check admits — verified against the live
      // constraint, not assumed.
      const result = await updateLearningModuleAction(id, { status })
      if (!result.ok) {
        setFeedback(result.error)
        return
      }
      setModules((prev) => prev.map((row) => (row.id === id ? { ...row, status } : row)))
      setFeedback(status === "archived" ? "Module archived." : "Module restored to draft.")
    })
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
              <Label className="text-sm font-medium">Who is this for?</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => chooseAudienceType("academy")}
                  className={`rounded-md border p-3 text-left text-sm ${audienceType === "academy" ? "border-blue-500 bg-blue-50" : "border-border"}`}
                >
                  <div className="font-medium">Academy — my agents &amp; staff</div>
                  <div className="text-xs text-muted-foreground">Training that shows in the team’s Academy (/academy).</div>
                </button>
                <button
                  type="button"
                  onClick={() => chooseAudienceType("client")}
                  className={`rounded-md border p-3 text-left text-sm ${audienceType === "client" ? "border-blue-500 bg-blue-50" : "border-border"}`}
                >
                  <div className="font-medium">Client Education — my customers</div>
                  <div className="text-xs text-muted-foreground">Content that shows in your buyers’ &amp; sellers’ portal.</div>
                </button>
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium">
                {audienceType === "client" ? "Customer audience" : "Audience roles"}
              </Label>
              <div className="flex flex-wrap gap-3 mt-2">
                {(audienceType === "client"
                  ? AUDIENCE_ROLE_OPTIONS.filter((r) => r.value === "customer")
                  : audienceType === "academy"
                  ? AUDIENCE_ROLE_OPTIONS.filter((r) => r.value !== "customer")
                  : AUDIENCE_ROLE_OPTIONS
                ).map((r) => (
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
              {editingId === m.id ? (
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="space-y-1">
                    <Label htmlFor={`edit-title-${m.id}`}>Title</Label>
                    <Input
                      id={`edit-title-${m.id}`}
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`edit-summary-${m.id}`}>Summary</Label>
                    <Textarea
                      id={`edit-summary-${m.id}`}
                      rows={2}
                      value={editSummary}
                      onChange={(e) => setEditSummary(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1 max-w-40">
                    <Label htmlFor={`edit-priority-${m.id}`}>Display priority</Label>
                    <Input
                      id={`edit-priority-${m.id}`}
                      type="number"
                      value={editPriority}
                      onChange={(e) => setEditPriority(e.target.value)}
                    />
                  </div>
                </div>
              ) : (
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
              )}
              <div className="flex items-center gap-2 shrink-0">
                {editingId === m.id ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setEditingId(null)} disabled={isPending}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={() => handleSaveEdit(m.id)} disabled={isPending}>
                      Save changes
                    </Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => beginEdit(m)} disabled={isPending}>
                      Edit
                    </Button>
                    {m.status === "archived" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSetStatus(m.id, "draft")}
                        disabled={isPending}
                      >
                        Restore to draft
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSetStatus(m.id, "archived")}
                        disabled={isPending}
                      >
                        Archive
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => handlePublish(m.id, m.channels as Channel[])}
                      disabled={isPending || m.channels.length === 0 || m.status === "archived"}
                    >
                      Publish to {m.channels.length} channel{m.channels.length === 1 ? "" : "s"}
                    </Button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
