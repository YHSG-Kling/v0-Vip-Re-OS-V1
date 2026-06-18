import { NextRequest, NextResponse } from "next/server"
import { createClient }              from "@/lib/supabase/server"
import { createServiceClient }       from "@/lib/supabase/service"
import { resolveAgentId }            from "@/lib/kernel/agent-identity"
import { updatePreferencesFromSignal } from "@/lib/behavior-learning/preference-updater"
import { generateBuyerPredictions }    from "@/lib/behavior-learning/prediction-engine"

// Simple in-memory rate limiter: 100 req/min per contactId
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function isRateLimited(contactId: string): boolean {
  const now   = Date.now()
  const entry = rateLimitMap.get(contactId)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(contactId, { count: 1, resetAt: now + 60_000 })
    return false
  }

  if (entry.count >= 100) return true

  entry.count++
  return false
}

export async function POST(req: NextRequest) {
  try {
    // Auth — Supabase JWT
    const supabaseAuth = await createClient()
    const { data: { user }, error: authErr } = await supabaseAuth.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Body per spec: { contactId, signal, property, agentId, brokerageId }
    const body = await req.json()
    const { contactId, signal, property, agentId, brokerageId } = body

    if (!contactId || !signal || !property) {
      return NextResponse.json(
        { error: "contactId, signal, and property are required" },
        { status: 400 }
      )
    }

    // Rate limit: 100 req/min per contact
    if (isRateLimited(contactId)) {
      return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 })
    }

    // Resolve brokerageId — body takes precedence, fallback to user profile
    const svc = createServiceClient()
    let resolvedBrokerageId: string = brokerageId ?? ""
    if (!resolvedBrokerageId) {
      const { data: profile } = await svc
        .from("users")
        .select("brokerage_id")
        .eq("id", user.id)
        .single()
      resolvedBrokerageId = profile?.brokerage_id ?? ""
    }

    // Resolve agent ID - never use user.id for agent_id column
    const resolvedAgentId = agentId ?? await resolveAgentId(svc, user.id)
    if (!resolvedAgentId) {
      return NextResponse.json({ error: "Agent profile not found" }, { status: 403 })
    }

    // Step 2 — call updatePreferencesFromSignal (inserts log + updates prefs)
    const prefResult = await updatePreferencesFromSignal({
      contactId,
      agentId:    resolvedAgentId,
      brokerageId: resolvedBrokerageId,
      signal,
      property,
    })

    if (!prefResult.success) {
      return NextResponse.json({ error: prefResult.error }, { status: 500 })
    }

    // Step 3 — every 10th signal today: trigger generateBuyerPredictions (non-blocking)
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const { count } = await svc
      .from("buyer_behavior_log")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", contactId)
      .eq("brokerage_id", resolvedBrokerageId)
      .gte("created_at", todayStart.toISOString())

    if (typeof count === "number" && count % 10 === 0) {
      // Fire-and-forget — do not await in the hot path
      generateBuyerPredictions({
        contactId,
        agentId:    resolvedAgentId,
        brokerageId: resolvedBrokerageId,
      }).catch(() => {})
    }

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
