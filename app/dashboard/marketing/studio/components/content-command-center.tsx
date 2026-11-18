"use client"

// THE CONTENT AND CHANNEL COMMAND CENTER (wave 154, lane 154G2 — directive G7, owner ruling R8).
// One searchable workspace over every canonical content record the session may see. It reads ONLY through
// getContentCommandCenter (lib/marketing/campaign-registry.ts) and acts ONLY through the door
// app/api/marketing/content-command/route.ts, which re-reads the row under the session and calls the EXISTING writer the
// catalog names. No button here writes anything
// itself, and a field the records do not carry renders "unknown" — never a default.

import { useCallback, useEffect, useMemo, useState } from "react"
import { getContentCommandCenter } from "@/lib/marketing/campaign-registry"
import type { CatalogRow, CatalogStatus, CatalogActionKind } from "@/lib/marketing/content-catalog"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Search, ExternalLink, Lock } from "lucide-react"

type View = "campaign" | "topic" | "channel" | "artifact" | "recipient" | "creator" | "status" | "result"
const VIEWS: Array<{ value: View; label: string }> = [
  { value: "topic", label: "By topic" }, { value: "campaign", label: "By campaign" }, { value: "channel", label: "By channel" },
  { value: "artifact", label: "By artifact" }, { value: "recipient", label: "By recipient / journey" }, { value: "creator", label: "By creator" },
  { value: "status", label: "By status" }, { value: "result", label: "By result" },
]
const STATUSES: Array<{ value: CatalogStatus; label: string }> = [
  { value: "unconfigured", label: "Not set up" }, { value: "blocked_by_rights", label: "Blocked by rights" }, { value: "draft", label: "Draft" },
  { value: "awaiting_approval", label: "Awaiting approval" }, { value: "ready", label: "Ready (not sent)" }, { value: "queued", label: "Queued" },
  { value: "accepted", label: "Accepted (no receipt)" }, { value: "delivered", label: "Delivered" }, { value: "posted", label: "Posted" },
  { value: "failed", label: "Failed" }, { value: "rejected", label: "Rejected" }, { value: "cancelled", label: "Cancelled" }, { value: "outcome_unknown", label: "Outcome unknown" },
]
const TONE: Partial<Record<CatalogStatus, string>> = {
  failed: "bg-red-100 text-red-800", blocked_by_rights: "bg-red-100 text-red-800", rejected: "bg-zinc-200 text-zinc-700", cancelled: "bg-zinc-200 text-zinc-700",
  posted: "bg-emerald-100 text-emerald-800", delivered: "bg-emerald-100 text-emerald-800", accepted: "bg-sky-100 text-sky-800", queued: "bg-sky-100 text-sky-800",
  ready: "bg-violet-100 text-violet-800", awaiting_approval: "bg-amber-100 text-amber-800", unconfigured: "bg-amber-100 text-amber-800", outcome_unknown: "bg-zinc-100 text-zinc-700",
}
/** The ONE action door (app/api/marketing/content-command/route.ts): re-reads the row under the session, refuses what is not
 *  offered, calls the canonical writer, reads back. */
const CONTENT_COMMAND_DOOR = "/api/marketing/content-command"
const unknown = (v: unknown): string => (v === null || v === undefined || v === "" ? "unknown" : String(v))

function groupKey(r: CatalogRow, view: View): string {
  switch (view) {
    case "campaign": return r.campaign ? r.campaign.name ?? r.campaign.id : "No campaign"
    case "topic": return r.topics.length ? r.topics.map((t) => t.title ?? t.id).join(" · ") : "No topic"
    case "channel": return r.channels.length ? r.channels.join(", ") : "Channel unknown"
    case "artifact": return r.artifactType.split(":")[0]
    case "recipient": return r.recipientContactId ? `Recipient ${r.recipientContactId.slice(0, 8)}` : "No single recipient"
    case "creator": return r.creatorUserId ?? r.creatorAgentId ?? "Creator unknown"
    case "status": return r.statusLabel
    case "result": return r.engagement || r.attributedResults ? "Has measured results" : "No measured result yet"
  }
}

