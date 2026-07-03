import Link from "next/link"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { normalizeSetupRole, loadSetupReadiness, type ResolvedSetupItem } from "@/lib/onboarding/setup-readiness"

export const dynamic = "force-dynamic"

const ROLE_LABEL: Record<string, string> = {
  agent: "Agent", team_lead: "Team Lead", isa: "Inside Sales (ISA)", tc: "Transaction Coordinator",
  compliance_officer: "Compliance Officer", broker: "Broker", admin: "Admin", superadmin: "Platform Admin",
  vendor: "Vendor", lender: "Lender",
}

const TIER_LABEL: Record<string, string> = {
  solo_agent: "Solo", team: "Team", brokerage: "Brokerage", multi_location: "Multi-location",
}

function ItemRow({ item }: { item: ResolvedSetupItem }) {
  return (
    <Link href={item.href} className="flex items-start gap-3 rounded-lg border px-3 py-2.5 hover:bg-muted/50">
      <span className={"mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold " + (item.done ? "bg-green-500 text-white" : "border-2 border-muted-foreground/30 text-transparent")}>
        ✓
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={"text-sm font-medium " + (item.done ? "text-muted-foreground line-through" : "")}>{item.label}</span>
          {item.required
            ? <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">Required</span>
            : <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">Optional</span>}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{item.why}</p>
      </div>
      {!item.done && <span className="shrink-0 self-center text-xs font-semibold text-indigo-600">Set up →</span>}
    </Link>
  )
}

export default async function GettingStartedPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  const role = normalizeSetupRole(ctx.role)
  const r = await loadSetupReadiness({ userId: ctx.userId, role, brokerageId: ctx.brokerageId, agentId: ctx.agentId })

  const required = r.items.filter((i) => i.required)
  const optional = r.items.filter((i) => !i.required)

  return (
    <div className="container mx-auto max-w-3xl space-y-8 p-6">
      <div>
        <p className="text-sm font-medium text-indigo-600">{ROLE_LABEL[role] ?? role} · {TIER_LABEL[r.tier] ?? r.tier} plan · Getting started</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">Welcome — let's get you set up</h1>
        <p className="mt-2 text-muted-foreground">{r.overview.mission}</p>
      </div>

      {/* Progress */}
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{r.isComplete ? "You're set up 🎉" : "Your setup progress"}</h2>
          <span className="text-2xl font-bold tabular-nums">{r.pct}%</span>
        </div>
        <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-muted">
          <div className={"h-full rounded-full " + (r.isComplete ? "bg-green-500" : "bg-indigo-500")} style={{ width: `${r.pct}%` }} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {r.requiredDone} of {r.requiredTotal} required complete · {r.optionalDone} of {r.optionalTotal} optional complete
        </p>
      </div>

      {/* Platform overview — the "how this works for you" every role was missing */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border bg-card p-5">
          <h3 className="text-sm font-semibold">Your AI team</h3>
          <ul className="mt-2 space-y-1.5">
            {r.overview.aiTeam.map((t) => (
              <li key={t} className="flex items-start gap-2 text-sm text-muted-foreground"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" />{t}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border bg-card p-5">
          <h3 className="text-sm font-semibold">What you can do once you're set up</h3>
          <ul className="mt-2 space-y-1.5">
            {r.overview.youCanNow.map((t) => (
              <li key={t} className="flex items-start gap-2 text-sm text-muted-foreground"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />{t}</li>
            ))}
          </ul>
        </div>
      </div>

      {/* Required checklist */}
      {required.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Required to do your job</h2>
          <div className="space-y-2">{required.map((i) => <ItemRow key={i.key} item={i} />)}</div>
        </section>
      )}

      {/* Optional checklist */}
      {optional.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Optional — sharpen your AI team</h2>
          <div className="space-y-2">{optional.map((i) => <ItemRow key={i.key} item={i} />)}</div>
        </section>
      )}
    </div>
  )
}
