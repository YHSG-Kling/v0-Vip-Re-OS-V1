import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { mayUseAndAfford } from "@/lib/billing/billing-access"
import { FORM_WIZARD_PURPOSES } from "@/lib/forms/form-wizard-sequence"
import { INTAKE_NOTES_MAX_CHARS, suggestIntakeAnswers } from "@/lib/forms/intake-from-notes"

/**
 * POST /api/form-wizard/intake-notes  { purpose: "listing" | "offer", notes: string, answered?: string[] }
 *
 * The FormWizard coach LISTENS (wave 143, lane 143B; lib/forms/intake-from-notes.ts): the agent describes the
 * deal in their own words and gets SUGGESTED answers to the intake questions, each with the quote it rests on,
 * to confirm. Nothing is applied here and nothing is written to a record — the response is a list of proposals
 * the wizard shows and the agent accepts.
 *
 * TENANT FROM THE SESSION (CLAUDE.md §4). The body names no tenant; the brokerage is the signed-in user's own
 * row. ENTITLEMENT BEFORE THE PAID CALL (fail closed): `mayUseAndAfford("ai.generate")` is asked first with an
 * estimate of the tokens, exactly as the business-card scanner does; a refusal returns its message and no model
 * is called. The model spend itself is booked by generateObjectRouted (ai_tool_usage) to the session tenant.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })

  const { data: me, error: meErr } = await supabase.from("users").select("brokerage_id, user_type, platform_role").eq("id", user.id).maybeSingle()
  if (meErr) return NextResponse.json({ error: `Could not read your account: ${meErr.message}` }, { status: 500 })
  const brokerageId = (me?.brokerage_id as string | null) ?? null
  if (!brokerageId) return NextResponse.json({ error: "Your account is not attached to a brokerage" }, { status: 403 })

  let body: { purpose?: unknown; notes?: unknown; answered?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: "Send JSON: { purpose, notes }" }, { status: 400 }) }
  const purpose = body.purpose
  if (typeof purpose !== "string" || !(FORM_WIZARD_PURPOSES as readonly string[]).includes(purpose)) {
    return NextResponse.json({ error: "purpose must be listing or offer" }, { status: 400 })
  }
  const notes = typeof body.notes === "string" ? body.notes : ""
  if (notes.trim().length < 8) return NextResponse.json({ proposals: [], dropped: [], via: "rules", notes: ["Write a little more about the deal and the coach will suggest answers."] })
  const answered = Array.isArray(body.answered) ? body.answered.filter((k): k is string => typeof k === "string").slice(0, 60) : []

  // Entitlement before the paid call. ~4 chars per token over the notes and the question list, plus the ceiling of the answer.
  const gate = await mayUseAndAfford({
    brokerageId, capability: "ai.generate",
    estTokens: Math.ceil(Math.min(notes.length, INTAKE_NOTES_MAX_CHARS) / 4) + 1200 + 900,
    actor: { userType: (me?.user_type as string | null) ?? null, platformRole: (me?.platform_role as string | null) ?? null },
  })
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.message ?? `The coach's suggestions are not available right now (${gate.reason}).`, proposals: [], dropped: [], notes: [] }, { status: 402 })
  }

  const suggestion = await suggestIntakeAnswers({ purpose: purpose as "listing" | "offer", notes, brokerageId, userId: user.id, alreadyAnswered: answered })
  return NextResponse.json(suggestion)
}
