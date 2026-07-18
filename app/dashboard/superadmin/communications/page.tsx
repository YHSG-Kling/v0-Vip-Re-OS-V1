import { redirect } from "next/navigation"
import Link from "next/link"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { PlatformReceptionPanel } from "../connectors/platform-reception-panel"

export const dynamic = "force-dynamic"

// Platform COMMUNICATIONS console — the spec's staff tool surfaced first-class
// (audit drift #6: the AI phone reception existed but was buried under
// Connectors). This page MOUNTS the existing panel — keep-one, no twin. Gate:
// 'support' (support + admin + superadmin monitor and work the comms lanes);
// number-binding and other config actions stay superadmin-gated at the action
// layer, so support keeps read/assist without config power.
//
// CALL-TRANSCRIPT OVERSIGHT (round 20): the platform line's own calls live in
// platform_reception_calls (call_sid, phone_from/to, status, outcome,
// transcript — plain "Caller:/AI:" text appended turn-by-turn by the turn
// route, prospect_id, started_at/ended_at). That table has NO summary/analysis
// column — so this section shows exactly what exists: the raw transcript,
// expandable per call. Caller numbers are masked to last-4; only the
// platform's own line (TWILIO_PHONE_NUMBER) renders in full.

/** Mask to last-4 unless the number IS the platform's own line. */
function maskNumber(num: string | null | undefined, platformLine: string | null): string {
  if (!num) return "unknown"
  const digits = num.replace(/\D/g, "")
  if (platformLine && digits && digits === platformLine.replace(/\D/g, "")) return num
  return digits.length >= 4 ? `•••${digits.slice(-4)}` : "•••"
}

function fmtDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt || !endedAt) return "—"
  const secs = Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000)
  if (!Number.isFinite(secs) || secs < 0) return "—"
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
}

export default async function PlatformCommunicationsPage() {
  const gate = await requirePlatformCapability("support")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: requires platform support capability</div>

  // Recent platform-line calls — real rows only, newest first.
  const svc = createServiceClient()
  const { data: callRows, error: callsError } = await svc
    .from("platform_reception_calls")
    .select("id, call_sid, phone_from, phone_to, status, outcome, transcript, prospect_id, started_at, ended_at")
    .order("started_at", { ascending: false })
    .limit(30)
  const platformLine = process.env.TWILIO_PHONE_NUMBER ?? null
  const calls = (callRows ?? []) as any[]

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Communications</h1>
          <p className="text-muted-foreground text-sm mt-1">
            The platform's own lines: the AI phone reception (inbound calls answered for the
            platform itself), plus the outbound rails staff reach subscribers and prospects on.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/home" className="rounded-md border px-3 py-1 text-sm">Home</Link>
          <Link href="/dashboard/superadmin/support" className="rounded-md border px-3 py-1 text-sm">Support inbox</Link>
          <Link href="/dashboard/superadmin/growth" className="rounded-md border px-3 py-1 text-sm">Growth outreach</Link>
          <Link href="/dashboard/superadmin/suppression" className="rounded-md border px-3 py-1 text-sm">Suppression list</Link>
          <Link href="/dashboard/superadmin/tenant-calls" className="rounded-md border px-3 py-1 text-sm">Tenant call logs</Link>
        </div>
      </div>

      {/* The platform phone reception — the SAME panel the connectors page mounts. */}
      <PlatformReceptionPanel />

      {/* Call transcripts — what the AI actually said on the platform's own line. */}
      <section className="space-y-2">
        <div>
          <h2 className="text-lg font-semibold">Call transcripts — platform line</h2>
          <p className="text-muted-foreground text-sm">
            Every inbound call the AI reception answered, with the full turn-by-turn transcript.
            Caller numbers are masked to their last 4 digits; only the platform's own number shows in full.
          </p>
        </div>
        {callsError ? (
          <div className="rounded-lg border p-4 text-sm text-red-600">Failed to load platform-line calls: {callsError.message}</div>
        ) : calls.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            No calls on the platform line yet — transcripts appear here once the AI reception answers its first call.
          </div>
        ) : (
          <div className="rounded-lg border divide-y">
            {calls.map((c) => {
              const transcript = typeof c.transcript === "string" ? c.transcript.trim() : ""
              return (
                <details key={c.id} className="group">
                  <summary className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 cursor-pointer text-sm hover:bg-muted/40">
                    <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-700">inbound</span>
                    <span className="font-medium tabular-nums">{maskNumber(c.phone_from, platformLine)}</span>
                    <span className="text-muted-foreground">→ {maskNumber(c.phone_to, platformLine)}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{fmtDuration(c.started_at, c.ended_at)}</span>
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-[11px] font-medium " +
                        (c.outcome === "prospect_captured"
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-slate-100 text-slate-600")
                      }
                    >
                      {c.outcome ?? c.status ?? "in progress"}
                    </span>
                    {c.prospect_id && <span className="text-[11px] text-emerald-700">prospect saved</span>}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {c.started_at ? new Date(c.started_at).toLocaleString() : "—"}
                    </span>
                  </summary>
                  <div className="px-3 pb-3">
                    {transcript ? (
                      <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs font-sans leading-relaxed">{transcript}</pre>
                    ) : (
                      <p className="text-xs text-muted-foreground">No transcript captured for this call.</p>
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
