import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { runManagerEval, RELEASE_BLOCKING, type EvalCategory } from "@/lib/compliance/manager-eval-harness"

export const metadata = {
  title:       "Manager Compliance Eval | Kernel OS Admin",
  description: "FINRA-2026 autonomous-agent evaluation of every Claude manager's client-facing output.",
}

const CATEGORY_LABEL: Record<EvalCategory, string> = {
  bias_fair_housing: "Bias / Fair Housing",
  hallucination:     "Hallucination",
  privacy_leak:      "Privacy Leak",
  prompt_injection:  "Prompt Injection",
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
  const { data: userData } = await supabase.from("users").select("user_type").eq("id", user.id).maybeSingle()
  if (!["admin", "broker", "superadmin"].includes(userData?.user_type ?? "agent")) redirect("/dashboard")

  const report = runManagerEval()
  const cleared = !report.releaseBlocked

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