export default function ContentCommandCenter() {
  const [rows, setRows] = useState<CatalogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [scopeLabel, setScopeLabel] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  /** the committed query — a search runs on Enter / Refresh, not on every keystroke */
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<CatalogStatus | "all">("all")
  const [view, setView] = useState<View>("topic")
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [busy, setBusy] = useState<CatalogActionKind | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [qrTarget, setQrTarget] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    const res = await getContentCommandCenter({ search: query.trim() || null, status: status === "all" ? null : status })
    setLoading(false)
    if (!res.success) { setError(res.error ?? "Your content couldn't be loaded."); setRows([]); return }
    setError(null)
    setRows(res.rows)
    setNotice(res.notice)
    setScopeLabel(res.scopeLabel)
  }, [query, status])

  useEffect(() => { void load() }, [load])

  const groups = useMemo(() => {
    const m = new Map<string, CatalogRow[]>()
    for (const r of rows) { const k = groupKey(r, view); m.set(k, [...(m.get(k) ?? []), r]) }
    return [...m.entries()]
  }, [rows, view])
  const selected = rows.find((r) => r.key === selectedKey) ?? null

  async function act(row: CatalogRow, kind: CatalogActionKind) {
    setBusy(kind)
    setActionMessage(null)
    let res: { success: boolean; error?: string; row?: CatalogRow | null }
    try {
      const resp = await fetch(CONTENT_COMMAND_DOOR, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceType: row.sourceType, sourceId: row.sourceId, action: kind, targetUrl: kind === "change_qr_destination" ? qrTarget : null }),
      })
      res = await resp.json()
    } catch {
      res = { success: false, error: "That didn't reach the server. Check your connection and try again." }
    }
    setBusy(null)
    setActionMessage(res.success ? `Done — the record now reads: ${res.row?.statusLabel ?? "unknown"}.` : res.error ?? "That didn't go through.")
    if (res.row) setRows((prev) => prev.map((r) => (r.key === res.row!.key ? res.row! : r)))
    else if (res.success) await load()
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      <Card>
        <CardHeader>
          <CardTitle>Content and Channel Command Center</CardTitle>
          <CardDescription>
            Every idea, draft, render, post, mail piece and QR destination you can see — where it is going, who owns the next step and what
            happened after delivery. Showing: {scopeLabel ?? "unknown scope"}.
          </CardDescription>
          <div className="flex flex-wrap gap-2 pt-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search a topic, title or campaign" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") setQuery(search) }} />
            </div>
            <Select value={status} onValueChange={(v) => setStatus(v as CatalogStatus | "all")}>
              <SelectTrigger className="w-[190px]"><SelectValue placeholder="Any status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any status</SelectItem>
                {STATUSES.map((st) => <SelectItem key={st.value} value={st.value}>{st.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={view} onValueChange={(v) => setView(v as View)}>
              <SelectTrigger className="w-[190px]"><SelectValue /></SelectTrigger>
              <SelectContent>{VIEWS.map((v) => <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="outline" onClick={() => { if (query !== search) setQuery(search); else void load() }} disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Refresh"}</Button>
          </div>
          {notice && <p className="text-sm text-amber-700 pt-2">{notice}</p>}
          {error && <p className="text-sm text-red-700 pt-2">{error}</p>}
        </CardHeader>
        <CardContent className="space-y-5">
          {!loading && rows.length === 0 && !error && <p className="text-sm text-muted-foreground">Nothing matches in what you can see.</p>}
          {groups.map(([label, items]) => (
            <div key={label} className="space-y-2">
              <h4 className="text-sm font-semibold">{label} <span className="text-muted-foreground font-normal">({items.length})</span></h4>
              {items.map((r) => (
                <button key={r.key} type="button" onClick={() => { setSelectedKey(r.key); setActionMessage(null); setQrTarget(r.qrLinks[0]?.targetUrl ?? "") }}
                  className={`w-full text-left rounded-lg border p-3 hover:bg-muted ${selectedKey === r.key ? "border-violet-500" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{r.secured && <Lock className="inline h-3 w-3 mr-1" />}{r.title}</span>
                    <span className={`text-xs rounded px-2 py-0.5 whitespace-nowrap ${TONE[r.status] ?? "bg-zinc-100"}`}>{r.statusLabel}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3">
                    <span>{r.artifactType}</span><span>{r.channels.join(", ") || "channel unknown"}</span>
                    <span className="font-mono">{r.sourceType}:{r.sourceId.slice(0, 8)}</span>
                    {r.nextAction && <span>Next: {r.nextAction.action}</span>}
                  </div>
                </button>
              ))}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="h-fit lg:sticky lg:top-4">
        <CardHeader>
          <CardTitle className="text-base">{selected ? selected.title : "Select an item"}</CardTitle>
          {selected && <CardDescription className="font-mono text-xs">{selected.sourceType} · {selected.sourceId}</CardDescription>}
        </CardHeader>
        {selected && (
          <CardContent className="space-y-4 text-sm">
            {selected.thumbnailUrl && !selected.secured && <img src={selected.thumbnailUrl} alt="" className="rounded-md max-h-48 object-cover w-full" />}
            {selected.preview && <p className="text-muted-foreground whitespace-pre-wrap">{selected.preview}</p>}
            <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Status</dt><dd>{selected.statusLabel} <span className="text-xs text-muted-foreground">({unknown(selected.rawStatus)})</span></dd>
              <dt className="text-muted-foreground">Artifact</dt><dd>{selected.artifactType}</dd>
              <dt className="text-muted-foreground">Channels</dt><dd>{selected.channels.join(", ") || "unknown"}</dd>
              <dt className="text-muted-foreground">Topic</dt><dd>{selected.topics.map((t) => t.title ?? t.id).join(" · ") || "none linked"}</dd>
              <dt className="text-muted-foreground">Campaign</dt><dd>{selected.campaign ? unknown(selected.campaign.name) : "none"}</dd>
              <dt className="text-muted-foreground">Audience</dt><dd>{unknown(selected.audience)}</dd>
              <dt className="text-muted-foreground">Brand voice</dt><dd>{unknown(selected.brandVoice)}</dd>
              <dt className="text-muted-foreground">Rights</dt><dd>{selected.rightsVerdict ?? (selected.rights ? "recorded" : "unknown")}</dd>
              <dt className="text-muted-foreground">Origin</dt><dd>{selected.origin ? `${selected.origin.table}:${selected.origin.id.slice(0, 8)}` : "unknown"}</dd>
              <dt className="text-muted-foreground">Scheduled</dt><dd>{unknown(selected.scheduledAt)}</dd>
              <dt className="text-muted-foreground">Provider cost</dt><dd>{selected.providerCostVisibility === "restricted" ? "restricted to finance admins" : selected.providerCostUsd === null ? "unknown" : `$${selected.providerCostUsd.toFixed(2)}`}</dd>
              <dt className="text-muted-foreground">Engagement</dt><dd>{selected.engagement ? Object.entries(selected.engagement).map(([k, v]) => `${k} ${v}`).join(" · ") : "unknown"}</dd>
              <dt className="text-muted-foreground">Results</dt><dd>{selected.attributedResults ? Object.entries(selected.attributedResults).map(([k, v]) => `${k} ${v}`).join(" · ") : "unknown"}</dd>
              <dt className="text-muted-foreground">Receipts</dt><dd>{selected.receipts.length ? selected.receipts.map((x) => `${x.kind}${x.ref ? ` ${x.ref}` : ""}`).join(" · ") : "none"}</dd>
              <dt className="text-muted-foreground">Last decision</dt><dd>{selected.lastDecision ? `${selected.lastDecision.what} → ${unknown(selected.lastDecision.outcome)} (${unknown(selected.lastDecision.by)})` : "none recorded"}</dd>
            </dl>
            {selected.nextAction && (
              <div className="rounded-md border p-3 space-y-1">
                <div className="font-medium">Next: {selected.nextAction.action} <Badge variant="outline">{selected.nextAction.status}</Badge></div>
                <div className="text-xs text-muted-foreground">Manager: {unknown(selected.nextAction.manager)} · Trigger: {unknown(selected.nextAction.trigger)} · Due: {unknown(selected.nextAction.dueAt)}</div>
                {selected.nextAction.why && <div className="text-xs">{selected.nextAction.why}</div>}
              </div>
            )}
            {selected.dependencies.length > 0 && (
              <ul className="space-y-1">{selected.dependencies.map((d) => <li key={`${d.kind}:${d.ref}`} className={d.satisfied ? "text-emerald-700" : "text-red-700"}>{d.satisfied ? "✓" : "✗"} {d.note}</li>)}</ul>
            )}
            {selected.qrLinks.length > 0 && (
              <div className="space-y-1">{selected.qrLinks.map((q) => <div key={q.qrCodeId} className="text-xs">QR /{unknown(q.slug)} → {unknown(q.targetUrl)} · v{unknown(q.version)} · {q.active ? "live" : "not live"} · scans {unknown(q.scans)}</div>)}</div>
            )}
            {selected.actions.some((a) => a.kind === "change_qr_destination") && (
              <Input value={qrTarget} onChange={(e) => setQrTarget(e.target.value)} placeholder="New destination (the printed code stays the same)" />
            )}
            <div className="flex flex-wrap gap-2">
              {selected.actions.map((a) => (
                <Button key={`${a.kind}:${a.writer}`} size="sm" variant={a.kind === "decline_proposal" || a.kind === "reject" ? "outline" : "default"} disabled={busy !== null} onClick={() => void act(selected, a.kind)}>
                  {busy === a.kind ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}{a.label}
                </Button>
              ))}
            </div>
            {selected.blocked.length > 0 && <ul className="text-xs text-muted-foreground space-y-1">{selected.blocked.map((b) => <li key={b.kind}>Not available — {b.reason}</li>)}</ul>}
            {actionMessage && <p className="text-sm">{actionMessage}</p>}
            {selected.link && (
              <a href={selected.link} className="inline-flex items-center gap-1 text-violet-700 underline text-xs">
                {selected.secured ? "Open in its secured workspace" : "Open where it is edited"} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  )
}
