"use client"

// TENANT STATUS NOTICE — the platform → tenant incident broadcast. What gets
// typed here is exactly what every tenant sees on /dashboard/whats-new (the
// staff announcements rail never reaches tenants). Superadmin-gated + audited
// server-side (setStatusNoticeAction).

import { useState, useTransition } from "react"
import { Megaphone, Loader2 } from "lucide-react"
import { setStatusNoticeAction } from "@/app/actions/superadmin/platform-controls"
import type { StatusNotice, StatusNoticeSeverity } from "@/lib/platform/status-notice"

export function StatusNoticePanel({ initial }: { initial: StatusNotice }) {
  const [notice, setNotice] = useState<StatusNotice>(initial)
  const [message, setMessage] = useState(initial.message)
  const [severity, setSeverity] = useState<StatusNoticeSeverity>(initial.severity)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

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
