/**
 * scripts/meta-webhook-fail-closed-guard.ts — wave 148, lane 148Z (lane 148K hand-off: 143J-SO-05, 146I-OL-09 — "add a
 * fail-closed fixture proof that names app/api/webhooks/whatsapp/route.ts + lib/meta/verify-signature.ts").
 *
 * WHAT IT PROVES, RUN (not by pattern): the WhatsApp Cloud API webhook is the CRM's inbound door for a channel where texting
 * in counts as consent (owner ruling 22) — so an unauthenticated POST that reached the CRM would file forged people and forged
 * consent. The ONE Meta verifier fails CLOSED, and the route refuses BEFORE it touches the database:
 *   1. App Secret unset            → 503, and the route reads NOTHING (a recording client counts every .from());
 *   2. signature missing / malformed / for other bytes → 401, nothing read;
 *   3. a correctly signed body      → verified (POSITIVE CONTROL — the refusals above are not "refuse everything");
 *   4. the GET handshake: token unset → 404, wrong token → 403, right token → the challenge echoed;
 *   5. the route reads the signature over the RAW body (req.text() before JSON.parse) — a stripped-source check, with a
 *      positive control that the finder sees the defect (req.json() before verification).
 *
 * BLIND SPOTS (published): Meta's live delivery is not exercised (no app secret here — the HMAC is computed locally exactly as
 * Meta documents it); the signed-body run stops at the route's first branch (a non-WhatsApp object acks 200) so the inbound
 * pipeline's own proofs own what happens after; the other two Meta routes share the verifier and are named by
 * scripts/webhook-contract-guard.ts, not re-run here.
 *
 * Run: npx tsx scripts/meta-webhook-fail-closed-guard.ts   (package key for lane I2 / the integrator: test:meta-webhook-fail-closed)
 */
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"

const G = globalThis as any
G.__148Z = { reads: 0 }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  // A recording client: every table the route touches is counted. A refusal must leave the count at zero.
  "@/lib/supabase/service": "export const createServiceClient = () => ({ from: () => { globalThis.__148Z.reads++; const q = { select: () => q, eq: () => q, in: () => q, limit: () => q, maybeSingle: async () => ({ data: null, error: null }), single: async () => ({ data: null, error: null }), insert: () => q, update: () => q, then: (r) => r({ data: [], error: null }) }; return q } })",
  "@/lib/communications/inbound-record": "export async function processInboundCommunication(){ globalThis.__148Z.reads++; return { ok: true } }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const body = STUB[spec]
    if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

let passed = 0, failed = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`

async function main() {
  console.log("━━ META / WHATSAPP WEBHOOK — FAIL CLOSED, RUN (wave 148, lane 148Z) ━━")
  const { NextRequest } = await import("next/server")
  const V = await import("../lib/meta/verify-signature")
  const route = await import("../app/api/webhooks/whatsapp/route")
  const URL_ = "https://app.example.test/api/webhooks/whatsapp"
  const body = JSON.stringify({ object: "page", entry: [] })
  const post = (headers: Record<string, string>, raw = body) => route.POST(new NextRequest(URL_, { method: "POST", body: raw, headers: { "content-type": "application/json", ...headers } }) as never)

  console.log("\n1 · the App Secret unset → 503, nothing read")
  delete process.env.META_APP_SECRET; delete process.env.FACEBOOK_APP_SECRET
  G.__148Z.reads = 0
  const unset = await post({ "x-hub-signature-256": sign("anything", body) })
  check("verifier: no App Secret → 503 'not configured' (never a silent 200)", V.verifyMetaSignature(body, sign("x", body)).ok === false && (V.verifyMetaSignature(body, sign("x", body)) as { status: number }).status === 503)
  check("route: no App Secret → 503 and the CRM is not touched (0 reads)", unset.status === 503 && G.__148Z.reads === 0, JSON.stringify({ status: unset.status, reads: G.__148Z.reads }))

  console.log("\n2 · a forger → 401, nothing read")
  process.env.META_APP_SECRET = "guard-app-secret"
  G.__148Z.reads = 0
  const missing = await post({})
  const malformed = await post({ "x-hub-signature-256": "md5=abc" })
  const otherBytes = await post({ "x-hub-signature-256": sign("guard-app-secret", body + " ") })
  const wrongKey = await post({ "x-hub-signature-256": sign("not-the-secret", body) })
  check("route: missing / malformed / other-bytes / wrong-key signatures → 401 each", [missing, malformed, otherBytes, wrongKey].every((r) => r.status === 401), [missing, malformed, otherBytes, wrongKey].map((r) => r.status).join(","))
  check("…and none of the four touched the CRM (0 reads)", G.__148Z.reads === 0, String(G.__148Z.reads))

  console.log("\n3 · POSITIVE CONTROL — a correctly signed body is verified")
  check("verifier: the documented HMAC-SHA256 over the exact bytes verifies", V.verifyMetaSignature(body, sign("guard-app-secret", body)).ok === true)
  const good = await post({ "x-hub-signature-256": sign("guard-app-secret", body) })
  check("route: a signed non-WhatsApp object passes verification and acks 200 (the refusals are not refuse-everything)", good.status === 200, String(good.status))

  console.log("\n4 · the GET handshake")
  delete process.env.META_WEBHOOK_VERIFY_TOKEN; delete process.env.META_VERIFY_TOKEN; delete process.env.WHATSAPP_VERIFY_TOKEN
  const hs = (q: string) => route.GET(new NextRequest(`${URL_}?${q}`, { method: "GET" }) as never)
  const notCfg = await hs("hub.mode=subscribe&hub.verify_token=t&hub.challenge=42")
  process.env.META_WEBHOOK_VERIFY_TOKEN = "guard-token"
  const wrong = await hs("hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42")
  const right = await hs("hub.mode=subscribe&hub.verify_token=guard-token&hub.challenge=42")
  check("token unset → 404 · wrong token → 403 · right token → 200 echoing the challenge", notCfg.status === 404 && wrong.status === 403 && right.status === 200 && (await right.text()) === "42", [notCfg.status, wrong.status, right.status].join(","))

  console.log("\n5 · the signature is over the RAW body")
  const code = stripComments(readFileSync(join(process.cwd(), "app/api/webhooks/whatsapp/route.ts"), "utf8"))
  const postBody = code.slice(code.indexOf("export async function POST("))
  const rawFirst = (s: string) => { const t = s.indexOf("await req.text()"), v = s.indexOf("verifyMetaSignature("), j = s.indexOf("req.json()"); return t >= 0 && v > t && (j < 0 || j > v) }
  check("the route reads req.text() ONCE, verifies, and only then parses (no req.json() before the verifier)", rawFirst(postBody))
  check("POSITIVE CONTROL: the finder rejects a route that parses with req.json() before verifying", !rawFirst("export async function POST(req) { const p = await req.json(); verifyMetaSignature(JSON.stringify(p), h) }"))

  console.log(`\nRESULT: ${passed} passed, ${failed} failed${failed === 0 ? " ✅ META_WEBHOOK_FAIL_CLOSED_PASS" : ""}`)
  if (failed) { console.log(`FAILED:\n  - ${fails.join("\n  - ")}`); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
