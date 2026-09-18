import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { runManagerEval, RELEASE_BLOCKING, type EvalCategory } from "@/lib/compliance/manager-eval-harness"
import {
  buildManagerGovernanceScorecard,
  summarizeGovernance,
  type EvalDimension,
} from "@/lib/compliance/manager-governance-scorecard"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { evalBrokerageOutbound, evalBrokerageDirectorReels } from "@/lib/agents/manager-outbound-eval"
import { createServiceClient } from "@/lib/supabase/service"

export const metadata = {
  title:       "Manager Compliance Eval | Kernel OS Admin",
  description: "FINRA-2026 autonomous-agent evaluation of every Claude manager's client-facing output.",
}

const DIMENSION_LABEL: Record<EvalDimension, string> = {
  hallucination:       "Hallucination",
  bias_fair_housing:   "Bias / Fair Housing",
  scope_creep:         "Scope Creep",
  reward_misalignment: "Reward Misalignment",
  prompt_injection:    "Prompt Injection",
  privacy_leakage:     "Privacy Leakage",
}

const CATEGORY_LABEL: Record<EvalCategory, string> = {
  bias_fair_housing: "Bias / Fair Housing",
  hallucination:     "Hallucination",
  privacy_leak:      "Privacy Leak",
  prompt_injection:  "Prompt Injection",
  legitimate_use:    "Real-Estate Legitimacy",
  comp_claim:        "Recruiting Comp-Claim",
}

/**
 * Manager Compliance Eval — runs the autonomous-manager evaluation harness (FINRA
 * 2026 framework) on demand and renders the scorecard. Every case exercises a REAL
 * deterministic governance guard against adversarial input — no mocks. This is the
 * evidence a brokerage's compliance officer / attorney can produce on demand.
 * Auth-gated (admin/broker/superadmin). Re-run by refreshing.
 */
