// tools/relay-companion/server.mjs
// ─────────────────────────────────────────────────────────────────────────────
// THE CONVERSATIONRELAY COMPANION — the one piece of the voice stack that
// cannot live on Vercel functions (a ConversationRelay session is a persistent
// WebSocket). It is deliberately BRAINLESS: no prompts, no credentials, no
// business logic — it moves text between Twilio's socket and the app's
// secret-gated /api/voice/relay/plan endpoint, where every gate (TCPA,
// opt-out, Fair Housing prompt rules, booking/prospect side-effects, human
// transfer) actually runs. Deploy anywhere that holds a socket (Fly, Railway,
// Render, a $5 VPS); then set on Vercel:
//   CONVERSATION_RELAY_WSS_URL = wss://<this host>/relay
//   RELAY_SHARED_SECRET        = <same value as this host's env>
// Unset those two and the app's serverless <Gather> lane answers instead —
// the transport is a switch, never a rewrite.
//
// Env (this host): APP_URL, RELAY_SHARED_SECRET, PORT (default 8080)
// Run: node server.mjs   (Node 20+, `npm i ws`)

import { createServer } from "node:http"
import { WebSocketServer } from "ws"

const APP_URL = (process.env.APP_URL ?? "").replace(/\/$/, "")
const SECRET = process.env.RELAY_SHARED_SECRET ?? ""
const PORT = Number(process.env.PORT ?? 8080)
if (!APP_URL || !SECRET) {
  console.error("APP_URL and RELAY_SHARED_SECRET are required")
  process.exit(1)
}

const server = createServer((_, res) => { res.writeHead(200); res.end("relay-companion ok") })
const wss = new WebSocketServer({ server, path: "/relay" })

wss.on("connection", (ws) => {
  // Per-session state: Twilio sends setup once, then a prompt per utterance.
  // Interrupt frames (caller barges in over TTS) are COUNTED and passed to
  // the plan endpoint so the brain paces down — shorter replies for fast talkers.
  let session = { callSid: "", from: "", to: "" }
  let interrupts = 0

  ws.on("message", async (raw) => {
    let frame
    try { frame = JSON.parse(raw.toString()) } catch { return }

    if (frame?.type === "setup") {
      session = { callSid: frame.callSid ?? "", from: frame.from ?? "", to: frame.to ?? "" }
      return
    }
    if (frame?.type === "interrupt") { interrupts += 1; return }
    if (frame?.type !== "prompt" || frame.last === false || !session.callSid) return

    try {
      const res = await fetch(`${APP_URL}/api/voice/relay/plan`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-relay-secret": SECRET },
        body: JSON.stringify({ ...session, utterance: String(frame.voicePrompt ?? ""), interrupts }),
      })
      if (!res.ok) {
        ws.send(JSON.stringify({ type: "text", token: "Sorry — could you say that once more?", last: true }))
        return
      }
      const plan = await res.json()
      if (plan.say) ws.send(JSON.stringify({ type: "text", token: String(plan.say).slice(0, 1000), last: true }))
      // On a server-side transfer Twilio re-points the call itself; ending the
      // session here just releases the socket cleanly.
      if (plan.endSession) ws.send(JSON.stringify({ type: "end" }))
    } catch (err) {
      console.error("[relay-companion] plan call failed:", err?.message ?? err)
      ws.send(JSON.stringify({ type: "text", token: "Sorry — could you say that once more?", last: true }))
    }
  })
})

server.listen(PORT, () => console.log(`relay-companion listening on :${PORT} (path /relay) → ${APP_URL}`))
