/**
 * scripts/did-first-simulator.ts   (npm run test:did-first)
 *
 * WAVE 87, LANE 87B. Owner, verbatim (2026-09-28): "d-id is always first and the
 * perferred."
 *
 * AUDIT — every avatar / live-agent provider selector in the tree, and what each
 * answers (the census this proof pins; a new selector must be added here):
 *   1. lib/live-agent/face-render.ts normalizeProviderOrder — the READ side both live
 *      session doors and the Twin Studio card use. FOUND: it returned a stored order
 *      verbatim, so a row saying ['simli','did'] read and DISPLAYED simli-first while
 *      the doors still started D-ID. FIXED: D-ID pinned first on read.
 *   2. lib/live-agent/face-render.ts validateFaceProviderOrder — the WRITE side (86H):
 *      already refused a non-D-ID-first order. Pinned here.
 *   3. brokerage_settings.live_agent_face_provider_order — the stored setting: no
 *      CHECK on its order. FIXED: m667 CHECK (live_agent_face_provider_order[1]='did').
 *   4. app/api/did/agents/session + app/api/embed/session — the two live doors: D-ID
 *      init first; Simli only inside the D-ID-init-FAILED branch. Pinned by source.
 *   5. lib/kernel/providers.ts resolveProviderCore — the platform registry for the
 *      'video' / 'avatar' types. FOUND: a superadmin override row naming another
 *      vendor was answered verbatim (the two current call sites coerce, a future one
 *      would not). FIXED: the registry answers D-ID ('upload' — agent footage, not an
 *      avatar — is the one other video key).
 *   6. lib/marketing/video-provider-resolver.ts + lib/providers/dispatch.ts — the
 *      render paths: D-ID-locked. Pinned by source.
 *   7. Every array literal in lib/ and app/ that orders 'did' with 'simli' — D-ID
 *      first. Scanned on stripped source with a positive control.
 *
 * No network: pure functions, an in-memory override table, stripped source.
 * BLIND SPOTS (published): the client widgets are not rendered (they mount Simli only
 * when the server answered provider:'simli', proven by the doors' source here); a
 * provider order built at runtime from a non-literal is outside the literal scan.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "./strip-comments"
import { normalizeProviderOrder, validateFaceProviderOrder, FACE_RENDER_PROVIDERS } from "../lib/live-agent/face-render"
import { resolveProviderCore } from "../lib/kernel/providers"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const code = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"))

/** The pre-87B read side, verbatim — the specimen the positive control runs on. */
function preFixNormalize(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ["did", "simli"]
  const cleaned = raw.filter((v) => v === "did" || v === "simli")
  return cleaned.length > 0 ? cleaned : ["did", "simli"]
}
const didFirst = (order: readonly string[]) => order[0] === "did"

function overrideClient(rows: Array<{ provider_type: string; scope_type: string; provider_key: string }>) {
  return {
    from: () => {
      const f: Record<string, unknown> = {}
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { f[c] = v; return q },
        maybeSingle: async () => {
          const hit = rows.find((r) => r.provider_type === f.provider_type && r.scope_type === f.scope_type)
          return { data: hit ? { provider_key: hit.provider_key, config: {} } : null, error: null }
        },
      }
      return q
    },
  } as any
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

