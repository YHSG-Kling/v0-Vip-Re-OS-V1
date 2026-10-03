"use server"

// app/actions/phone-port-in.ts
// ─────────────────────────────────────────────────────────────────────────────
// PICK OR PORT — the PORT door (wave 83D; owner: "the person picks a number or
// ports and auto business listing approval."). The PICK door already exists
// (app/actions/phone-provisioning.ts suggestLocalNumbersAction +
// purchaseBrokerageNumberAction). Every export is a public HTTP endpoint
// (CLAUDE.md §4), async, gated FIRST on the brokerage finance-admin roster (a
// port obligates the brokerage exactly like a purchase), tenant from the
// SESSION — never from the form. The core is lib/voice/number-port-in.ts.

import { createServiceClient } from "@/lib/supabase/service"
import { resolveActingContext, resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { checkNumbersPortable, submitPortIn, loadPortIns, describePortIn, defaultPortDate, portInPrefillFromRegistration, fillPortInFromRegistration, type PortabilityVerdict, type PortInInput, type PortPhase, type PortInRegistrationPrefill } from "@/lib/voice/number-port-in"
// Wave 84D: the LOA details are PULLED from the Business registration branding
// setting through the same derivation carrier registration files from.
import { resolveA2pProfile } from "@/lib/voice/a2p-registration"

async function requirePortCtx(mode: "read" | "write"): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  const ctx = mode === "write" ? await resolveWriteContextForTenant() : await resolveActingContext()
  if (!ctx.ok || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!isBrokerageFinanceAdmin({ user_type: ctx.userType })) return { ok: false, error: "Only broker / admin can port numbers" }
  return { ok: true, brokerageId: ctx.brokerageId }
}

export interface PortInStatusView {
  sid: string
  numbers: Array<{ phone: string; status: string; landed: boolean }>
  phase: PortPhase
  headline: string
  nextStep: string
  signatureUrl: string | null
  targetDate: string | null
  submittedAt: string
  lastPolledAt: string | null
}

/** READ — the tenant's port requests with the one next step each, plus the
 *  LOA details already on file (Business registration — never the EIN). */
export async function getPortInStatusAction(): Promise<{ ok: true; ports: PortInStatusView[]; defaultTargetDate: string; prefill: Partial<PortInRegistrationPrefill> } | { ok: false; error: string }> {
  const auth = await requirePortCtx("read")
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const [cur, reg] = await Promise.all([loadPortIns(svc, auth.brokerageId), resolveA2pProfile(svc, auth.brokerageId)])
  if (!cur.ok) return { ok: false, error: cur.error }
  return {
    ok: true,
    defaultTargetDate: defaultPortDate(new Date()),
    prefill: portInPrefillFromRegistration(reg.draft),
    ports: cur.records.map((r) => {
      const d = describePortIn(r)
      return { sid: r.sid, numbers: r.numbers.map((n) => ({ phone: n.phone, status: n.status, landed: n.landed })), phase: d.phase, headline: d.headline, nextStep: d.nextStep, signatureUrl: r.signatureUrl, targetDate: r.targetDate, submittedAt: r.submittedAt, lastPolledAt: r.lastPolledAt }
    }),
  }
}

/** READ — can these numbers be ported, and does the carrier need PIN + account #? */
export async function checkPortabilityAction(input: { phoneNumbers: string[] }): Promise<{ ok: true; verdicts: PortabilityVerdict[] } | { ok: false; error: string }> {
  const auth = await requirePortCtx("read")
  if (!auth.ok) return auth
  const svc = createServiceClient()
  return checkNumbersPortable(svc, auth.brokerageId, Array.isArray(input?.phoneNumbers) ? input.phoneNumbers.slice(0, 20) : [])
}

/** WRITE — file the port (utility bill + LOA details). FormData so the bill
 *  travels as a file; every field is re-validated server-side. */
export async function submitPortInAction(form: FormData): Promise<{ ok: true; port: PortInStatusView } | { ok: false; error: string; missing?: string[] }> {
  const auth = await requirePortCtx("write")
  if (!auth.ok) return auth
  const svc = createServiceClient()

  const str = (k: string) => { const v = form.get(k); return typeof v === "string" ? v : "" }
  const phoneNumbers = str("phoneNumbers").split(/[\s,;]+/).filter(Boolean)
  const pins: Record<string, string> = {}
  for (const [k, v] of form.entries()) {
    if (k.startsWith("pin:") && typeof v === "string" && v.trim()) {
      const d = k.slice(4).replace(/\D/g, "")
      pins[d.length === 10 ? `+1${d}` : `+${d}`] = v.trim()
    }
  }
  const typed: Partial<PortInInput> = {
    phoneNumbers, pins,
    customerName: str("customerName"), customerType: str("customerType") === "Individual" ? "Individual" : "Business",
    accountNumber: str("accountNumber"), accountTelephoneNumber: str("accountTelephoneNumber"),
    authorizedRepresentative: str("authorizedRepresentative"), authorizedRepresentativeEmail: str("authorizedRepresentativeEmail"),
    street: str("street"), street2: str("street2"), city: str("city"), state: str("state"), zip: str("zip"),
    targetPortInDate: str("targetPortInDate"),
  }
  // Wave 84D: typed wins (the LOA must match the losing carrier's record);
  // every blank is pulled from the Business registration branding setting.
  const input = fillPortInFromRegistration(typed, portInPrefillFromRegistration((await resolveA2pProfile(svc, auth.brokerageId)).draft))

  // Optional: the agent the number lands on — tenant-checked here, never trusted.
  let agentUserId: string | null = null
  const agentId = str("agentId") || null
  if (agentId) {
    const { data: agent, error: agentErr } = await svc.from("agents").select("user_id, brokerage_id").eq("id", agentId).maybeSingle()
    if (agentErr) return { ok: false, error: "Could not verify the agent — nothing was filed" }
    if (!agent?.user_id || (agent as any).brokerage_id !== auth.brokerageId) return { ok: false, error: "Agent not found on this brokerage — nothing was filed" }
    agentUserId = agent.user_id
  }

  const file = form.get("utilityBill")
  const bill = file && typeof file === "object" && "arrayBuffer" in file && (file as File).size > 0
    ? { name: (file as File).name || "utility-bill.pdf", type: (file as File).type || "application/pdf", bytes: await (file as File).arrayBuffer() }
    : null

  const r = await submitPortIn(svc, auth.brokerageId, input, bill, { agentUserId, agentId })
  if (!r.ok) return { ok: false, error: r.error, missing: r.missing }
  return {
    ok: true,
    port: { sid: r.record.sid, numbers: r.record.numbers.map((n) => ({ phone: n.phone, status: n.status, landed: n.landed })), phase: r.status.phase, headline: r.status.headline, nextStep: r.status.nextStep, signatureUrl: r.record.signatureUrl, targetDate: r.record.targetDate, submittedAt: r.record.submittedAt, lastPolledAt: r.record.lastPolledAt },
  }
}
