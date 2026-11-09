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
import { requirePlatformCapability } from "@/lib/platform/require-capability"
// The queue reads live in ONE place — the gated actions in
// app/actions/superadmin/connector-healing.ts, which the approve/reject buttons on this page
// already use. This page used to re-inline both SELECTs against the service client, which is
// how the two drifted: the action's "recent" list had no `.neq("status","pending")` and so
// echoed the pending queue back a second time. Same reads, same gate, one definition.
import {
  listPendingProposalsAction,
  listRecentProposalsAction,
} from "@/app/actions/superadmin/connector-healing"
import { getConnectorSpec } from "@/lib/agentic-os/connector-registry"
import { ProposalActions, RevertProposal, ApplyConfigAlternate } from "./proposal-actions"
import { CONNECTOR_REGISTRY } from "@/lib/agentic-os/connector-registry"
import { HEALING_PROPOSAL_STATUSES, type HealingProposalStatus } from "@/lib/kernel/provider-config-healing"
// Wave 150 (lane 150HIAB, owner ruling R9 / C39): the provider stack's activation state and field gaps sit beside the healing
// queue, because activating a provider is the one provider-config change the healer may NEVER make (classifyProviderConfigChange).
import { PROVIDER_ACTIVATION, PROVIDER_FIELD_SCORECARD, activationVerdict, providerFieldMatrix, type ScorecardProvider } from "@/lib/providers/provider-scorecard"
import { simulateProviderPilot } from "@/lib/providers/provider-pilot"
// Wave 151 (lane 151F): the owner's platform acquisition caps (null = stop before spend), the internal acquisition economics and
// each provider's TENANT-connectability (route B) sit beside the provider stack — one console for what the platform may spend,
// what it has spent, and what a tenant may bring of its own.
import { deriveTenantProviderConnectionState } from "@/lib/providers/tenant-provider-connections"
import { loadAcquisitionEconomics } from "@/lib/vendor-governance/acquisition-economics"
import { getAcquisitionCapsAction } from "@/app/actions/superadmin/platform-controls"
import { AcquisitionCapsPanel } from "./acquisition-caps-panel"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import { AlertTriangle, CheckCircle2, XCircle, ExternalLink } from "lucide-react"
import { agoOrDash } from "@/lib/format/dates"

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

// `fmtAgo` — same-body census, round 4 (2026-09-09, lane FC): DELETED,
// byte-identical to lib/format/dates.ts `agoOrDash` (imported above).