async function main() {
  console.log("\n── §1 the live-face order (read side) ──")
  const stored: unknown[][] = [["simli", "did"], ["simli"], ["did", "simli"], ["did"], ["simli", "simli", "did"], ["heygen", "simli"], []]
  for (const s of stored) {
    const got = normalizeProviderOrder(s)
    check(`stored ${JSON.stringify(s)} reads D-ID first → ${JSON.stringify(got)}`, didFirst(got) && new Set(got).size === got.length)
  }
  check("a D-ID-first order reads back unchanged (backups keep their order)", normalizeProviderOrder(["did", "simli"]).join() === "did,simli")
  check("a stored order that left the backup OUT keeps it off", normalizeProviderOrder(["did"]).join() === "did")
  check("[positive control] the PRE-87B read side answered simli-first for ['simli','did'] — the check discriminates",
    !didFirst(preFixNormalize(["simli", "did"])))

  console.log("\n── §2 the live-face order (write side + database) ──")
  check("the writer refuses a Simli-first order", !validateFaceProviderOrder(["simli", "did"]).ok)
  check("the writer refuses a Simli-only order", !validateFaceProviderOrder(["simli"]).ok)
  check("[control] the writer accepts the D-ID-first default", validateFaceProviderOrder([...FACE_RENDER_PROVIDERS]).ok)
  check("the vocabulary's first member IS D-ID", FACE_RENDER_PROVIDERS[0] === "did")
  const m667 = readFileSync(join(ROOT, "supabase/migrations/m667-one-presentation-per-booking-and-did-first.sql"), "utf8")
  check("m667 adds the database CHECK: live_agent_face_provider_order[1] = 'did'",
    /ADD CONSTRAINT brokerage_settings_face_provider_did_first\s+CHECK \(live_agent_face_provider_order\[1\] = 'did'\)/.test(m667))
  const m627 = readFileSync(join(ROOT, "supabase/migrations/m627-live-agent-face-provider.sql"), "utf8")
  check("m627's column DEFAULT leads with D-ID", /DEFAULT ARRAY\['did', 'simli'\]/.test(m627))

  console.log("\n── §3 the live session doors ──")
  const DOORS = ["app/api/did/agents/session/route.ts", "app/api/embed/session/route.ts"]
  const doorOrder = (src: string) => {
    const did = src.indexOf("ensureDIDAgent(")
    const failBranch = src.indexOf("if (!ensured.ok)")
    const simli = src.indexOf("simliFaceRenderAdapter.startSession(")
    return { ok: did > 0 && failBranch > did && simli > failBranch, did, failBranch, simli }
  }
  for (const d of DOORS) {
    const o = doorOrder(code(d))
    check(`${d}: D-ID init first; Simli only inside the D-ID-failed branch`, o.ok, JSON.stringify(o))
  }
  check("[positive control] a door that tried Simli first is caught",
    !doorOrder(`const s = await simliFaceRenderAdapter.startSession(p)\nconst ensured = await ensureDIDAgent(p)\nif (!ensured.ok) {}`).ok)

  console.log("\n── §4 the platform provider registry ──")
  const actor = { userId: "u", brokerageId: "b" }
  const rows = [
    { provider_type: "avatar", scope_type: "superadmin", provider_key: "simli" },
    { provider_type: "video", scope_type: "superadmin", provider_key: "heygen" },
    { provider_type: "email", scope_type: "superadmin", provider_key: "postmark" },
  ]
  const av = await resolveProviderCore(overrideClient(rows), { providerType: "avatar", actorContext: actor })
  check("an 'avatar' override naming Simli is NOT honoured — the registry answers D-ID", av.providerKey === "did", JSON.stringify(av))
  const vi = await resolveProviderCore(overrideClient(rows), { providerType: "video", actorContext: actor })
  check("a 'video' override naming HeyGen is NOT honoured — the registry answers D-ID", vi.providerKey === "did", JSON.stringify(vi))
  const up = await resolveProviderCore(overrideClient([{ provider_type: "video", scope_type: "superadmin", provider_key: "upload" }]), { providerType: "video", actorContext: actor })
  check("'upload' (agent footage, no avatar render) stays honoured for video", up.providerKey === "upload")
  const em = await resolveProviderCore(overrideClient(rows), { providerType: "email", actorContext: actor })
  check("[control] the pin is scoped: a non-avatar type's override is still honoured", em.providerKey === "postmark")
  const none = await resolveProviderCore(overrideClient([]), { providerType: "avatar", actorContext: actor })
  check("no override → D-ID (system default)", none.providerKey === "did")

  console.log("\n── §5 render paths + every literal order ──")
  const vpr = code("lib/marketing/video-provider-resolver.ts")
  check("video-provider-resolver answers D-ID unless 'upload'", /return providerKey === "upload" \? "upload" : "did"/.test(vpr))
  const dispatch = code("lib/providers/dispatch.ts")
  check("dispatchVideo renders through the D-ID path only", /return dispatchVideoViaDID\(\{ params, providerKey \}\)/.test(dispatch))

  const ORDER_LIT = /\[\s*(["'])(did|simli)\1\s*,\s*(["'])(did|simli)\3[^\]]*\]/g
  const offenders: string[] = []
  let literals = 0
  for (const f of [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app"))]) {
    const src = stripComments(readFileSync(f, "utf8"))
    for (const m of src.matchAll(ORDER_LIT)) {
      if (m[2] === m[4]) continue
      literals++
      if (m[2] !== "did") offenders.push(`${relative(ROOT, f)}: ${m[0]}`)
    }
  }
  check(`every literal did/simli order in lib/ + app/ leads with D-ID (${literals} found)`, offenders.length === 0 && literals >= 1, offenders.join("; "))
  const specimen = [...stripComments(`const ORDER = ["simli", "did"]`).matchAll(ORDER_LIT)]
  check("[positive control] the literal scan catches a Simli-first order", specimen.length === 1 && specimen[0][2] === "simli")

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log("FAILURES:\n  - " + failures.join("\n  - ")); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
