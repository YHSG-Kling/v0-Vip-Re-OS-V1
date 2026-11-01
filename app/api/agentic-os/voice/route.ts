// app/api/agentic-os/voice/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE C17 DOOR (wave 148, lane 148D) — and still the kernel voice lane's door. One sentence in, spoken or
// typed, from any screen; out comes the interpretation (capability, params, missing information, the plan
// in words, the authority answer) and — on a turn that clears every rail — the execution.
//
// WHAT CHANGED, AND WHAT DID NOT. This route was the kernel lane's door: an utterance → planVoiceCommand →
// a governed plan, one manager signal per step on a confirmed turn. That lane is untouched and still runs
// here — it is the `kernel_signal` family of the ONE intent catalogue (lib/voice-admin/intent-interface.ts),
// executed by executeIntent through planVoiceCommand. What the door gained is the rest of the OS: the six
// domain routes the owner named (an ad, a buyer search by interest, a market blog, a home search, an open
// house, who may need help), and a HANDOFF for every intent a legacy surface still executes (the team
// brain, the field mic, the governed command layer) — the affordance posts the same words to that door,
// whose classifier is now this catalogue too.
//
// ITS CALLER is app/components/shared/intent-affordance.tsx — the ONE voice/text affordance, mounted on
// the screens listed in INTENT_SCREENS (it replaced app/components/dashboard/voice/KernelPlanCard.tsx,
// whose plan rendering, confirmation turn and refusal display it carries).
//
// TWO REFUSALS THAT ARE DELIBERATE (unchanged):
//   · A BEARER TOKEN CANNOT SPEAK. Every dispatched step and every ledger row records the HUMAN who asked
//     (users.id); an agent credential has no human behind it, and agents.id / users.id are DISJOINT — so
//     /api/agentic-os/actions is the door for a token.
//   · THE TENANT AND THE ACTOR ARE THE SESSION'S. Nothing in the body names a brokerage, a user or a role;
//     a contactId / listingId in `context` is a HINT the executor re-reads under the session tenant.
//
// AUTHORITY: a plain tenant session carries no agent-token scopes (resolveAgenticCaller grants scopes to
// tokens and platform staff only), which is why the kernel lane used to answer "you are not able to …"
// to every broker. C17 decides authority from the session ROLE (FEATURE_FLAGS), the assistant's risk
// ceiling and the never-spoken list, and grants the kernel step exactly the one scope it cleared.

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { resolveAgenticCaller } from "@/lib/agentic-os/agent-credentials"
import { isIntentScreen, INTENT_MODALITIES, type IntentActor, type IntentModality } from "@/lib/voice-admin/intent-interface"
import { interpretIntentLive, executeIntent, recordIntentCommand } from "@/lib/voice-admin/intent-interface-live"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request) {
  const caller = await resolveAgenticCaller(req)
  if (caller.via === "none") {
    return NextResponse.json({ error: "Unauthenticated — sign in to ask the assistant" }, { status: 401 })
  }
  if (caller.via === "token") {
    return NextResponse.json(
      {
        error:
          "A spoken or typed request needs a person. This door records the human who asked on every step " +
          "and ledger row, and an agent credential has no human behind it. Use /api/agentic-os/actions to " +
          "invoke a capability with a token.",
      },
      { status: 403 },
    )
  }

  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 })
  }
  const utterance = typeof body.utterance === "string" ? body.utterance.trim().slice(0, 1000) : ""
  if (!utterance) {
    return NextResponse.json({ error: "Nothing was said — `utterance` is required" }, { status: 400 })
  }
  const modality: IntentModality = (INTENT_MODALITIES as readonly string[]).includes(String(body.modality)) ? (body.modality as IntentModality) : "text"
  const screen = isIntentScreen(body.screen) ? body.screen : null
  const confirmed = body.confirmed === true
  const rawCtx = (body.context && typeof body.context === "object" ? body.context : {}) as Record<string, unknown>
  const context = {
    contactId: typeof rawCtx.contactId === "string" && UUID.test(rawCtx.contactId) ? rawCtx.contactId : null,
    listingId: typeof rawCtx.listingId === "string" && UUID.test(rawCtx.listingId) ? rawCtx.listingId : null,
  }

  const actor: IntentActor = {
    userId: auth.userId,
    userType: auth.userType,
    platformRole: auth.platformRole,
    // agents.id, resolved by requireAuth from agents.user_id — never the users.id above (disjoint spaces).
    agentId: auth.agentId,
    // A buyer in their own portal acts AS the contact the page is about — proven again by
    // requireContactAccess inside the executor before any read.
    contactId: (auth.userType ?? "").toLowerCase() === "contact" ? context.contactId : null,
  }
  const tenant = { brokerageId: auth.brokerageId }
  const svc = createServiceClient()

  const interpretation = await interpretIntentLive({ utterance, modality, actor, tenant, screen, context, svc })
  const execution = interpretation.capability ? await executeIntent(interpretation, { actor, tenant, confirmed, context, svc }) : null
  await recordIntentCommand(svc, { actor, tenant, interpretation, execution, source: screen === "mobile" ? "mobile" : "web" })

  return NextResponse.json({
    utterance,
    modality,
    screen,
    confirmed,
    interpretation,
    execution,
    // What the assistant says — the execution's words when something ran or was refused, else the plan's.
    spokenSummary: execution?.say ?? interpretation.plan.summary,
  })
}
