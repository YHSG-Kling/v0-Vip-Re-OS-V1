"use client"

import { useMemo, useState, useTransition } from "react"
import { createAgentReferralAction } from "@/app/actions/referrals/agent-referral-actions"
import type { AgentDirectoryEntry, OutboundReferral } from "@/lib/referrals/agent-referral"

type Contact = { id: string; name: string }

export function ReferralNetworkClient({
  agents, outbound, earnedTotal, contacts,
}: {
  agents: AgentDirectoryEntry[]
  outbound: OutboundReferral[]
  earnedTotal: number
  contacts: Contact[]
}) {
  const [pending, startTransition] = useTransition()
  const [receivingAgentId, setReceivingAgentId] = useState("")
  const [contactId, setContactId] = useState("")
  const [feePct, setFeePct] = useState<number | "">("")
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // Group the directory by state → city for the map/directory view.
  const byState = useMemo(() => {
    const m = new Map<string, AgentDirectoryEntry[]>()
    for (const a of agents) {
      const k = a.state || "—"
      const arr = m.get(k) ?? []; arr.push(a); m.set(k, arr)
    }
    return Array.from(m.entries()).sort((x, y) => x[0].localeCompare(y[0]))
  }, [agents])

  function submit() {
    if (!receivingAgentId || !contactId) { setMsg({ ok: false, text: "Pick a client and an agent to refer to." }); return }
    if (typeof feePct !== "number" || !(feePct > 0) || feePct > 100) { setMsg({ ok: false, text: "Enter the agreed referral fee (1-100%)." }); return }
    setMsg(null)
    startTransition(async () => {
      const r = await createAgentReferralAction({ receivingAgentId, contactId, feePct })
      setMsg(r.ok ? { ok: true, text: "Referral sent — you'll earn your fee when it closes." } : { ok: false, text: r.error ?? "Failed" })
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Referral network</h1>
          <p className="text-muted-foreground mt-1">Refer a relocating client to an agent elsewhere in your brokerage — and earn a fee when it closes.</p>
        </div>
        <div className="rounded-lg border border-green-200 bg-green-50/40 p-3 text-right">
          <div className="text-xs text-muted-foreground">Referral income earned</div>
          <div className="text-2xl font-bold text-green-700">${Math.round(earnedTotal).toLocaleString()}</div>
        </div>
      </div>

      {/* New referral */}
      <div className="rounded-lg border p-4 space-y-3">
        <h2 className="text-lg font-semibold">Refer a client</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <select className="border rounded-md p-2 text-sm" value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">Your client…</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="border rounded-md p-2 text-sm md:col-span-2" value={receivingAgentId} onChange={(e) => setReceivingAgentId(e.target.value)}>
            <option value="">Refer to…</option>
            {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.name}{a.city ? ` — ${a.city}, ${a.state ?? ""}` : ""}</option>)}
          </select>
          <div className="flex items-center gap-2">
            <input type="number" min={1} max={100} placeholder="fee" className="border rounded-md p-2 text-sm w-20" value={feePct}
              onChange={(e) => setFeePct(e.target.value === "" ? "" : Number(e.target.value))} />
            <span className="text-sm text-muted-foreground">% (agreed)</span>
          </div>
        </div>
        <button onClick={submit} disabled={pending} className="rounded-md bg-slate-900 text-white px-4 py-2 text-sm disabled:opacity-50">
          {pending ? "Sending…" : "Send referral"}
        </button>
        {msg && <p className={"text-sm " + (msg.ok ? "text-green-700" : "text-red-600")}>{msg.text}</p>}
      </div>

      {/* Directory grouped by location (the map's data view) */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Agents across your brokerage</h2>
        {byState.map(([state, list]) => (
          <div key={state} className="rounded-lg border p-3">
            <div className="text-sm font-semibold text-muted-foreground mb-2">{state}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {list.map((a) => (
                <div key={a.agentId} className="rounded-md border px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{a.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{[a.city, a.locationName].filter(Boolean).join(" · ") || "—"}</div>
                  </div>
                  <button className="text-xs text-blue-700 hover:underline shrink-0" onClick={() => setReceivingAgentId(a.agentId)}>Refer →</button>
                </div>
              ))}
            </div>
          </div>
        ))}
        {agents.length === 0 && <p className="text-sm text-muted-foreground">No other agents in your brokerage to refer to yet — this network fills in as your team or brokerage adds agents across locations.</p>}
      </div>

      {/* My outbound referrals */}
      {outbound.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Your referrals</h2>
          {outbound.map((r) => (
            <div key={r.id} className="rounded-md border px-3 py-2 flex items-center justify-between gap-3 text-sm">
              <span className="truncate">{r.contactName ?? "A client"} → {r.receivingAgentName ?? "an agent"}</span>
              <div className="flex items-center gap-2 shrink-0">
                {r.feePct != null && <span className="text-xs text-muted-foreground">{r.feePct}% fee</span>}
                <span className={"text-xs font-medium " + (r.status === "closed" ? "text-green-700" : "text-amber-700")}>{r.status}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
