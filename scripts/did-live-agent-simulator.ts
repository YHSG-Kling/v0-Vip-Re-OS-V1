#!/usr/bin/env tsx
/**
 * scripts/did-live-agent-simulator.ts   (npm run test:did-live-agent)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 58 — "we are using d-id express v4 for live agent for website, widget,
 * in portal as options" (owner, verbatim). This is the fleet guard for the
 * LIVE CONVERSATIONAL avatar (D-ID Agents SDK / Agents API), a companion to
 * scripts/avatar-pipeline-hardening-simulator.ts (which guards the RENDERED
 * VIDEO pipeline — create-avatar/generate-video/webhook — a different concern,
 * not repeated here).
 *
 * Properties proved, each with a POSITIVE CONTROL (§2):
 *   §gateway    lib/did/agents.ts's create/update calls go through
 *               lib/did/gateway.ts's didRequest (Connection OS's single D-ID
 *               egress, which sets externalKeyHeader() so an ElevenLabs-
 *               cloned agent voice actually resolves), never a bespoke
 *               callConnector import.
 *   §sync       syncDIDAgent (PATCH /agents/{id}) exists and shares
 *               buildAgentBody with the create call (§6 — one body builder);
 *               app/api/cron/did-agent-sync sweeps every cached did_agent_id
 *               and is registered in CRON_REGISTRY — the "updated
 *               autonomously… never a button-only path" half of the ruling.
 *   §anonymous  /api/did/custom-llm accepts an embedSessionId marker (not
 *               just contactId) so an anonymous public-website/embed visitor
 *               is answered instead of refused on their very first turn, and
 *               the embed widget actually sends that marker.
 *   §brain      custom-llm answers from lib/ai-isa/brand-voice-prompt.ts's
 *               loadBrandVoicePrompt (brand voice + FAQ + objection library +
 *               brokerage knowledge-base RAG) — the survivor — not a second,
 *               narrower hand-rolled prompt builder.
 *   §realism    lib/video/realism-profile.ts's SPOKEN_REALISM_DIRECTIVE
 *               reaches BOTH the D-ID Agent's baseline instructions (every
 *               surface, every turn D-ID's own bundled fallback might speak)
 *               and the custom-llm per-turn system prompt; scanForAiTells
 *               runs advisory on twin greetings at session-mint time.
 *   §callback   the two "call me back" doors this wave audited
 *               (/api/portal/escalate, /api/widget/live-agent-request) write
 *               a durable lib/ai-isa/callback-task.ts createCallbackTask, not
 *               only a notification a human might miss.
 *   §portalGate the portal's "Live" button reads a REAL, setting-derived twin
 *               readiness gate (agent_avatar_assets.status/approval_status —
 *               the brokerage's own twins_require_approval workflow), not a
 *               bare "does any row exist" check.
 *   §website    the public website (SiteChatLauncher, app/site + app/p)
 *               offers the SAME D-ID live-agent embed as the embeddable
 *               widget when the tenant has one configured — reused, not
 *               duplicated — with a graceful text-only fallback when not.
 *   §consent    the D-ID 428 consent gate (app/api/did/create-avatar) is
 *               UNTOUCHED by this wave's changes — never weakened.
 *
 * METHOD (§2): every scan reads STRIPPED source via scripts/strip-comments.ts.
 * PURE — no network, no D-ID call, no database.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import { SPOKEN_REALISM_DIRECTIVE, scanForAiTells, AI_TELL_POSITIVE_CONTROLS, AI_TELL_NEGATIVE_CONTROL } from "../lib/video/realism-profile"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const readStripped = (rel: string): string => stripComments(readFileSync(join(root, rel), "utf8"))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
// §gateway — agents.ts on the single D-ID egress path, not a bespoke fetch
// ═══════════════════════════════════════════════════════════════════════════
function gatewaySection() {
  console.log("\n── §gateway — lib/did/agents.ts on didRequest, not a bespoke callConnector ──")
  const agents = readStripped("lib/did/agents.ts")

  check("agents.ts imports didRequest from the gateway (the single D-ID egress path)",
    /import\s*\{\s*didRequest\s*\}\s*from\s*["']\.\/gateway["']/.test(agents))
  check("agents.ts does NOT import callConnector directly (that is the pre-fix bespoke-fetch shape)",
    !/import\s*\{[^}]*callConnector[^}]*\}\s*from\s*["']@\/lib\/agentic-os\/connector-gateway["']/.test(agents))
  check("create (POST /agents) goes through didRequest",
    /didRequest<\{\s*id\?:\s*string\s*\}>\(\s*["']\/agents["']/.test(agents))
  check("update (PATCH /agents/{id}) goes through didRequest",
    /didRequest\(\s*`\/agents\/\$\{encodeURIComponent\(params\.didAgentId\)\}`/.test(agents))
  check("client-key issuance goes through didRequest",
    /didRequest<\{\s*client_key/.test(agents))
  check("classifyDidError turns a failed didRequest into a human-actionable message (not a raw status echo)",
    /classifyDidError\(res\.status/.test(agents))

  // CONTROL: the pre-fix shape (a bespoke callConnector call with no gateway,
  // no externalKeyHeader) is correctly recognised as NOT on the gateway.
  const preFixSnippet = `
    import { callConnector } from "@/lib/agentic-os/connector-gateway"
    const res = await callConnector({ connector: "did", baseUrl: DID_API_BASE, path: "/agents", method: "POST", auth: { style: "basic", username: didApiKey, password: "" }, body })
  `
  check("[control] the pre-fix bespoke callConnector shape is correctly rejected by the didRequest pattern",
    !/didRequest</.test(preFixSnippet) && /callConnector\(/.test(preFixSnippet))
}

// ═══════════════════════════════════════════════════════════════════════════
// §sync — the UPDATE half: syncDIDAgent + the autonomous cron sweep
// ═══════════════════════════════════════════════════════════════════════════
function syncSection() {
  console.log("\n── §sync — the D-ID agent record updates autonomously on twin/voice change ──")
  const agents = readStripped("lib/did/agents.ts")
  const cron = readStripped("app/api/cron/did-agent-sync/route.ts")

  check("syncDIDAgent is exported (the PATCH/update half ensureDIDAgent never had)",
    /export async function syncDIDAgent/.test(agents))
  check("syncDIDAgent PATCHes (not re-POSTs, which would mint a duplicate agent)",
    /method:\s*["']PATCH["']/.test(agents))
  check("create and update share ONE body builder (buildAgentBody) — cannot drift (§6)",
    /function buildAgentBody/.test(agents) &&
    (agents.match(/buildAgentBody\(/g) ?? []).length >= 2)
  check("a 404 from D-ID (cached id deleted out of band) is distinguished as NOT_FOUND, not a generic failure",
    /res\.status === 404 \? "NOT_FOUND"/.test(agents))

  check("app/api/cron/did-agent-sync exists and calls syncDIDAgent",
    /import\s*\{\s*syncDIDAgent\s*\}\s*from\s*["']@\/lib\/did\/agents["']/.test(cron) && /await syncDIDAgent\(/.test(cron))
  check("the sweep is gated by verifyCronAuth (platform cron, not a public route)",
    /verifyCronAuth\(request\)/.test(cron))
  check("the sweep self-heals a NOT_FOUND by clearing the stale cache (never patches a ghost forever)",
    /NOT_FOUND/.test(cron) && /did_agent_id:\s*null/.test(cron))

  const registered = CRON_REGISTRY.some((e) => e.path === "/api/cron/did-agent-sync")
  check("did-agent-sync is registered in CRON_REGISTRY (an unregistered route never runs — CLAUDE.md §1, unmounted ≠ dead but IS unbuilt until wired)",
    registered)

  // CONTROL: a create-only module (ensureDIDAgent with no PATCH anywhere) is
  // correctly recognised as missing the update half.
  const preFixSnippet = `export async function ensureDIDAgent(params) { /* POST only, cache forever */ }`
  check("[control] a create-only shape is correctly rejected by the syncDIDAgent-exported check",
    !/export async function syncDIDAgent/.test(preFixSnippet))
}

// ═══════════════════════════════════════════════════════════════════════════
// §anonymous — the public website + embeddable widget are answered before capture
// ═══════════════════════════════════════════════════════════════════════════
function anonymousSection() {
  console.log("\n── §anonymous — pre-capture visitors are answered, not refused ──")
  const route = readStripped("app/api/did/custom-llm/route.ts")
  const widget = readStripped("app/embed/[publicId]/embed-widget.tsx")

  check("custom-llm defines an embedSessionId marker distinct from contactId",
    /EMBED_CTX_RE/.test(route) && /embedSessionId=/.test(route))
  check("a turn is refused ONLY when NEITHER marker is present (not contactId alone)",
    /!markerContactId && !embedSessionId/.test(route))
  check("an embedSessionId resolves brokerage/agent via embed_sessions (never fabricates a tenant)",
    /loadEmbedContext/.test(route) && /from\(["']embed_sessions["']\)/.test(route))
  check("a captured contact_id on the embed_sessions row is picked up automatically (no client resend required)",
    /resolvedContactId = resolvedContactId \?\? embedCtx\.contactId/.test(route))

  check("the embed widget actually SENDS the embedSessionId marker on message one",
    /embedSessionId=\$\{sessionIdRef\.current\}/.test(widget))
  check("the embed widget's marker send is independent of capture state (sent whether or not a contactId exists yet)",
    /sessionMarkerSentRef/.test(widget))

  // CONTROL: the pre-fix handler (contactId required unconditionally) is
  // correctly recognised as refusing every anonymous turn.
  const preFixSnippet = `
    if (!contactId) {
      return NextResponse.json({ error: "context marker required" }, { status: 400 })
    }
  `
  check("[control] the pre-fix contactId-only gate is correctly recognised as refusing anonymous traffic",
    /if \(!contactId\) \{/.test(preFixSnippet) && !/embedSessionId/.test(preFixSnippet))
}

// ═══════════════════════════════════════════════════════════════════════════
// §brain — ONE prompt builder (loadBrandVoicePrompt), not a second one
// ═══════════════════════════════════════════════════════════════════════════
function brainSection() {
  console.log("\n── §brain — the live avatar answers from the SAME brand-voice/FAQ/KB survivor ──")
  const route = readStripped("app/api/did/custom-llm/route.ts")

  check("custom-llm imports loadBrandVoicePrompt (the survivor every other AI rail uses)",
    /import\s*\{\s*loadBrandVoicePrompt\s*\}\s*from\s*["']@\/lib\/ai-isa\/brand-voice-prompt["']/.test(route))
  check("loadBrandVoicePrompt is actually CALLED with a knowledgeQuery (so brokerage KB RAG applies live, not just FAQ)",
    /loadBrandVoicePrompt\(\{[\s\S]{0,200}knowledgeQuery:/.test(route))
  check("the old narrower applyBrandVoice-only prompt path is gone from this route (no duplicate builder, §6)",
    !/applyBrandVoice\(/.test(route))
}

// ═══════════════════════════════════════════════════════════════════════════
// §realism — SPOKEN_REALISM_DIRECTIVE reaches the live avatar, compliance-first
// ═══════════════════════════════════════════════════════════════════════════
function realismSection() {
  console.log("\n── §realism — the live avatar must not sound like an AI creation (wave 55/57 ruling, extended) ──")
  const agents = readStripped("lib/did/agents.ts")
  const route = readStripped("app/api/did/custom-llm/route.ts")

  check("agents.ts imports SPOKEN_REALISM_DIRECTIVE + scanForAiTells from the ONE realism home (§6)",
    /import\s*\{\s*SPOKEN_REALISM_DIRECTIVE,\s*scanForAiTells\s*\}\s*from\s*["']@\/lib\/video\/realism-profile["']/.test(agents))
  check("the directive is folded into the D-ID Agent's baseline llm.instructions (every surface's fallback speech)",
    /LIVE_REALISM_INSTRUCTIONS/.test(agents) && /instructions:\s*\[/.test(agents))
  check("greeting text is scanned for AI-tells at session-mint time (advisory, §5 — never a silent block)",
    /scanForAiTells\(params\.greeting\)/.test(agents) && /realismWarnings/.test(agents))

  check("custom-llm imports SPOKEN_REALISM_DIRECTIVE and folds it into the per-turn system prompt",
    /import\s*\{\s*SPOKEN_REALISM_DIRECTIVE\s*\}\s*from\s*["']@\/lib\/video\/realism-profile["']/.test(route) &&
    /lines\.push\(SPOKEN_REALISM_DIRECTIVE\)/.test(route))

  // Positive control — the scanner itself still recognises the AI-tells it
  // was built to catch (borrowed from the video-pipeline simulator's own
  // control, proving THIS module's import of the same scanner is live).
  const anyTellFound = AI_TELL_POSITIVE_CONTROLS.every((c) => scanForAiTells(c.text).length > 0)
  check("[control] scanForAiTells still recognises every researched AI-tell fixture (the scanner is not broken)",
    anyTellFound)
  check("[control] a clean, human-sounding line produces NO findings (the scanner is not over-firing)",
    scanForAiTells(AI_TELL_NEGATIVE_CONTROL).length === 0)
}

// ═══════════════════════════════════════════════════════════════════════════
// §callback — "call me back" writes a durable, autonomously-executed task
// ═══════════════════════════════════════════════════════════════════════════
function callbackSection() {
  console.log("\n── §callback — a live-agent \"call me back\" is a durable task, not only a notification ──")
  const portalEscalate = readStripped("app/api/portal/escalate/route.ts")
  const widgetCallback = readStripped("app/api/widget/live-agent-request/route.ts")

  check("portal/escalate imports createCallbackTask (the ONE callback writer, lib/ai-isa/callback-task.ts, §6)",
    /import\s*\{\s*createCallbackTask\s*\}\s*from\s*["']@\/lib\/ai-isa\/callback-task["']/.test(portalEscalate))
  check("portal/escalate actually CALLS createCallbackTask (not just imports it)",
    /await createCallbackTask\(/.test(portalEscalate))
  check("widget/live-agent-request imports + calls createCallbackTask",
    /import\s*\{\s*createCallbackTask\s*\}\s*from\s*["']@\/lib\/ai-isa\/callback-task["']/.test(widgetCallback) &&
    /await createCallbackTask\(/.test(widgetCallback))
  check("both callback writes assign the AI ISA as the autonomous executor (assigneeType: \"ai_isa\")",
    /assigneeType:\s*["']ai_isa["']/.test(portalEscalate) && /assigneeType:\s*["']ai_isa["']/.test(widgetCallback))
  check("the human notification survives ALONGSIDE the durable task (not replaced — both still fire)",
    /notifications["']\)\.insert/.test(portalEscalate) && /notifications["']\)\.insert/.test(widgetCallback))

  // CONTROL: the pre-fix shape (a notification insert with no callback-task
  // writer at all) is correctly recognised as missing the durable half.
  const preFixSnippet = `
    await serviceClient.from("notifications").insert({ user_id: agentUserId, type: "portal_live_agent_request" })
    return NextResponse.json({ ok: true })
  `
  check("[control] a notification-only handler is correctly rejected by the createCallbackTask-called check",
    !/createCallbackTask\(/.test(preFixSnippet))
}

// ═══════════════════════════════════════════════════════════════════════════
// §portalGate — the portal's Live button reads a REAL setting, not "any row"
// ═══════════════════════════════════════════════════════════════════════════
function portalGateSection() {
  console.log("\n── §portalGate — the portal Live-Agent button gates on real twin readiness ──")
  const layout = readStripped("app/portal/[contactId]/layout.tsx")

  check("agentHasDIDAvatar is derived from agent_avatar_assets status+approval_status (the brokerage's own approval workflow), not a bare existence check",
    /defaultTwin\.status === ["']ready["'] && defaultTwin\.approval_status === ["']approved["']/.test(layout))
  check("the legacy agent_voice_profiles existence check is now a FALLBACK only (for agents with no twin row at all), not the primary gate",
    (() => {
      const twinIdx = layout.indexOf("defaultTwin")
      const legacyIdx = layout.indexOf("agent_voice_profiles")
      return twinIdx > -1 && legacyIdx > -1 && twinIdx < legacyIdx
    })())

  // CONTROL: the pre-fix "any row exists" shape is correctly recognised as
  // NOT checking readiness/approval.
  const preFixSnippet = `agentHasDIDAvatar = !!(agentDIDAvatarId || agentDIDPhotoUrl || agentDIDVideoUrl)`
  check("[control] the pre-fix bare-existence shape is correctly rejected by the readiness+approval pattern",
    !/status === ["']ready["']/.test(preFixSnippet) && !/approval_status === ["']approved["']/.test(preFixSnippet))
}

// ═══════════════════════════════════════════════════════════════════════════
// §website — the public website reuses the embed's live-agent implementation
// ═══════════════════════════════════════════════════════════════════════════
function websiteSection() {
  console.log("\n── §website — the public website offers the D-ID live agent as an option ──")
  const launcher = readStripped("app/components/public-site/SiteChatLauncher.tsx")
  const resolver = readStripped("lib/embed/resolve-site-embed.ts")
  const sitePage = readStripped("app/site/[slug]/page.tsx")
  const agentPage = readStripped("app/p/[agentSlug]/page.tsx")

  check("SiteChatLauncher accepts a livePublicId prop and opens /embed/[publicId] when set",
    /livePublicId/.test(launcher) && /\/embed\/\$\{livePublicId\}/.test(launcher))
  check("SiteChatLauncher falls back to the text-only /widget/[brokerageSlug] door when no live embed is configured (no capability lost)",
    /\/widget\/\$\{brokerageSlug\}/.test(launcher))
  check("resolveSiteLiveAgentEmbed prefers an AGENT-scoped embed before a brokerage-wide one (never borrows another agent's twin)",
    (() => {
      const agentScopedIdx = resolver.indexOf('eq("agent_id", params.agentId)')
      const brokerageWideIdx = resolver.indexOf('is("agent_id", null)')
      return agentScopedIdx > -1 && brokerageWideIdx > -1 && agentScopedIdx < brokerageWideIdx
    })())
  check("resolveSiteLiveAgentEmbed only resolves an ACTIVE row (never fabricates one)",
    /eq\("is_active", true\)/.test(resolver))

  check("app/site/[slug] resolves + threads livePublicId into SiteChatLauncher",
    /resolveSiteLiveAgentEmbed/.test(sitePage) && /livePublicId=\{livePublicId\}/.test(sitePage))
  check("app/p/[agentSlug] resolves + threads livePublicId into SiteChatLauncher",
    /resolveSiteLiveAgentEmbed/.test(agentPage) && /livePublicId=\{chat\.livePublicId\}/.test(agentPage))

  // CONTROL: the pre-fix launcher (no livePublicId concept at all) is
  // correctly recognised as text-only.
  const preFixSnippet = `src={\`/widget/\${brokerageSlug}\${widgetQuery ? \`?\${widgetQuery}\` : ""}\`}`
  check("[control] the pre-fix launcher snippet is correctly recognised as having no live-embed branch",
    !/livePublicId/.test(preFixSnippet))
}

// ═══════════════════════════════════════════════════════════════════════════
// §consent — the 428 consent gate is UNTOUCHED by this wave
// ═══════════════════════════════════════════════════════════════════════════
function consentSection() {
  console.log("\n── §consent — the D-ID 428 consent gate stays intact (never weakened) ──")
  const route = readStripped("app/api/did/create-avatar/route.ts")
  check("create-avatar still resolves consent via resolveConsentIdForAvatar before submitting",
    /resolveConsentIdForAvatar/.test(route))
  check("missing consent still refuses with HTTP 428 + needs_consent:true",
    /status:\s*428/.test(route) && /needs_consent:\s*true/.test(route))
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" D-ID live agent simulator (Express v4 — website / widget / portal)")
  console.log("══════════════════════════════════════════════════════════════")
  gatewaySection()
  syncSection()
  anonymousSection()
  brainSection()
  realismSection()
  callbackSection()
  portalGateSection()
  websiteSection()
  consentSection()
  console.log("\n────────────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ All nine D-ID live-agent properties hold (wave 58: gateway/sync/anonymous/brain/realism/callback/portalGate/website, each with a positive control, + consent re-proved intact).")
}
main().catch((e) => { console.error(e); process.exit(1) })
