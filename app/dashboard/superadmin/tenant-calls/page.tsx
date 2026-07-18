import Link from "next/link"
import { redirect } from "next/navigation"
import { headers } from "next/headers"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

// TENANT CALL LOG OVERSIGHT — support tooling: help a tenant debug their AI
// calls by reading the SAME ledger their dashboard reads (voice_calls —
// direction, phone_from/to, duration_seconds, status, outcome, sentiment,
// summary, transcription, ai_notes — all written by the voice webhooks and the
// analysis sweep; nothing here is fabricated). PLATFORM-GLOBAL READ by design
// (support-gated, service client) following the platform-global conventions
// (see app/dashboard/superadmin/a2p/page.tsx header).
//
// PRIVACY POSTURE: this board exposes tenant call content, so (1) phone
// numbers render masked to last-4 — enough to correlate the call a tenant is
// asking about, not enough to harvest; (2) filtering to a SPECIFIC tenant
// writes a superadmin_audit_log row ('oversight.tenant_calls_viewed', target
// brokerage) BEFORE any of that tenant's calls render — and if the audit write
// fails, the calls do NOT render. Access is audited, honestly.

function maskNumber(num: string | null | undefined): string {
  if (!num) return "unknown"
  const digits = num.replace(/\D/g, "")
  return digits.length >= 4 ? `•••${digits.slice(-4)}` : "•••"
}

function fmtDuration(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return "—"
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
}

const SENTIMENT_CLS: Record<string, string> = {
  positive: "bg-emerald-100 text-emerald-800",
  negative: "bg-red-100 text-red-800",
  mixed: "bg-amber-100 text-amber-800",
  neutral: "bg-slate-100 text-slate-600",
}

