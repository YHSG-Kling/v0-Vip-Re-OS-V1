import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { verifyCeSignature, type CeCompletionPayload } from "@/lib/education/ce-provider"
import { recordCeCompletionFromProvider } from "@/app/actions/ce-provider"

/**
 * ACCREDITED CE PROVIDER WEBHOOK — the connected provider reports a completed accredited course; the app
 * records the credit into agent_ce_completions and bumps the agent's CE hours so license-readiness sees it.
 * Signature-verified (HMAC-SHA256 with CE_PROVIDER_WEBHOOK_SECRET). The platform never invents CE credit —
 * it only records what an accredited provider verifiably reports.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CE_PROVIDER_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ error: "CE provider webhook secret not configured" }, { status: 500 })

  const raw = await req.text()
  const sig = req.headers.get("x-ce-signature")
  if (!verifyCeSignature(raw, sig, secret)) {
    return NextResponse.json({ error: "signature verification failed" }, { status: 400 })
  }

  let payload: CeCompletionPayload
  try { payload = JSON.parse(raw) } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }) }

  const agentRef = payload.agent_id ?? payload.agent_external_id
  if (!agentRef || !payload.course_name || !payload.completed_on) {
    return NextResponse.json({ error: "missing agent ref / course / completion date" }, { status: 400 })
  }

  try {
    const svc = createServiceClient()
    const { data: agent } = await svc.from("agents").select("id, brokerage_id").eq("id", agentRef).maybeSingle()
    if (!agent) return NextResponse.json({ ok: true, ignored: true, reason: "unknown agent" })
    const a = agent as { id: string; brokerage_id: string | null }

    // Provider name from the brokerage's connected config (falls back to the payload-declared provider).
    let providerName = "Accredited CE Provider"
    if (a.brokerage_id) {
      const { data: bs } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", a.brokerage_id).maybeSingle()
      const cfg = (((bs as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as any).ce_provider
      if (cfg?.name) providerName = cfg.name
    }

    const result = await recordCeCompletionFromProvider(payload, { agentId: a.id, brokerageId: a.brokerage_id, providerName })
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? String(err) }, { status: 500 })
  }
}
