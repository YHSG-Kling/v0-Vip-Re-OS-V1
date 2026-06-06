// app/dashboard/superadmin/connector-healing/page.tsx
// Superadmin / support queue for AI-generated connector-healing proposals — the queue grows
// whenever connector-health (or any future trigger) detects a vendor connector failing (4xx/5xx,
// shape drift, auth failure). Each row is a proposed fix grounded in fresh vendor docs the healer
// pulled via Exa; an admin can approve (records the human go-ahead and is the gate before any
// auto-applier rolls out the change) or reject. Raw leads depend on these connectors continuing to
// work, so a stale queue == stalled lead acquisition — this is the surface for support to keep it
// healthy.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import { getConnectorSpec } from "@/lib/agentic-os/connector-registry"
import { ProposalActions } from "./proposal-actions"
import { redirect } from "next/navigation"
import { AlertTriangle, CheckCircle2, XCircle, ExternalLink } from "lucide-react"

export const dynamic = "force-dynamic"

// LLM-produced or doc-search URLs land in docs_evidence verbatim — sanitize to http/https before
// rendering as a clickable href so a prompt-injected `javascript:` URL can't fire same-origin code
// when a superadmin clicks. React does NOT block these schemes natively (warning only).
function safeHref(url: unknown): string | null {
  if (typeof url !== "string") return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null
  } catch { return null }
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "—"
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.round(ms / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending:    { label: "Pending review",  variant: "secondary"   },
  applied:    { label: "Applied",         variant: "default"     },
  rejected:   { label: "Rejected",        variant: "outline"     },
  superseded: { label: "Superseded",      variant: "outline"     },
}

const KIND_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  endpoint_change:   { label: "Endpoint change",   variant: "destructive" },
  param_rename:      { label: "Param rename",      variant: "secondary"   },
  auth_change:       { label: "Auth change",       variant: "destructive" },
  shape_update:      { label: "Shape update",      variant: "secondary"   },
  retry_other_actor: { label: "Retry other actor", variant: "default"     },
  rotate_key:        { label: "Rotate key",        variant: "default"     },
  no_evidence:       { label: "No evidence yet",   variant: "outline"     },
}