// ONE VOCABULARY, EVERY VALUE SHOWN (wave 148, lane 148I — CLAUDE.md §6 + owner ruling 14). Typed over
// lib/kernel/provider-config-healing.ts HEALING_PROPOSAL_STATUSES (the m928 CHECK). TOMBSTONE: `superseded` stood here — no
// writer ever produced it; C25's `reverted` (a configuration version taken back) had no badge.
const STATUS_BADGE: Record<HealingProposalStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending:    { label: "Pending review",  variant: "secondary"   },
  applied:    { label: "Applied",         variant: "default"     },
  rejected:   { label: "Rejected",        variant: "outline"     },
  reverted:   { label: "Reverted",        variant: "outline"     },
}
const HEALING_STATUS_BADGES = HEALING_PROPOSAL_STATUSES.map((s) => ({ value: s, ...STATUS_BADGE[s] }))

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
  const gate = await requirePlatformCapability("providers")
  if (!gate.userId) redirect("/login")
  // Lane 90D (89D P3-11): refuse IN PLACE like the sibling superadmin pages.
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: requires platform providers capability</div>

  // Wave 151 (151F): the owner's acquisition caps + month-to-date platform spend (gated action), and the measured economics
  // over the last 90 days — a refused read is a caveat on the page, never a zero.
  const [capsRes, economics] = await Promise.all([
    getAcquisitionCapsAction(),
    loadAcquisitionEconomics(createServiceClient(), {
      sinceIso: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      duplicateUnitUsd: PROVIDER_FIELD_SCORECARD.find((r) => r.provider === "batchdata" && r.capability === "motivated_seller_list")?.unitUsd ?? null,
    }),
  ])
  // Wave 151 (151D, integrator): the provider monitors registry — every delivery resolves (provider, monitor id) to a row here,
  // so platform staff must be able to READ what is registered, where it posts, which secret NAME signs it and when it last fired.
  const { data: monitorRows, error: monitorsErr } = await createServiceClient()
    .from("provider_monitors")
    .select("id, brokerage_id, market_id, provider, provider_monitor_id, play_key, status, cadence, search, webhook_path, secret_env, deliveries, last_delivery_at, last_delivery_event_id, created_by_user_id, created_at")
    .order("created_at", { ascending: false })
    .limit(200)
  const monitors = (monitorRows ?? []) as Array<{ id: string; brokerage_id: string; market_id: string | null; provider: string; provider_monitor_id: string; play_key: string; status: string; cadence: string | null; search: Record<string, unknown> | null; webhook_path: string; secret_env: string; deliveries: number; last_delivery_at: string | null; last_delivery_event_id: string | null; created_by_user_id: string | null; created_at: string }>

  // Pending queue (the actionable list) + the recent-history strip for context.
  const [pendingRes, recentRes] = await Promise.all([
    listPendingProposalsAction(),
    listRecentProposalsAction(25),
  ])
  const pending = (pendingRes.proposals ?? []) as any[]
  const recent = (recentRes.proposals ?? []) as any[]
  // C25 — every CONFIG-level alternate a connector declares in code (the registry is the declaration survivor).
  // R9 — pure data from the ONE scorecard (no vendor call): who may be called live, what blocks the rest, which fields no
  // active provider documents.
  const providerStack = (Object.keys(PROVIDER_ACTIVATION) as ScorecardProvider[]).map((p) => ({ provider: p, state: PROVIDER_ACTIVATION[p].state, ...activationVerdict(p) }))
  const fieldGaps = providerFieldMatrix().filter((m) => m.gap)
  // C39 — the matched pilot is a DESIGN. After the platform gate above, the design check runs over whatever cohort rows
  // carry evidence.pilot (none until the owner loads one) with EMPTY provider answers — no provider is activated, so
  // nothing is called and nothing is spent. It reports the design's validity and each arm's activation blockers; it can
  // never produce a figure that justifies a purchase.
  const pilot = await simulateProviderPilot(createServiceClient(), { simulate: () => ({ hit: false }), now: new Date() })
  const configAlternates = Object.values(CONNECTOR_REGISTRY).flatMap((spec) => (spec.alternates ?? []).filter((a) => a.level === "config").map((a) => ({ connector: spec.connector, id: a.id, version: a.version ?? null, reason: a.reason })))

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
          <AlertTriangle className="h-4 w-4 text-amber-600" /> Pending review
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
                        <span className="text-xs text-muted-foreground">detected {agoOrDash(p.detected_at)}</span>
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

      {/* ── C25 — DECLARED CONFIGURATION ALTERNATES (wave 148, lane 148I) ─────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Declared configuration alternates</h2>
        <p className="text-sm text-muted-foreground">A connection-method change the adapter already declares in code (an API version, a declared endpoint). Applying one is versioned, tested by the connector&apos;s live probe and reverted at once if the probe fails; anything not declared here is a code change (a change request).</p>
        {configAlternates.length === 0 ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">No configuration alternates are declared right now — every connector speaks its declared version.</CardContent></Card>
        ) : (
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b"><tr><th className="text-left p-3">Connector</th><th className="text-left p-3">Alternate</th><th className="text-left p-3">Why it exists</th><th className="text-left p-3">Apply</th></tr></thead>
                <tbody>
                  {configAlternates.map((a) => (
                    <tr key={`${a.connector}:${a.id}`} className="border-b last:border-0">
                      <td className="p-3">{a.connector}</td>
                      <td className="p-3">{a.id}{a.version ? ` (${a.version})` : ""}</td>
                      <td className="p-3 text-muted-foreground">{a.reason}</td>
                      <td className="p-3"><ApplyConfigAlternate connector={a.connector} alternateId={a.id} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </section>

      {/* ── RECENT HISTORY ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Recent (last 25)</h2>
        {!recent || recent.length === 0 ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">No recent proposals.</CardContent></Card>
        ) : (
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr><th className="text-left p-3">Connector</th><th className="text-left p-3">Kind</th><th className="text-left p-3">Summary</th><th className="text-left p-3">Status</th><th className="text-left p-3">When</th></tr>
                </thead>
                <tbody>
                  {recent.map((r: any) => {
                    const s = HEALING_STATUS_BADGES.find((b) => b.value === r.status) ?? { label: r.status, variant: "outline" as const }
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
                          {/* C25 — an applied configuration version is reversible by a person too (reason required). */}
                          {r.status === "applied" && <RevertProposal proposalId={r.id} />}
                        </td>
                        <td className="p-3 text-xs text-muted-foreground">{agoOrDash(r.applied_at ?? r.detected_at)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </section>

      {/* ── PROVIDER STACK (R9) — activation is a reviewed change, never a heal ─────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Provider stack (owner ruling R9)</h2>
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="p-3">Provider</th><th className="p-3">State</th><th className="p-3">Live calls</th><th className="p-3">What blocks activation</th><th className="p-3">Tenant-owned connection (route B)</th></tr>
              </thead>
              <tbody>
                {providerStack.map((r) => {
                  // Wave 151F: what a TENANT may bring of its own for this provider — derived from the catalogue + activation state,
                  // never from a tenant's row (this is the platform console; no tenant credential is read here).
                  const tenant = deriveTenantProviderConnectionState(r.provider, null)
                  return (
                    <tr key={r.provider} className="border-t">
                      <td className="p-3">{r.provider}</td>
                      <td className="p-3"><Badge variant={r.state === "active" ? "default" : "outline"}>{r.state.replace(/_/g, " ")}</Badge></td>
                      <td className="p-3">{r.mayActivate ? "allowed" : "blocked (offline simulation only)"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{r.blockers.length === 0 ? "nothing" : r.blockers.join("; ")}</td>
                      <td className="p-3 text-xs text-muted-foreground">{tenant.state === "unconfigured" ? "connectable (tenant's own account, tenant-paid)" : tenant.state.replace(/_/g, " ")}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <p className="text-sm text-muted-foreground">
          {fieldGaps.length === 0
            ? "No field gaps — every field has an active, documented provider."
            : `Fields no active provider documents: ${fieldGaps.map((g) => g.field).join(", ")}. Only an activation after the matched pilot closes a gap.`}
        </p>
        <Card>
          <CardContent className="space-y-2 p-4 text-sm">
            <h3 className="font-medium">Matched pilot — design check (simulation, nothing called, nothing spent)</h3>
            <p>
              {pilot.cohort.candidates === 0
                ? "No pilot cohort loaded yet. The 2,400-candidate matched design waits for the owner's no-cost sandbox decision."
                : `${pilot.cohort.candidates} deduplicated candidates (${pilot.cohort.duplicatesDropped} duplicates dropped) · paid calls ${pilot.paidCalls} · live calls ${pilot.liveCalls}`}
            </p>
            {pilot.designProblems.length > 0 ? (
              <ul className="list-disc pl-5 text-xs text-muted-foreground">{pilot.designProblems.slice(0, 6).map((d) => <li key={d}>{d}</li>)}</ul>
            ) : <p className="text-xs text-muted-foreground">The matched design is complete.</p>}
            <ul className="text-xs">
              {pilot.activation.map((a) => <li key={a.provider}>{a.provider}: {a.mayActivate ? "may activate" : `may not activate — ${a.blockers.join("; ")}`}</li>)}
            </ul>
            <p className="text-xs text-muted-foreground">Projection basis: {pilot.projection.basis} — {pilot.projection.monthlyRecords.toLocaleString("en-US")} records a month is arithmetic, never a request size.</p>
          </CardContent>
        </Card>
      </section>

      {/* ── PROVIDER MONITORS (wave 151D) — what is registered at Exa, where it posts, which secret NAME signs it, when it last fired ── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Provider monitors (signed delta webhooks)</h2>
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {monitorsErr ? (
              <p className="p-4 text-sm text-destructive">Monitor registry unreadable: {monitorsErr.message} — deliveries cannot be attributed while this cannot be read.</p>
            ) : monitors.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No provider monitors registered yet. A monitor is created by the acquisition-plays runner for an Exa-hunted play once EXA_API_KEY and EXA_WEBHOOK_SECRET are set by name; nothing is created without them.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr><th className="p-3">Tenant</th><th className="p-3">Play</th><th className="p-3">Status</th><th className="p-3">Cadence</th><th className="p-3">Posts to</th><th className="p-3">Signed by</th><th className="p-3">Deliveries</th><th className="p-3">Last delivery</th><th className="p-3">Created by</th><th className="p-3">Search</th></tr>
                </thead>
                <tbody>
                  {monitors.map((m) => (
                    <tr key={m.id} className="border-t align-top">
                      <td className="p-3 font-mono text-xs">{m.brokerage_id.slice(0, 8)}…{m.market_id ? ` · market ${m.market_id.slice(0, 8)}…` : ""}</td>
                      <td className="p-3">{m.play_key.replace(/_/g, " ")}<div className="text-xs text-muted-foreground">{m.provider} · {m.provider_monitor_id}</div></td>
                      <td className="p-3"><Badge variant={m.status === "active" ? "default" : m.status === "paused" ? "secondary" : "destructive"}>{m.status}</Badge></td>
                      <td className="p-3 text-xs">{m.cadence ?? "—"}</td>
                      <td className="p-3 font-mono text-xs">{m.webhook_path}</td>
                      <td className="p-3 text-xs">{m.secret_env} <span className="text-muted-foreground">(name only{m.deliveries > 0 ? ", sealed per monitor" : ""})</span></td>
                      <td className="p-3 text-xs">{m.deliveries}</td>
                      <td className="p-3 text-xs">{agoOrDash(m.last_delivery_at)}{m.last_delivery_event_id ? <div className="font-mono text-[11px] text-muted-foreground">event {m.last_delivery_event_id.slice(0, 16)}</div> : null}</td>
                      <td className="p-3 font-mono text-xs">{m.created_by_user_id ? `${m.created_by_user_id.slice(0, 8)}…` : "runner"}</td>
                      <td className="p-3 text-[11px] text-muted-foreground max-w-[18rem] truncate" title={JSON.stringify(m.search ?? {})}>{JSON.stringify(m.search ?? {}).slice(0, 80)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── PLATFORM ACQUISITION BUDGET (wave 151F) — the owner's caps; null = stop before spend, no default ─────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Platform acquisition budget (owner caps)</h2>
        <Card>
          <CardContent className="p-4">
            {capsRes.ok
              ? <AcquisitionCapsPanel caps={capsRes.caps} applied={capsRes.applied} spend={capsRes.spend} verdict={capsRes.verdict} />
              : <p className="text-sm text-destructive">Caps unreadable: {capsRes.error} — every platform-paid acquisition pull refuses while this cannot be read.</p>}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 p-4 text-sm">
            <h3 className="font-medium">Internal acquisition economics — last 90 days (measured, never projected)</h3>
            <div className="grid gap-2 sm:grid-cols-3 text-xs">
              <div>Platform-covered acquisition spend: <strong>${economics.platformSpendUsd.toFixed(2)}</strong></div>
              <div>Tenant-paid provider spend (tenants&apos; own accounts): <strong>${economics.tenantSpendUsd.toFixed(2)}</strong></div>
              <div>Ledger rows / API units: {economics.ledgerRows} / {economics.apiUnits}</div>
              <div>Duplicate rows avoided at intake: {economics.duplicateRows}{economics.duplicateAvoidanceSavingsUsd === null ? " (savings unpriced)" : ` (≈ $${economics.duplicateAvoidanceSavingsUsd.toFixed(2)} not re-bought)`}</div>
              <div>Cost per usable raw record: {economics.costPerUsableRecordUsd === null ? "n/a" : `$${economics.costPerUsableRecordUsd.toFixed(4)}`}</div>
              <div>Raw Lead gate yield: {economics.rawLeadGateYield === null ? "n/a" : `${(economics.rawLeadGateYield * 100).toFixed(1)}%`}</div>
              <div>Contact conversion (leads from raw): {economics.contactConversion === null ? "n/a" : `${(economics.contactConversion * 100).toFixed(1)}%`}</div>
              <div>Appointments / accepted relationships / attributed transactions: {economics.appointments ?? "—"} / {economics.acceptedRelationships ?? "—"} / {economics.attributedTransactions ?? "—"}</div>
            </div>
            <ul className="list-disc pl-5 text-[11px] text-muted-foreground">{economics.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