export default async function ComplianceEvalPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: userData } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!isAdminOrBroker({ user_type: userData?.user_type ?? "agent" })) redirect("/dashboard")

  const report = runManagerEval()
  const cleared = !report.releaseBlocked
  // THE LIVE HALF (wired 2026-09-03): the same read-only audits the weekly cron
  // runs, scoped to the SESSION's brokerage (§4) — the managers' proposed client
  // messages and the Director-staged reels, scored on the autonomous-agent
  // dimensions. Gate first (above), then the service client.
  const brokerageId = (userData as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  const svc = createServiceClient()
  const outbound = brokerageId ? await evalBrokerageOutbound(brokerageId, svc) : null
  const reels = brokerageId ? await evalBrokerageDirectorReels(brokerageId, svc) : null
  // Structural companion to the behavioral eval above: which manager is authorized
  // for what, and the named mechanism enforcing each dimension.
  const cards = buildManagerGovernanceScorecard()
  const gov = summarizeGovernance(cards)

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <header>
        <h1 className="text-2xl font-bold">Manager Compliance Eval</h1>
        <p className="text-sm text-muted-foreground">
          FINRA-2026 autonomous-agent framework · Fair Housing Act · EU AI Act Art. 15 · NIST AI RMF —
          every case runs a real governance guard against adversarial input. Generated {new Date(report.generatedAt).toLocaleString()}.
        </p>
      </header>

      {/* Release banner */}
      <Card className={`p-5 ${cleared ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
        <div className="flex items-center justify-between">
          <div>
            <div className={`text-xl font-bold ${cleared ? "text-green-800" : "text-red-800"}`}>
              {cleared ? "Release CLEARED ✅" : "Release BLOCKED 🔒"}
            </div>
            <div className="text-sm text-muted-foreground mt-1">
              {report.passed}/{report.total} checks passed across {Object.keys(report.byCategory).length} categories
            </div>
          </div>
          <div className="text-3xl font-bold">{Math.round((report.passed / report.total) * 100)}%</div>
        </div>
      </Card>

      {/* Category breakdown */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">By category</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {(Object.entries(report.byCategory) as [EvalCategory, { total: number; passed: number; failed: number }][]).map(([cat, b]) => (
            <Card key={cat} className="p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">{CATEGORY_LABEL[cat] ?? cat}</div>
              <div className={`text-2xl font-bold ${b.failed === 0 ? "text-green-700" : "text-red-700"}`}>{b.passed}/{b.total}</div>
              {RELEASE_BLOCKING.has(cat) && <Badge className="bg-slate-900 text-white mt-1">release-blocking</Badge>}
            </Card>
          ))}
        </div>
      </section>

      {/* ── Live audits: what the managers are proposing RIGHT NOW ────────────── */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Live autonomous egress — this brokerage</h2>
        <p className="text-sm text-muted-foreground">
          Read-only. The managers&apos; proposed client messages and the Director&apos;s staged reels, scored on the
          same dimensions. Nothing here is sent or rendered until a person approves it.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Proposed manager messages</div>
            {!outbound ? (
              <div className="text-sm text-muted-foreground mt-1">No brokerage on this session — not evaluated.</div>
            ) : outbound.unreadable ? (
              <div className="text-sm text-red-700 mt-1">Could not read the proposal queue: {outbound.unreadable}. Not clean — unchecked.</div>
            ) : (
              <>
                <div className={`text-2xl font-bold ${outbound.flagged === 0 ? "text-green-700" : "text-red-700"}`}>{outbound.clean}/{outbound.evaluated} clean</div>
                {outbound.findings.slice(0, 6).map((f, i) => (
                  <div key={`${f.messageId}-${i}`} className="text-xs text-muted-foreground mt-1">
                    <Badge className="bg-slate-100 text-slate-700 mr-1">{f.dimension}</Badge>{f.managerKind}: {f.detail}
                  </div>
                ))}
              </>
            )}
          </Card>
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Director-staged reels</div>
            {!reels ? (
              <div className="text-sm text-muted-foreground mt-1">No brokerage on this session — not evaluated.</div>
            ) : reels.unreadable ? (
              <div className="text-sm text-red-700 mt-1">Could not read the staged reels: {reels.unreadable}. Not clean — unchecked.</div>
            ) : !reels.report ? (
              <div className="text-sm text-muted-foreground mt-1">No Director-staged reels to evaluate.</div>
            ) : (
              <>
                <div className={`text-2xl font-bold ${reels.report.pass ? "text-green-700" : "text-red-700"}`}>
                  {reels.evaluated} reel(s) — {reels.report.pass ? "all dimensions pass" : "findings"}
                </div>
                {([
                  ["Hallucination", reels.report.hallucination],
                  ["Fair Housing", reels.report.fairHousing],
                  ["Scope creep", reels.report.scopeCreep],
                  ["Reward alignment", reels.report.rewardAlignment],
                ] as const).map(([label, d]) => (
                  <div key={label} className="text-xs mt-1">
                    <Badge className={d.pass ? "bg-green-100 text-green-800 mr-1" : "bg-red-100 text-red-800 mr-1"}>{d.pass ? "PASS" : "FAIL"}</Badge>
                    {label}{!d.pass && <span className="text-muted-foreground"> — {d.violations.slice(0, 2).join("; ")}</span>}
                  </div>
                ))}
                {reels.ungroundedRows > 0 && (
                  <div className="text-[11px] text-muted-foreground mt-1">{reels.ungroundedRows} reel(s) staged before facts were stamped — grounded on superlatives only.</div>
                )}
              </>
            )}
          </Card>
        </div>
      </section>

      {/* ── Governance scorecard: the STRUCTURAL half of the artifact ────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Manager governance scorecard</h2>
          <p className="text-sm text-muted-foreground">
            Each manager&apos;s authority scope mapped to the supervisory dimensions it must satisfy, and the
            named mechanism in this codebase that enforces each one. The eval above proves behaviour;
            this proves <em>authority is bounded</em>.
          </p>
        </div>

        <Card className={`p-5 ${gov.gaps === 0 ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className={`text-xl font-bold ${gov.gaps === 0 ? "text-green-800" : "text-amber-800"}`}>
                {gov.governed}/{gov.totalManagers} managers fully governed
              </div>
              <div className="text-sm text-muted-foreground mt-1">
                {gov.gaps === 0
                  ? "Every applicable dimension is enforced for every manager."
                  : `${gov.gaps} manager(s) have at least one unenforced dimension.`}
              </div>
            </div>
            <div className="text-right text-xs text-muted-foreground max-w-xs">
              <div><strong>Behaviourally red-teamed:</strong> {gov.behaviorallyVerified.map((d) => DIMENSION_LABEL[d]).join(", ")}</div>
              <div className="mt-1">
                <strong>Awaiting behavioural eval:</strong>{" "}
                {gov.behavioralEvalPending.length === 0
                  ? "none — the rest are structural invariants with their own guards"
                  : gov.behavioralEvalPending.map((d) => DIMENSION_LABEL[d]).join(", ")}
              </div>
            </div>
          </div>
        </Card>

        <div className="space-y-2">
          {cards.map((c) => (
            <Card key={c.manager} className="p-4">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{c.label}</span>
                    <Badge className={c.verdict === "governed" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}>
                      {c.verdict === "governed" ? "GOVERNED" : "GAPS"}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {c.ownedTables} owned tables · {c.runsCrons} scheduled jobs · {c.consumesSignals.length} catalogued signals
                    {c.burnDomains.length > 0 && <> · burn domains: {c.burnDomains.join(", ")}</>}
                  </div>
                </div>
              </div>

              <div className="mt-3 grid gap-2">
                {c.dimensions.map((d) => (
                  <div key={d.dimension} className="text-xs border-l-2 pl-3 border-slate-200">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge
                        className={
                          d.status === "enforced"
                            ? "bg-green-100 text-green-800"
                            : d.status === "gap"
                              ? "bg-red-100 text-red-800"
                              : "bg-slate-100 text-slate-600"
                        }
                      >
                        {d.status}
                      </Badge>
                      <span className="font-medium">{DIMENSION_LABEL[d.dimension] ?? d.dimension}</span>
                      <Badge className="bg-slate-100 text-slate-700">{d.enforcementType}</Badge>
                      {d.releaseBlocking && <Badge className="bg-slate-900 text-white">release-blocking</Badge>}
                    </div>
                    <div className="text-muted-foreground mt-0.5">Anchor: {d.supervisoryAnchor}</div>
                    <div className="text-muted-foreground">Enforced by: {d.enforcedBy.join("; ")}</div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* Case detail */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Cases</h2>
        <div className="space-y-2">
          {report.cases.map((c) => (
            <Card key={c.id} className="p-3 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className={c.pass ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>{c.pass ? "PASS" : "FAIL"}</Badge>
                  <Badge className="bg-slate-100 text-slate-700">{CATEGORY_LABEL[c.category] ?? c.category}</Badge>
                  <span className="text-sm font-medium">{c.id}</span>
                  <span className="text-xs text-muted-foreground">{c.manager}</span>
                </div>
                <div className="text-sm mt-1">{c.detail}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">Anchor: {c.anchor}</div>
              </div>
              <Badge className="bg-slate-100 text-slate-700 shrink-0">{c.severity}</Badge>
            </Card>
          ))}
        </div>
      </section>
    </div>
  )
}