export default async function TenantCallsOversightPage(
  { searchParams }: { searchParams: Promise<{ brokerageId?: string }> },
) {
  const gate = await requirePlatformCapability("support")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: requires platform support capability</div>

  const params = await searchParams
  const svc = createServiceClient()

  const { data: brokerageRows, error: brkError } = await svc
    .from("brokerages").select("id, name").is("deleted_at", null).order("name")
  if (brkError) return <div className="p-6 text-red-600">Failed to load tenants: {brkError.message}</div>
  const brokerages = (brokerageRows ?? []) as { id: string; name: string | null }[]

  // Only honor a brokerageId that names a real tenant — junk params are ignored.
  const selected = brokerages.find((b) => b.id === params.brokerageId) ?? null

  // AUDIT BEFORE READ: viewing a specific tenant's call content is logged, and
  // a failed audit write blocks the view — no unaudited access path.
  if (selected) {
    const { data: actor } = await svc.from("users").select("email").eq("id", gate.userId).maybeSingle()
    const hdrs = await headers()
    const { error: auditError } = await svc.from("superadmin_audit_log").insert({
      actor_user_id: gate.userId,
      actor_email: (actor as any)?.email ?? null,
      action: "oversight.tenant_calls_viewed",
      target_type: "brokerage",
      target_id: selected.id,
      details: { brokerage_name: selected.name, surface: "superadmin/tenant-calls" },
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
    if (auditError) {
      return (
        <div className="p-6 text-red-600">
          Audit write failed ({auditError.message}) — tenant call logs are only shown when the access can be recorded.
        </div>
      )
    }
  }

  let callsQuery = svc
    .from("voice_calls")
    .select("id, brokerage_id, direction, call_type, status, outcome, phone_from, phone_to, duration_seconds, started_at, created_at, sentiment, summary, transcription, ai_notes, compliance_passed")
    .order("created_at", { ascending: false })
    .limit(100)
  if (selected) callsQuery = callsQuery.eq("brokerage_id", selected.id)
  const { data: callRows, error: callsError } = await callsQuery
  if (callsError) return <div className="p-6 text-red-600">Failed to load calls: {callsError.message}</div>
  const calls = (callRows ?? []) as any[]

  const tenantName = new Map(brokerages.map((b) => [b.id, b.name ?? "(unnamed)"]))

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Tenant call logs</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Cross-tenant voice_calls oversight — the same ledger each tenant's dashboard reads,
            for debugging a tenant's AI calls with them. Numbers are masked to last-4.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/home" className="rounded-md border px-3 py-1 text-sm">Home</Link>
          <Link href="/dashboard/superadmin/communications" className="rounded-md border px-3 py-1 text-sm">Communications</Link>
          <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
        </div>
      </div>

      {/* Audited-access notice — prominent, honest. */}
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <span className="font-semibold">Access is audited.</span> Filtering to a specific tenant writes an
        entry to the superadmin action ledger (oversight.tenant_calls_viewed) before that tenant's calls
        are shown. Use this board only to support a tenant with their own calls.
      </div>

      {/* Tenant filter — plain GET form, no client JS. */}
      <form method="GET" className="flex items-center gap-2 text-sm">
        <label htmlFor="brokerageId" className="text-muted-foreground">Tenant</label>
        <select id="brokerageId" name="brokerageId" defaultValue={selected?.id ?? ""} className="rounded-md border px-2 py-1 bg-background">
          <option value="">All tenants</option>
          {brokerages.map((b) => (
            <option key={b.id} value={b.id}>{b.name ?? "(unnamed)"}</option>
          ))}
        </select>
        <button type="submit" className="rounded-md border px-3 py-1">Apply</button>
        {selected && (
          <Link href="/dashboard/superadmin/tenant-calls" className="text-xs text-muted-foreground underline">Clear filter</Link>
        )}
      </form>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">
          {selected ? `Recent calls — ${selected.name ?? "(unnamed)"}` : "Recent calls — all tenants"}
          <span className="ml-2 text-sm font-normal text-muted-foreground">({calls.length})</span>
        </h2>
        {calls.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            {selected
              ? "This tenant has no recorded AI calls yet."
              : "No AI calls recorded across any tenant yet."}
          </div>
        ) : (
          <div className="rounded-lg border divide-y">
            {calls.map((c) => {
              const transcription = typeof c.transcription === "string" ? c.transcription.trim() : ""
              const summary = typeof c.summary === "string" ? c.summary.trim() : ""
              const aiNotes = typeof c.ai_notes === "string" ? c.ai_notes.trim() : ""
              return (
                <details key={c.id} className="group">
                  <summary className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 cursor-pointer text-sm hover:bg-muted/40">
                    {!selected && (
                      <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-indigo-100 text-indigo-800">
                        {tenantName.get(c.brokerage_id) ?? "(unknown tenant)"}
                      </span>
                    )}
                    <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-700">
                      {c.direction ?? "—"}{c.call_type ? ` · ${c.call_type}` : ""}
                    </span>
                    <span className="font-medium tabular-nums">{maskNumber(c.phone_from)}</span>
                    <span className="text-muted-foreground">→ {maskNumber(c.phone_to)}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{fmtDuration(c.duration_seconds)}</span>
                    <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-600">
                      {c.outcome ?? c.status ?? "—"}
                    </span>
                    {c.sentiment && (
                      <span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + (SENTIMENT_CLS[c.sentiment] ?? "bg-slate-100 text-slate-600")}>
                        {c.sentiment}
                      </span>
                    )}
                    {c.compliance_passed === false && (
                      <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-100 text-red-800">compliance flag</span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {new Date(c.started_at ?? c.created_at).toLocaleString()}
                    </span>
                  </summary>
                  <div className="px-3 pb-3 space-y-2">
                    {summary && (
                      <div>
                        <div className="text-[11px] font-semibold uppercase text-muted-foreground">AI summary</div>
                        <p className="text-xs whitespace-pre-wrap">{summary}</p>
                      </div>
                    )}
                    {aiNotes && (
                      <div>
                        <div className="text-[11px] font-semibold uppercase text-muted-foreground">AI notes</div>
                        <p className="text-xs whitespace-pre-wrap">{aiNotes}</p>
                      </div>
                    )}
                    {transcription ? (
                      <div>
                        <div className="text-[11px] font-semibold uppercase text-muted-foreground">Transcript</div>
                        <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs font-sans leading-relaxed">{transcription}</pre>
                      </div>
                    ) : (
                      !summary && !aiNotes && (
                        <p className="text-xs text-muted-foreground">No transcript or analysis captured for this call.</p>
                      )
                    )}
                    {transcription && !summary && (
                      <p className="text-[11px] text-muted-foreground">No AI summary for this call yet (analysis sweep hasn't filled it).</p>
                    )}
                  </div>
                </details>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
