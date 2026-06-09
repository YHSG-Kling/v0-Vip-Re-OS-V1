"use client"

import { useState, useTransition } from "react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { approveAgentAction, rejectAgentAction } from "@/app/actions/command-center"
import type { CommandCenterData, CommandCenterAction, CommandCenterSession } from "@/lib/kernel/command-center"

const SESSION_BADGE: Record<string, string> = {
  running:    "bg-green-100 text-green-800",
  idle:       "bg-amber-100 text-amber-800",
  terminated: "bg-slate-100 text-slate-700",
  error:      "bg-red-100 text-red-800",
}
const QUEUE_BADGE: Record<string, string> = {
  marketing:   "bg-purple-100 text-purple-800",
  asset:       "bg-orange-100 text-orange-800",
  social:      "bg-sky-100 text-sky-800",
  newsletter:  "bg-emerald-100 text-emerald-800",
  direct_mail: "bg-amber-100 text-amber-900",
  ads:           "bg-rose-100 text-rose-800",
  ad_creative:   "bg-pink-100 text-pink-800",
  client_message:"bg-indigo-100 text-indigo-800",
  predictive_listing:"bg-teal-100 text-teal-800",
  transaction_task:  "bg-red-100 text-red-800",
  transaction_smart_task: "bg-red-50 text-red-700",
  agent_followup:    "bg-cyan-100 text-cyan-800",
  blog:              "bg-lime-100 text-lime-800",
  podcast:           "bg-fuchsia-100 text-fuchsia-800",
}
const QUEUE_LABEL: Record<string, string> = {
  marketing:     "Marketing Agent",
  asset:         "Asset Manager",
  social:        "Social Post",
  newsletter:    "Newsletter",
  direct_mail:   "Direct Mail",
  ads:           "Ads Manager",
  ad_creative:   "Ad Creative",
  client_message:"Client Update",
  predictive_listing:"Predicted Seller",
  transaction_task:  "At-Risk Deal",
  transaction_smart_task: "Deal Task",
  agent_followup:    "Follow-up",
  blog:              "Blog Post",
  podcast:           "Podcast",
}
const KIND_LABEL: Record<string, string> = {
  deal_coordinator:      "Deal Coordinator",
  shopping_agent:        "Shopping Agent",
  listing_concierge:     "Listing Concierge",
  sphere_of_influence:   "Sphere of Influence",
  campaign_orchestrator: "Campaign Orchestrator",
  marketing_agent:       "Marketing Agent",
  asset_manager:         "Asset Manager",
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—"
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function CommandCenterClient({ data, scope }: { data: CommandCenterData; scope: "platform" | "brokerage" }) {
  const [actions, setActions] = useState<CommandCenterAction[]>(data.pendingActions)
  const [summary, setSummary] = useState(data.summary)

  function onResolved(actionId: string) {
    setActions((prev) => {
      const next = prev.filter((a) => a.id !== actionId)
      setSummary((s) => ({ ...s, pendingApprovals: next.length }))
      return next
    })
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agent Command Center</h1>
          <p className="text-sm text-muted-foreground">
            {scope === "platform" ? "Platform-wide" : "Your brokerage"} — live manager sessions + action approvals
          </p>
        </div>
      </header>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Stat label="Running" value={summary.activeSessions} accent="text-green-700" />
        <Stat label="Idle" value={summary.idleSessions} accent="text-amber-700" />
        <Stat label="Errored" value={summary.erroredSessions} accent="text-red-700" />
        <Stat label="Pending approvals" value={summary.pendingApprovals} accent="text-blue-700" />
        <Stat label="SLA breached" value={summary.breachedApprovals} accent={summary.breachedApprovals > 0 ? "text-red-700" : "text-slate-500"} />
      </div>

      {/* Approval queue */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Approval queue</h2>
        {actions.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">No actions awaiting approval.</Card>
        ) : (
          actions.map((a) => <ActionRow key={a.id} action={a} onResolved={onResolved} />)
        )}
      </section>

      {/* Sessions */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Manager sessions</h2>
        {data.sessions.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">No managed-agent sessions yet.</Card>
        ) : (
          <div className="space-y-2">{data.sessions.map((s) => <SessionRow key={s.id} session={s} />)}</div>
        )}
      </section>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <Card className="p-4">
      <div className={`text-3xl font-bold ${accent}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground mt-1">{label}</div>
    </Card>
  )
}

function SessionRow({ session }: { session: CommandCenterSession }) {
  return (
    <Card className="p-4 flex items-center justify-between">
      <div>
        <div className="font-medium">{KIND_LABEL[session.agentKind ?? ""] ?? session.agentKind ?? "Unknown agent"}</div>
        <div className="text-xs text-muted-foreground">
          {session.entityType} · {session.entityId.slice(0, 8)}… · last event {timeAgo(session.lastEventAt)}
        </div>
      </div>
      <Badge className={SESSION_BADGE[session.status] ?? "bg-slate-100 text-slate-700"}>{session.status}</Badge>
    </Card>
  )
}

/**
 * Gate-2 preview: the ACTUAL finished product the human is releasing — the
 * rendered section videos + the announcement email — so "Approve" means
 * "release this real thing", not "approve an intent".
 */
function DeliveryPreview({ input }: { input: Record<string, unknown> }) {
  const [showEmail, setShowEmail] = useState(false)
  const videos = Array.isArray(input.video_renders) ? (input.video_renders as Array<{ section_key: string; title: string; output_url: string; thumbnail_url: string | null }>) : []
  const email = (input.email ?? {}) as { subject?: string; preview_text?: string; preview_html?: string }
  const appt = input.appointment_at as string | null

  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review before releasing to the seller</div>

      {videos.length > 0 && (
        <div>
          <div className="text-xs font-medium mb-1">{videos.length} finished video{videos.length === 1 ? "" : "s"}</div>
          <div className="flex flex-wrap gap-2">
            {videos.map((v) => (
              <a key={v.section_key} href={v.output_url} target="_blank" rel="noreferrer"
                 className="block w-32 rounded border overflow-hidden hover:ring-2 hover:ring-amber-400">
                {v.thumbnail_url
                  ? <img src={v.thumbnail_url} alt={v.title} className="w-full h-20 object-cover" />
                  : <div className="w-full h-20 bg-slate-200 flex items-center justify-center text-xs text-slate-500">▶ video</div>}
                <div className="px-1.5 py-1 text-[11px] truncate">{v.title}</div>
              </a>
            ))}
          </div>
        </div>
      )}

      {email.subject && (
        <div>
          <div className="text-xs font-medium">Announcement email</div>
          <div className="text-sm">{email.subject}</div>
          {email.preview_text && <div className="text-xs text-muted-foreground">{email.preview_text}</div>}
          {email.preview_html && (
            <>
              <button type="button" onClick={() => setShowEmail((s) => !s)}
                      className="text-xs text-blue-600 hover:underline mt-1">
                {showEmail ? "Hide email preview" : "Preview email"}
              </button>
              {showEmail && (
                <iframe title="email preview" sandbox="" srcDoc={email.preview_html}
                        className="mt-2 w-full h-56 rounded border bg-white" />
              )}
            </>
          )}
        </div>
      )}

      {appt && <div className="text-[11px] text-muted-foreground">Seller appointment: {new Date(appt).toLocaleString()}</div>}
    </div>
  )
}

/**
 * Social preview: the ACTUAL creative + caption that will post to a public feed.
 * Approving here is "publish this to the public", so the operator sees the media
 * and copy, not just an action name.
 */
function SocialPreview({ input }: { input: Record<string, unknown> }) {
  const content = (input.content as string | null) ?? ""
  const media = Array.isArray(input.media_urls) ? (input.media_urls as string[]) : []
  const hashtags = Array.isArray(input.hashtags) ? (input.hashtags as string[]) : []
  const platform = String(input.platform ?? "social")
  const scheduledFor = input.scheduled_for as string | null
  const isVideo = (u: string) => /\.(mp4|mov|webm)(\?|$)/i.test(u)

  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Review before posting publicly</span>
        <Badge className="bg-sky-100 text-sky-800">{platform === "all" ? "every connected platform" : platform}</Badge>
      </div>
      {media.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {media.map((u, i) => (
            isVideo(u)
              ? <video key={i} src={u} controls className="w-40 h-24 rounded border object-cover bg-black" />
              : <a key={i} href={u} target="_blank" rel="noreferrer"><img src={u} alt="" className="w-40 h-24 rounded border object-cover" /></a>
          ))}
        </div>
      )}
      {content && <p className="text-sm whitespace-pre-wrap">{content}</p>}
      {hashtags.length > 0 && <p className="text-xs text-sky-700">{hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}</p>}
      {scheduledFor && <div className="text-[11px] text-muted-foreground">Scheduled to post: {new Date(scheduledFor).toLocaleString()}</div>}
    </div>
  )
}

/** Newsletter preview: the subject + body the operator is releasing to subscribers. */
function NewsletterPreview({ input }: { input: Record<string, unknown> }) {
  const subject = (input.subject_line as string | null) ?? ""
  const body = (input.content_preview as string | null) ?? ""
  const sendDate = input.send_date as string | null
  const ai = !!input.is_ai_generated
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Review before emailing subscribers</span>
        {ai && <Badge className="bg-emerald-100 text-emerald-800">AI-drafted</Badge>}
      </div>
      {subject && <div className="text-sm font-medium">Subject: {subject}</div>}
      {body && <p className="text-sm whitespace-pre-wrap max-h-48 overflow-auto">{body}</p>}
      {sendDate && <div className="text-[11px] text-muted-foreground">Scheduled to send: {new Date(sendDate).toLocaleString()}</div>}
    </div>
  )
}

/** Direct-mail preview: the rendered design + copy for the whole campaign (one approval per campaign). */
function DirectMailPreview({ input }: { input: Record<string, unknown> }) {
  const design = (input.design_url as string | null) ?? null
  const copy = (input.copy_text as string | null) ?? ""
  const pieceType = (input.piece_type as string | null) ?? "mail"
  const quantity = input.quantity as number | null
  const audience = (input.target_audience as string | null) ?? null
  const mailingDate = input.mailing_date as string | null
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Review before it prints + mails</span>
        <Badge className="bg-amber-100 text-amber-900">{pieceType}{quantity ? ` · ${quantity} pieces` : ""}</Badge>
      </div>
      {design && <a href={design} target="_blank" rel="noreferrer"><img src={design} alt="mail design" className="w-56 rounded border" /></a>}
      {copy && <p className="text-sm whitespace-pre-wrap">{copy}</p>}
      {audience && <div className="text-[11px] text-muted-foreground">Audience: {audience}</div>}
      {mailingDate && <div className="text-[11px] text-muted-foreground">Mailing date: {new Date(mailingDate).toLocaleString()}</div>}
    </div>
  )
}

/** Ads Manager action: the spend move the operator is authorizing (launch/pause/budget). */
function AdActionPreview({ input, actionType }: { input: Record<string, unknown>; actionType: string }) {
  const newBudget = input.new_daily_budget as number | null
  const label: Record<string, string> = {
    launch_ad_campaign: "Launch campaign", pause_ad_campaign: "Pause campaign",
    shift_ad_budget: "Shift daily budget", scale_ad_creative: "Scale winning campaign",
  }
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Authorize this ad-spend action</span>
        <Badge className="bg-rose-100 text-rose-800">{label[actionType] ?? actionType}</Badge>
      </div>
      {newBudget != null && <div className="text-sm font-medium">New daily budget: ${newBudget}/day</div>}
      <div className="text-[11px] text-muted-foreground">Spend moves only on your approval, and the server caps it.</div>
    </div>
  )
}

/** Ad creative: the headline/copy/CTA that will run as a paid ad. */
function AdCreativePreview({ input }: { input: Record<string, unknown> }) {
  const headline = (input.headline as string | null) ?? ""
  const primary = (input.primary_text as string | null) ?? ""
  const cta = (input.call_to_action as string | null) ?? ""
  const media = (input.media_asset_url as string | null) ?? null
  const dest = (input.destination_url as string | null) ?? null
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review before it runs as a paid ad</div>
      {media && <a href={media} target="_blank" rel="noreferrer"><img src={media} alt="ad creative" className="w-56 rounded border" /></a>}
      {headline && <div className="text-sm font-semibold">{headline}</div>}
      {primary && <p className="text-sm whitespace-pre-wrap">{primary}</p>}
      <div className="flex items-center gap-2 text-xs">
        {cta && <Badge className="bg-pink-100 text-pink-800">{cta}</Badge>}
        {dest && <a href={dest} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline truncate max-w-xs">{dest}</a>}
      </div>
    </div>
  )
}

/** Predicted-seller auto-touch: the outreach to a likely-to-list homeowner. */
function PredictiveTouchPreview({ input }: { input: Record<string, unknown> }) {
  const subject = input.subject as string | null, body = input.body as string | null
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Review before it reaches the homeowner</span>
        <Badge className="bg-teal-100 text-teal-800">{String(input.channel ?? "outreach")} · PLS {String(input.pls_score ?? "?")}</Badge>
      </div>
      {!!subject && <div className="text-sm font-medium">{subject}</div>}
      {!!body ? <p className="text-sm whitespace-pre-wrap">{body}</p> : <p className="text-xs text-muted-foreground italic">Message is AI-drafted at send time; approving queues it (compliance-checked before it goes out).</p>}
    </div>
  )
}
/** Deal at-risk task: an item the agent must resolve to keep the transaction on track. */
function TransactionTaskPreview({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>At-risk on a transaction</span>
        {!!input.severity && <Badge className="bg-red-100 text-red-800">{String(input.severity)}</Badge>}
      </div>
      {!!input.headline && <div className="text-sm font-medium">{String(input.headline)}</div>}
      {!!input.detail && <p className="text-sm whitespace-pre-wrap">{String(input.detail)}</p>}
      <div className="text-[11px] text-muted-foreground">
        {!!input.suggested_recipient && <>Recipient: {String(input.suggested_recipient)} · </>}
        {!!input.due_date && <>Due {new Date(String(input.due_date)).toLocaleDateString()}</>}
      </div>
    </div>
  )
}

/** Autopilot follow-up: a scheduled reminder (e.g. open-house check-in) the agent does or skips. */
function FollowupPreview({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Scheduled follow-up</span>
        {!!input.priority && <Badge className="bg-cyan-100 text-cyan-800">{String(input.priority)}</Badge>}
      </div>
      {!!input.title && <div className="text-sm font-medium">{String(input.title)}</div>}
      {!!input.description && <p className="text-sm whitespace-pre-wrap">{String(input.description)}</p>}
      {!!input.scheduled_for && <div className="text-[11px] text-muted-foreground">Due {new Date(String(input.scheduled_for)).toLocaleString()}</div>}
    </div>
  )
}

function SmartTaskPreview({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>Open deal to-do</span>
        {!!input.priority && <Badge className="bg-red-50 text-red-700">{String(input.priority)}</Badge>}
        {!!input.ai_generated && <Badge className="bg-purple-100 text-purple-800">AI-suggested</Badge>}
      </div>
      {!!input.title && <div className="text-sm font-medium">{String(input.title)}</div>}
      {!!input.description && <p className="text-sm whitespace-pre-wrap">{String(input.description)}</p>}
      <div className="text-[11px] text-muted-foreground">
        {!!input.category && <>{String(input.category)} · </>}
        {!!input.assigned_to && <>Assigned: {String(input.assigned_to)} · </>}
        {!!input.due_date && <>Due {new Date(String(input.due_date)).toLocaleDateString()}</>}
      </div>
    </div>
  )
}

/** Blog post: the SEO article copy reviewed before it publishes to the site. */
function BlogPreview({ input }: { input: Record<string, unknown> }) {
  const img = (input.featured_image_url as string | null) ?? null
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review before it publishes to your site</div>
      {img && <a href={img} target="_blank" rel="noreferrer"><img src={img} alt="" className="w-56 rounded border" /></a>}
      {!!input.title && <div className="text-sm font-semibold">{String(input.title)}</div>}
      {!!input.excerpt && <p className="text-sm italic text-muted-foreground">{String(input.excerpt)}</p>}
      {!!input.content_preview && <p className="text-sm whitespace-pre-wrap max-h-48 overflow-auto">{String(input.content_preview)}</p>}
    </div>
  )
}
/** Podcast episode: generated audio reviewed before it distributes to Spotify/Apple/etc. */
function PodcastPreview({ input }: { input: Record<string, unknown> }) {
  const audio = (input.audio_url as string | null) ?? null
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review before it distributes to Spotify / Apple / etc.</div>
      {!!input.title && <div className="text-sm font-semibold">{String(input.title)}</div>}
      {!!input.description && <p className="text-sm whitespace-pre-wrap">{String(input.description)}</p>}
      {audio && <audio src={audio} controls className="w-full" />}
    </div>
  )
}

function ActionRow({ action, onResolved }: { action: CommandCenterAction; onResolved: (id: string) => void }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const isClientMsg = action.queue === "client_message"
  const [editedBody, setEditedBody] = useState<string>(isClientMsg ? String(action.actionInput.body ?? "") : "")

  function run(kind: "approve" | "reject") {
    setError(null)
    startTransition(async () => {
      const res = kind === "approve"
        ? await approveAgentAction({ queue: action.queue, actionId: action.id, ...(isClientMsg ? { editedBody } : {}) })
        : await rejectAgentAction({ queue: action.queue, actionId: action.id })
      if (res.ok) onResolved(action.id)
      else setError(res.error ?? "Action failed")
    })
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge className={QUEUE_BADGE[action.queue] ?? "bg-slate-100 text-slate-700"}>
              {QUEUE_LABEL[action.queue] ?? action.queue}
            </Badge>
            <span className="font-medium">{action.actionType.replace(/_/g, " ")}</span>
            {action.slaLevel === "breached" && (
              <Badge className="bg-red-100 text-red-800">SLA breached · {Math.round(action.ageHours)}h</Badge>
            )}
            {action.slaLevel === "due" && (
              <Badge className="bg-amber-100 text-amber-800">SLA due · {Math.round(action.ageHours)}h</Badge>
            )}
          </div>
          {action.rationale && <p className="text-sm text-muted-foreground mt-1">{action.rationale}</p>}
          {action.actionType === "approve_prelisting_delivery" && <DeliveryPreview input={action.actionInput} />}
          {action.queue === "social" && <SocialPreview input={action.actionInput} />}
          {action.queue === "newsletter" && <NewsletterPreview input={action.actionInput} />}
          {action.queue === "direct_mail" && <DirectMailPreview input={action.actionInput} />}
          {action.queue === "ads" && <AdActionPreview input={action.actionInput} actionType={action.actionType} />}
          {action.queue === "ad_creative" && <AdCreativePreview input={action.actionInput} />}
          {action.queue === "predictive_listing" && <PredictiveTouchPreview input={action.actionInput} />}
          {action.queue === "transaction_task" && <TransactionTaskPreview input={action.actionInput} />}
          {action.queue === "transaction_smart_task" && <SmartTaskPreview input={action.actionInput} />}
          {action.queue === "agent_followup" && <FollowupPreview input={action.actionInput} />}
          {action.queue === "blog" && <BlogPreview input={action.actionInput} />}
          {action.queue === "podcast" && <PodcastPreview input={action.actionInput} />}
          {isClientMsg && (
            <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <span>Review/edit before it reaches the {String(action.actionInput.audience ?? "client")}</span>
                <Badge className="bg-indigo-100 text-indigo-800">{String(action.actionInput.audience ?? "client")}</Badge>
                <Badge className="bg-slate-100 text-slate-700">via {String(action.actionInput.channel ?? "portal").replace("_", " ")}</Badge>
              </div>
              {!!action.actionInput.subject && <div className="text-sm font-medium">{String(action.actionInput.subject)}</div>}
              <textarea className="w-full text-sm rounded border p-2 min-h-[120px] bg-white" value={editedBody} onChange={(e) => setEditedBody(e.target.value)} />
              {!!action.actionInput.briefing && <div className="text-[11px] text-muted-foreground">Agent note: {String(action.actionInput.briefing)}</div>}
            </div>
          )}
          <div className="text-xs text-muted-foreground mt-1">proposed {timeAgo(action.proposedAt)}</div>
          {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
        </div>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run("reject")}>{action.queue === "transaction_task" ? "Dismiss" : action.queue === "transaction_smart_task" ? "Cancel" : action.queue === "agent_followup" ? "Skip" : "Reject"}</Button>
          <Button size="sm" disabled={pending} onClick={() => run("approve")}>{pending ? "…" : action.actionType === "approve_prelisting_delivery" ? "Release" : isClientMsg ? "Approve & Send" : action.queue === "transaction_task" ? "Resolve" : action.queue === "transaction_smart_task" ? "Done" : action.queue === "agent_followup" ? "Done" : action.queue === "predictive_listing" ? "Approve & Queue" : action.queue === "blog" ? "Approve & Publish" : action.queue === "podcast" ? "Approve & Distribute" : "Approve"}</Button>
        </div>
      </div>
    </Card>
  )
}