export default async function ConnectorHealingPage() {
  // Auth gate — same pattern as the existing superadmin/connectors page.
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) redirect("/login")
  const svc = createServiceClient()
  const { data: profile } = await svc
    .from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const allowed = profile?.user_type === "superadmin" || isPlatformStaff(profile?.platform_role)
  if (!allowed) redirect("/dashboard")

  // Pending queue (the actionable list) + the recent-history strip for context.
  const [{ data: pending }, { data: recent }] = await Promise.all([
    svc.from("connector_healing_proposals")
      .select("id, connector, detected_at, failure_signature, failure_sample, proposal_kind, proposal_summary, proposal_payload, docs_evidence, confidence, notes")
      .eq("status", "pending")
      .order("detected_at", { ascending: false })
      .limit(200),
    svc.from("connector_healing_proposals")
      .select("id, connector, detected_at, proposal_kind, proposal_summary, confidence, status, applied_at, applied_by")
      .neq("status", "pending")
      .order("detected_at", { ascending: false })
      .limit(25),
  ])

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">AI Connector Healing</h1>
          <p className="text-sm text-muted-foreground">
            Proposed fixes generated when a vendor connector starts failing — grounded in fresh docs
            the healer fetched from the provider's site / GitHub. Raw leads depend on these
            connectors, so the queue must stay short.
          </p>
        </div>
        <Badge variant={pending && pending.length > 0 ? "destructive" : "outline"}>
          {pending?.length ?? 0} pending
        </Badge>
      </header>

      {/* ── PENDING QUEUE ─────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" /> Pending review
        </h2>
        {(!pending || pending.length === 0) ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">No pending proposals — every connector is currently in a healthy state, or no failure has been detected recently.</CardContent></Card>
        ) : (
          <div className="grid gap-3">
            {pending.map((p: any) => {
              const spec = getConnectorSpec(p.connector)
              const kind = KIND_BADGE[p.proposal_kind] ?? { label: p.proposal_kind, variant: "outline" as const }
              const docs = Array.isArray(p.docs_evidence) ? p.docs_evidence : []
              return (
                <Card key={p.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <CardTitle className="text-base font-medium">{p.connector}</CardTitle>
                        {spec?.category && <Badge variant="outline">{spec.category}</Badge>}
                        <Badge variant={kind.variant}>{kind.label}</Badge>
                        <Badge variant="outline">
                          confidence {Math.round((Number(p.confidence) || 0) * 100)}%
                        </Badge>
                        <span className="text-xs text-muted-foreground">detected {fmtAgo(p.detected_at)}</span>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm">{p.proposal_summary}</p>
                    <div className="text-xs text-muted-foreground space-y-1">
                      <div><strong>Failure signature:</strong> <code className="text-xs">{p.failure_signature}</code></div>
                      {safeHref(spec?.docsUrl) && (
                        <div className="flex items-center gap-2">
                          <strong>Vendor docs:</strong>
                          <a className="underline inline-flex items-center gap-1" href={safeHref(spec?.docsUrl)!} target="_blank" rel="noreferrer">
                            {spec?.docsUrl} <ExternalLink className="h-3 w-3" />
                          </a>
                          {safeHref(spec?.githubUrl) && (
                            <a className="underline inline-flex items-center gap-1" href={safeHref(spec?.githubUrl)!} target="_blank" rel="noreferrer">
                              GitHub <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      )}
                    </div>

                    {p.proposal_payload && Object.keys(p.proposal_payload).length > 0 && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">Proposed change diff</summary>
                        <pre className="mt-2 bg-muted/50 p-3 rounded overflow-auto max-h-48">
                          {JSON.stringify(p.proposal_payload, null, 2)}
                        </pre>
                      </details>
                    )}

                    {docs.length > 0 && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">Docs evidence ({docs.length})</summary>
                        <ul className="mt-2 space-y-2">
                          {docs.map((d: any, i: number) => {
                            const href = safeHref(d?.url)
                            return (
                              <li key={i} className="border-l-2 pl-2">
                                {href
                                  ? <a className="underline text-xs" href={href} target="_blank" rel="noreferrer">{href}</a>
                                  : <span className="text-xs text-muted-foreground line-clamp-1">{String(d?.url ?? "")} (blocked: non-http URL)</span>}
                                <p className="text-xs text-muted-foreground line-clamp-3">{String(d?.snippet ?? "")}</p>
                              </li>
                            )
                          })}
                        </ul>
                      </details>
                    )}

                    <ProposalActions proposalId={p.id} />
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      {/* ── RECENT HISTORY ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Recent (last 25)</h2>
        {!recent || recent.length === 0 ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">No recent proposals.</CardContent></Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr><th className="text-left p-3">Connector</th><th className="text-left p-3">Kind</th><th className="text-left p-3">Summary</th><th className="text-left p-3">Status</th><th className="text-left p-3">When</th></tr>
                </thead>
                <tbody>
                  {recent.map((r: any) => {
                    const s = STATUS_BADGE[r.status] ?? { label: r.status, variant: "outline" as const }
                    const k = KIND_BADGE[r.proposal_kind] ?? { label: r.proposal_kind, variant: "outline" as const }
                    return (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="p-3">{r.connector}</td>
                        <td className="p-3"><Badge variant={k.variant}>{k.label}</Badge></td>
                        <td className="p-3 text-muted-foreground line-clamp-1 max-w-[480px]">{r.proposal_summary}</td>
                        <td className="p-3">
                          <span className="inline-flex items-center gap-1">
                            {r.status === "applied"  && <CheckCircle2 className="h-3 w-3 text-emerald-600" />}
                            {r.status === "rejected" && <XCircle      className="h-3 w-3 text-red-600" />}
                            <Badge variant={s.variant}>{s.label}</Badge>
                          </span>
                        </td>
                        <td className="p-3 text-xs text-muted-foreground">{fmtAgo(r.applied_at ?? r.detected_at)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  )
}
