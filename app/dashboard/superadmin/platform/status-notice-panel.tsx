"use client"

// TENANT STATUS NOTICE — the platform → tenant incident broadcast. What gets
// typed here is exactly what every tenant sees on /dashboard/whats-new (the
// staff announcements rail never reaches tenants). Superadmin-gated + audited
// server-side (setStatusNoticeAction).
//
// PROPOSED-BY-HEALTH-CHECK: when the health-check cron records consecutive
// DOWN checks on a platform-critical provider it stores a PREFILLED proposal
// (never published automatically). This panel surfaces it with one-click
// publish/dismiss; a proposal auto-withdraws if the provider recovers first.

import { useEffect, useState, useTransition } from "react"
import { Megaphone, Loader2, Activity } from "lucide-react"
import {
  setStatusNoticeAction,
  getStatusNoticeStateAction,
  publishProposedStatusNoticeAction,
  dismissProposedStatusNoticeAction,
} from "@/app/actions/superadmin/platform-controls"
import type { StatusNotice, StatusNoticeSeverity, ProposedStatusNotice } from "@/lib/platform/status-notice"

export function StatusNoticePanel({ initial }: { initial: StatusNotice }) {
  const [notice, setNotice] = useState<StatusNotice>(initial)
  const [proposed, setProposed] = useState<ProposedStatusNotice | null>(null)
  const [message, setMessage] = useState(initial.message)
  const [severity, setSeverity] = useState<StatusNoticeSeverity>(initial.severity)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // The server page passes only the tenant-visible notice; fetch the pending
  // health-check proposal (if any) once mounted.
  useEffect(() => {
    let cancelled = false
    getStatusNoticeStateAction().then((res) => {
      if (!cancelled && res.ok) {
        setNotice(res.state.notice)
        setProposed(res.state.proposed)
      }
    })
    return () => { cancelled = true }
  }, [])

  function publish(active: boolean) {
    setError(null)
    startTransition(async () => {
      const res = await setStatusNoticeAction({ active, severity, message })
      if (!res.ok) setError(res.error)
      else {
        setNotice(res.notice)
        if (!res.notice.active) { setMessage(""); setSeverity("info") }
      }
    })
  }

  function publishProposal() {
    setError(null)
    startTransition(async () => {
      const res = await publishProposedStatusNoticeAction()
      if (!res.ok) setError(res.error)
      else {
        setNotice(res.notice)
        setProposed(null)
        setMessage(res.notice.message)
        setSeverity(res.notice.severity)
      }
    })
  }

  function dismissProposal() {
    setError(null)
    startTransition(async () => {
      const res = await dismissProposedStatusNoticeAction()
      if (!res.ok) setError(res.error)
      else {
        setNotice(res.state.notice)
        setProposed(null)
      }
    })
  }

  return (
    <div className={"rounded-xl border p-4 " + (notice.active ? "border-amber-300 bg-amber-50/50" : "border-slate-200")}>
      <div className="flex items-center gap-2 mb-2">
        <Megaphone className={"h-5 w-5 " + (notice.active ? "text-amber-600" : "text-slate-500")} />
        <h2 className="text-base font-semibold">Tenant status notice</h2>
        {notice.active
          ? <span className="ml-1 rounded bg-amber-600 px-2 py-0.5 text-xs font-semibold text-white uppercase">{notice.severity} — live to all tenants</span>
          : <span className="ml-1 rounded bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">no active notice</span>}
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Incident / maintenance broadcast shown to every tenant on their &quot;What&apos;s new &amp; platform status&quot; page.
        Staff announcements do NOT reach tenants — this is the tenant-facing lane.
      </p>

      {proposed && (
        <div className="mb-3 rounded-lg border border-orange-300 bg-orange-50 p-3">
          <div className="flex items-center gap-2 mb-1">
            <Activity className="h-4 w-4 text-orange-600" />
            <p className="text-sm font-semibold text-orange-900">
              Proposed by health-check
              <span className="ml-2 rounded bg-orange-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">{proposed.severity}</span>
            </p>
          </div>
          <p className="text-xs text-orange-800 mb-1">
            Provider <span className="font-mono font-medium">{proposed.provider}</span>
            {proposed.reason ? ` — ${proposed.reason}` : ""}. Not visible to tenants until you publish.
            It withdraws itself if checks recover first; once published, only staff clear it.
          </p>
          <p className="text-sm text-orange-900 mb-2">&ldquo;{proposed.message}&rdquo;</p>
          <div className="flex items-center gap-2">
            <button
              className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              disabled={pending}
              onClick={publishProposal}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" /> : null}
              Publish to tenants
            </button>
            <button
              className="rounded-md border border-orange-300 px-3 py-1.5 text-sm font-medium text-orange-800 disabled:opacity-50"
              disabled={pending}
              onClick={dismissProposal}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <textarea
          className="w-full rounded border p-2 text-sm min-h-[70px]"
          placeholder="e.g. Our SMS provider is experiencing delays — outbound texts may arrive late. Voice and email are unaffected."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <select className="rounded border p-2 text-sm" value={severity} onChange={(e) => setSeverity(e.target.value as StatusNoticeSeverity)}>
            <option value="info">Info (maintenance / heads-up)</option>
            <option value="degraded">Degraded service</option>
            <option value="outage">Outage</option>
          </select>
          <button
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={pending || !message.trim()}
            onClick={() => publish(true)}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" /> : null}
            {notice.active ? "Update notice" : "Publish to tenants"}
          </button>
          {notice.active && (
            <button
              className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50"
              disabled={pending}
              onClick={() => publish(false)}
            >
              Clear notice
            </button>
          )}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  )
}
