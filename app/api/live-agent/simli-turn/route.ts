/**
 * POST /api/live-agent/simli-turn
 *
 * THE SIMLI LEG'S BRAIN RELAY (wave 62). D-ID's Agents SDK calls
 * /api/did/custom-llm on OUR behalf on every conversational turn — that is
 * how the D-ID-mediated live avatar (portal/embed/site) gets its answers
 * from OUR brain (brand voice, FAQ, contact/transaction context, realism
 * directive; app/api/did/custom-llm/route.ts's own header). The Simli
 * fail-over leg has NO D-ID Agent in the loop to make that call for it — the
 * browser talks to Simli directly over LiveKit — so SOMETHING has to call
 * custom-llm on the Simli leg's behalf. That something is this route: a
 * thin, SAME-ORIGIN relay, never a second brain (§6 — buildSystemPrompt,
 * loadBrandVoicePrompt, the realism directive, escalation detection all stay
 * exactly where they are; nothing here re-implements any of them).
 *
 * WHY A RELAY AND NOT A DIRECT CLIENT CALL: /api/did/custom-llm authenticates
 * its caller with DID_CUSTOM_LLM_KEY, a SERVER secret meant for D-ID's own
 * backend to present — it must never reach the browser. This route holds
 * that secret server-side and presents it exactly the way D-ID's backend
 * does (HTTP Basic, key as username), so custom-llm's own auth path is
 * untouched and unweakened.
 *
 * TENANT NEVER FROM THE BODY (CLAUDE.md §4): the brokerage/contact this turn
 * is answered for is resolved OFF THE `live_agent_sessions` ROW BY liveSessionId
 * — the same row app/api/did/agents/session and app/api/embed/session opened
 * at mint, under the caller's already-verified tenant (portal auth gate /
 * embed public_id+origin gate). A body-supplied embedSessionId (needed only
 * for an ANONYMOUS visitor's pre-capture context — the row's own contact_id
 * is null then) is cross-checked against the row's brokerage_id before it is
 * ever used, so a forged id from a different tenant cannot borrow this
 * session's identity.
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveOpenSimliSession } from "@/lib/did/live-session-metering"

export const runtime = "nodejs"

interface Body {
  liveSessionId?: string
  text?: string
  /** Only consulted when the session row has no contact_id yet (anonymous
   *  embed/site visitor, pre-capture) — verified against the row's own
   *  brokerage_id before use. */
  embedSessionId?: string
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Body | null
  const liveSessionId = body?.liveSessionId
  const text = (body?.text ?? "").trim()
  if (!liveSessionId || !text) {
    return NextResponse.json({ error: "liveSessionId and text required" }, { status: 400 })
  }
  if (text.length > 2000) {
    return NextResponse.json({ error: "text too long (max 2000 chars)" }, { status: 400 })
  }

  const svc = createServiceClient()
  // THE ONE SESSION-ROW RESOLVER (lane 63B, §6) — open + heartbeat-fresh +
  // provider==='simli', shared with app/api/internal/voice-tts/route.ts's
  // anonymous TTS fail-over leg. Never a second copy of this check.
  const resolved = await resolveOpenSimliSession(svc, liveSessionId)
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status })
  }
  const session = resolved.session

  // ── Resolve the SAME [[CTX:...]] marker custom-llm already parses ───────
  let marker: string
  if (session.contactId) {
    marker = `[[CTX:contactId=${session.contactId}]] `
  } else if (body?.embedSessionId) {
    const { data: embedSession } = await svc
      .from("embed_sessions")
      .select("id, brokerage_id")
      .eq("id", body.embedSessionId)
      .maybeSingle()
    if (!embedSession || embedSession.brokerage_id !== session.brokerageId) {
      return NextResponse.json({ error: "embedSessionId does not match this session's tenant" }, { status: 403 })
    }
    marker = `[[CTX:embedSessionId=${body.embedSessionId}]] `
  } else {
    // FAIL CLOSED (matches custom-llm's own #187 rule) — never served
    // uncapped with neither handle resolvable.
    return NextResponse.json({ error: "no contact/embed context resolvable for this session" }, { status: 409 })
  }

  const customLlmKey = process.env.DID_CUSTOM_LLM_KEY
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!customLlmKey || !appUrl) {
    return NextResponse.json({ error: "custom-llm brain not configured" }, { status: 503 })
  }

  // ── Relay to the ONE brain, presenting D-ID's own auth shape ────────────
  let upstream: Response
  try {
    upstream = await fetch(`${appUrl}/api/did/custom-llm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${customLlmKey}:`).toString("base64")}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: `${marker}${text}` }],
        stream: true,
      }),
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "brain call failed" }, { status: 502 })
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "")
    return NextResponse.json({ error: detail || `brain call failed (HTTP ${upstream.status})` }, { status: 502 })
  }

  // ── Drain the OpenAI-format SSE stream into plain text ───────────────────
  // The Simli leg TTS's the whole reply in one ElevenLabs call (see
  // SimliFaceSession.tsx) rather than a per-token stream, so there is
  // nothing to gain from forwarding chunk-by-chunk to the browser here.
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let full = ""
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue
      const payload = trimmed.slice(5).trim()
      if (payload === "[DONE]" || !payload) continue
      try {
        const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
        const delta = parsed.choices?.[0]?.delta?.content
        if (typeof delta === "string") full += delta
      } catch {
        // A partial/malformed SSE line mid-buffer — ignore and continue;
        // the buffer carries the remainder to the next chunk.
      }
    }
  }

  return NextResponse.json({ reply: full.trim() })
}
