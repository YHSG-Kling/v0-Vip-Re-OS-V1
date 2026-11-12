#!/usr/bin/env tsx
/**
 * scripts/platform-live-agent-guard.ts   (npm run test:platform-live-agent)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 77B — owner verbatim: "the platform should also offer the same ai
 * agents like the live agent using d-id because the platform can use those ai
 * agents as a demo'd product."
 *
 * The platform-facing D-ID Express v4 live agent on /get-started and /demo
 * rides the SAME machinery the tenant live agent (wave 58/59) runs — one
 * custom-LLM route, one D-ID Agent builder/create/patch path, one presenter
 * detector, one metering row, one widget — and the SAME brain the platform
 * phone line and web chat already run (buildPlatformReceptionPrompt +
 * platformReceptionTools + the platform playbook). What differs is ONLY the
 * identity: the platform's own presenter on the brand kit, the platform's own
 * (showcase) brokerage for metering, and an honest "yes, I'm an AI".
 *
 * Every code-token scan reads STRIPPED source (scripts/strip-comments.ts —
 * CLAUDE.md §2; the platform modules carry tombstones and JSDoc naming the
 * very tokens scanned) and every absence assertion has a positive control.
 *
 *   Layer 1  — strip-comments positive control.
 *   Layer 2  — ONE ENGINE: exactly one buildPlatformReceptionPrompt and one
 *              buildPlatformProspectTools definition in lib/ + app/; the
 *              custom-LLM platform branch, the chat route and the voice
 *              branch all call those two (three doors, one brain). Positive
 *              control: a fixture with a second definition reads 2.
 *   Layer 3  — PLATFORM BRAND, NOT A TENANT'S: the platform branch resolves
 *              the platform context (brokerageId null) and never the tenant
 *              brand voice / contact / embed loaders (the tenant branch does —
 *              the scanner discriminates).
 *   Layer 4  — PROSPECT TOOLS ONLY: no BatchData / RentCast / customer-care
 *              bundle on the platform branch; the two new capabilities
 *              (start_subscription, show_product_demo) are registered on the
 *              ONE bundle and the playbook's exit menu ⊆ registered tools.
 *   Layer 5  — MARKER DISCIPLINE: a third marker, resolved to an ACTIVE row
 *              under the platform's own brokerage; mixed markers refused; the
 *              widget sends only the platform marker under deployment=platform.
 *   Layer 6  — CONSENT GATE UNTOUCHED: create-avatar still resolves + refuses
 *              with 428; consent.ts still exports its four functions; no
 *              platform module imports the consent write path or writes a
 *              twin row.
 *   Layer 7  — PLATFORM PRESENTER NEVER A TENANT'S: the presenter lives on
 *              platform_settings.product_brand.liveAgent; the D-ID agent is
 *              cached there through the explicit cache seam; the metering
 *              brokerage is the is_demo showcase tenant, never a body value;
 *              the credential is the platform's (PLATFORM_PROVIDER_KEYS.did →
 *              DID_API_KEY through the one gateway).
 *   Layer 8  — HONEST AI + COST POSTURE: the platform baseline says it is an
 *              AI; the demo tool never renders or calls a model; a clip is a
 *              pre-rendered URL only on a visual surface; the session route is
 *              throttled.
 *   Layer 9  — SURFACES: one widget (deployment prop), mounted on /get-started
 *              and /demo, gated server-side; the cron patches the platform
 *              agent too.
 *   Layer 10 — registration.
 *
 * No DB, no network. Run:
 *   npx tsx --conditions=react-server scripts/platform-live-agent-guard.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { walkTs } from "./runtime-roots"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const root = process.cwd()
const raw = (p: string): string => readFileSync(join(root, p), "utf8")
const stripped = (p: string): string => stripComments(raw(p))

const CUSTOM_LLM = "app/api/did/custom-llm/route.ts"
const PLATFORM_AGENT = "lib/did/platform-live-agent.ts"
const SESSION_ROUTE = "app/api/platform/live-agent/session/route.ts"
const AGENTS = "lib/did/agents.ts"
const RECEPTION = "lib/voice/platform-reception.ts"
const TOOLS = "lib/platform/prospect-agent-tools.ts"
const BRAND = "lib/platform/product-brand.ts"
const DEMO = "lib/platform/product-demo.ts"
const WIDGET = "app/embed/[publicId]/embed-widget.tsx"
const WRAPPER = "app/get-started/platform-live-agent.tsx"
const CHAT_ROUTE = "app/api/platform/prospect-chat/route.ts"
const TWILIO = "lib/voice/twilio-voice.ts"
const CREATE_AVATAR = "app/api/did/create-avatar/route.ts"
const CONSENT = "lib/did/consent.ts"

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · strip-comments positive control]")
const agentSrc = stripped(PLATFORM_AGENT)
check("a comment-only phrase is ABSENT from stripped platform-live-agent.ts (the scanner sees comments)", !agentSrc.includes("WHAT IS DELIBERATELY DIFFERENT"))
check("a real code token from the same file IS present (the scanner did not eat the code)", agentSrc.includes("export async function ensurePlatformDIDAgent"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · ONE ENGINE — one prompt builder, one tool bundle, three doors]")
const runtimeFiles = [...walkTs(join(root, "lib")), ...walkTs(join(root, "app"))]
const PROMPT_DEF = /function\s+buildPlatformReceptionPrompt\s*\(/g
const BUNDLE_DEF = /function\s+buildPlatformProspectTools\s*\(/g
let promptDefs = 0, bundleDefs = 0
const promptFiles: string[] = [], bundleFiles: string[] = []
for (const f of runtimeFiles) {
  const rel = f.replace(root + "/", "")
  const s = blankStrings(stripComments(readFileSync(f, "utf8")))
  const p = (s.match(PROMPT_DEF) ?? []).length
  const b = (s.match(BUNDLE_DEF) ?? []).length
  if (p > 0) { promptDefs += p; promptFiles.push(rel) }
  if (b > 0) { bundleDefs += b; bundleFiles.push(rel) }
}
check(`exactly ONE buildPlatformReceptionPrompt definition in lib/ + app/ (found ${promptDefs}: ${promptFiles.join(", ")})`, promptDefs === 1 && promptFiles[0] === RECEPTION)
check(`exactly ONE buildPlatformProspectTools definition in lib/ + app/ (found ${bundleDefs}: ${bundleFiles.join(", ")})`, bundleDefs === 1 && bundleFiles[0] === TOOLS)
check("POSITIVE CONTROL: a fake second `export function buildPlatformReceptionPrompt(` in a fixture reads 2 (the counter is not blind)",
  ((blankStrings(stripComments(raw(RECEPTION) + "\nexport function buildPlatformReceptionPrompt(x: number) { return x }")).match(PROMPT_DEF) ?? []).length) === 2)

const llmSrc = stripped(CUSTOM_LLM)
// The platform function body ONLY: from its declaration to its column-0
// closing brace (the tenant loaders are declared further down the file and
// must not be swept into this slice).
const platformStart = llmSrc.indexOf("async function handlePlatformTurn(")
const platformBody = llmSrc.slice(platformStart, llmSrc.indexOf("\n}\n", platformStart) + 3)
const tenantBody = llmSrc.slice(llmSrc.indexOf("export async function POST("))
check("custom-llm has a platform branch (handlePlatformTurn) that precedes the tenant POST body", platformBody.length > 200 && tenantBody.length > 200)
check("the platform branch builds its prompt with buildPlatformReceptionPrompt({ … channel: \"live\" })", /buildPlatformReceptionPrompt\(\{[\s\S]{0,400}channel: "live"/.test(platformBody))
check("the platform branch mounts platformReceptionTools({ source: \"web:live_agent\", phone: null, prospectId: null … }) — server-resolved identity, nothing from the payload", /platformReceptionTools\(\{[\s\S]{0,200}source: "web:live_agent", phone: null, prospectId: null, callId: null/.test(platformBody))
check("the platform branch carries the ONE tool guidance wording (PLATFORM_PROSPECT_TOOL_GUIDANCE)", platformBody.includes("PLATFORM_PROSPECT_TOOL_GUIDANCE"))
check("the chat route and the voice platform branch call the SAME two survivors (three doors, one brain)",
  stripped(CHAT_ROUTE).includes("buildPlatformReceptionPrompt({") && stripped(CHAT_ROUTE).includes("platformReceptionTools({") &&
  /deployment === "platform"[\s\S]{0,2500}buildPlatformReceptionPrompt\(\{[\s\S]{0,1500}platformReceptionTools\(\{/.test(stripped(TWILIO)))
check("ONE SSE writer for both deployments (streamAsOpenAiSse defined once, called from both branches)",
  (llmSrc.match(/function streamAsOpenAiSse\(/g) ?? []).length === 1 && (llmSrc.match(/streamAsOpenAiSse\(/g) ?? []).length === 3)
check("the tenant deployment's own marker gate is untouched (`!markerContactId && !embedSessionId` still refuses a markerless turn)", /!markerContactId && !embedSessionId/.test(tenantBody))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · PLATFORM BRAND — never a tenant's]")
check("the platform branch resolves the PLATFORM context (resolvePlatformReceptionContext) and books the model call with brokerageId: null", platformBody.includes("resolvePlatformReceptionContext(") && /brokerageId: null/.test(platformBody))
const TENANT_LOADERS = ["loadBrandVoicePrompt(", "loadContactContext(", "loadEmbedContext(", 'from("contacts")', 'from("embed_sessions")', "loadBrandPlaybookContext("]
for (const t of TENANT_LOADERS) check(`the platform branch never calls the tenant loader ${t}`, !platformBody.includes(t))
check("POSITIVE CONTROL: the tenant branch DOES call loadBrandVoicePrompt( and loadContactContext( (the scanner discriminates)", tenantBody.includes("loadBrandVoicePrompt(") && tenantBody.includes("loadContactContext("))
check("the platform context itself loads the platform brand with brokerageId null (lib/voice/platform-reception.ts)", /loadBrandPlaybookContext\(\{ brokerageId: null \}\)/.test(stripped(RECEPTION)))
check("the live channel prompt says what it is — an AI, the same live agent every subscriber gets — and that it demos the product", /channel === "live"[\s\S]{0,600}You are an AI and say so if asked/.test(stripped(RECEPTION)) && stripped(RECEPTION).includes("YOU ARE ALSO THE DEMO"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · PROSPECT TOOLS ONLY]")
const TENANT_TOOLS = ["batchDataIsaTools(", "rentCastMcpTools(", "buildCustomerFreeTools(", "selectToolsForPersona(", "filterRentCastToolsForPersona("]
for (const t of TENANT_TOOLS) check(`the platform branch never mounts ${t}`, !platformBody.includes(t))
check("POSITIVE CONTROL: the tenant branch DOES mount batchDataIsaTools( and buildCustomerFreeTools(", tenantBody.includes("batchDataIsaTools(") && tenantBody.includes("buildCustomerFreeTools("))
const { PLATFORM_PROSPECT_TOOL_NAMES, platformExitMenuMatchesTools, PLATFORM_PROSPECT_TOOL_GUIDANCE } = await import("../lib/platform/prospect-agent-tools")
const { PLATFORM_EXIT_MENU, buildQualificationPrompt } = await import("../lib/ai-isa/qualification-playbook")
const toolsSrc = stripped(TOOLS)
check("start_subscription and show_product_demo are on the ONE bundle (PLATFORM_PROSPECT_TOOL_NAMES) and registered as tool({…})",
  (PLATFORM_PROSPECT_TOOL_NAMES as readonly string[]).includes("start_subscription") && (PLATFORM_PROSPECT_TOOL_NAMES as readonly string[]).includes("show_product_demo") &&
  /\bstart_subscription:\s*tool\(\{/.test(toolsSrc) && /\bshow_product_demo:\s*tool\(\{/.test(toolsSrc))
check("every PLATFORM_EXIT_MENU tool is registered (playbook wording ↔ tools) and start_subscription is an exit", platformExitMenuMatchesTools() && PLATFORM_EXIT_MENU.some((o) => o.tool === "start_subscription"))
check("the platform prompt names start_subscription and the guidance names show_product_demo (one wording)", buildQualificationPrompt({ surface: "platform_reception" }).includes("start_subscription") && PLATFORM_PROSPECT_TOOL_GUIDANCE.includes("show_product_demo"))
check("the bundle's source union carries the live-agent door ('web:live_agent')", /"phone:reception" \| "web:prospect_chat" \| "web:live_agent"/.test(toolsSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · MARKER DISCIPLINE — a third marker, resolved fail-closed]")
// Re-anchored wave 79 (lane E): builder + regex moved to the pure marker module so
// the widget (client) and the route (server) share ONE grammar.
const { PLATFORM_LIVE_CTX_RE, platformLiveSessionMarker } = await import("../lib/did/context-markers")
const sampleId = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"
PLATFORM_LIVE_CTX_RE.lastIndex = 0
const m = PLATFORM_LIVE_CTX_RE.exec(`${platformLiveSessionMarker(sampleId)} hello`)
PLATFORM_LIVE_CTX_RE.lastIndex = 0
check("the platform marker round-trips (platformLiveSessionMarker → PLATFORM_LIVE_CTX_RE)", m?.[1] === sampleId)
check("[control] the platform marker regex does NOT match a tenant embed marker", (PLATFORM_LIVE_CTX_RE.lastIndex = 0, !PLATFORM_LIVE_CTX_RE.test(`[[CTX:embedSessionId=${sampleId}]]`)))
PLATFORM_LIVE_CTX_RE.lastIndex = 0
check("custom-llm extracts platformLiveSessionId and refuses a payload that mixes it with a tenant marker", llmSrc.includes("platformLiveSessionId") && llmSrc.includes("conflicting context markers"))
check("the platform branch REFUSES (403) a marker that does not resolve (resolvePlatformLiveSession → null)", /resolvePlatformLiveSession\([\s\S]{0,200}if \(!session\) return NextResponse\.json\([^)]*status: 403/.test(platformBody))
check("resolvePlatformLiveSession accepts ONLY an ACTIVE row under the platform's own brokerage (a tenant's embed row can never be replayed as a platform turn)",
  /row\.status !== "active" \|\| row\.brokerage_id !== platformBrokerageId/.test(agentSrc))
const widgetSrc = stripped(WIDGET)
check("the widget has a deployment prop and posts the platform boot to /api/platform/live-agent/session", /deployment\?: EmbedDeployment/.test(widgetSrc) && widgetSrc.includes('"/api/platform/live-agent/session"'))
check("under deployment=platform the widget sends ONLY the platform marker (never contactId/embedSessionId)",
  // wave 79 (lane E): the widget calls the shared builders instead of re-spelling the
  // markers — the literal grammar is asserted once, on lib/did/context-markers.ts below
  /isPlatform\s*\?\s*platformLiveSessionMarker\(sessionIdRef\.current\)\s*:\s*embedSessionMarker\(sessionIdRef\.current\)/.test(widgetSrc) &&
  /import \{[^}]*platformLiveSessionMarker[^}]*\} from "@\/lib\/did\/context-markers"/.test(widgetSrc) &&
  !/CTX:platformLiveSessionId=|CTX:embedSessionId=|CTX:contactId=/.test(widgetSrc) &&
  /if \(contactId && !ctxMarkerSentRef\.current && !isPlatform\)/.test(widgetSrc))
check("under deployment=platform the widget never runs the tenant lead-capture form (the agent's save_prospect captures)", /leadCaptureMode === "immediate" && !isPlatform/.test(widgetSrc) && /leadCaptureMode === "after_first_message" && !contactId && !isPlatform/.test(widgetSrc))
check("the platform fail-over is the EXISTING text prospect chat (ProspectChat), never a dead avatar bubble", /if \(bootError && isPlatform\)[\s\S]{0,900}<ProspectChat brandName=\{label\} \/>/.test(widgetSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · CONSENT GATE UNTOUCHED]")
const createAvatar = stripped(CREATE_AVATAR)
check("create-avatar still resolves consent for the source type (resolveConsentIdForAvatar(supabase, agentRow.id, source_type))", createAvatar.includes("resolveConsentIdForAvatar(supabase, agentRow.id, source_type)"))
check("…and still REFUSES with HTTP 428 + needs_consent: true when none exists", /if \(!consentId\)[\s\S]{0,600}status: 428/.test(createAvatar) && /needs_consent:\s*true/.test(createAvatar))
check("…and still trusts no caller-supplied consent_id", !createAvatar.includes("body?.consent_id"))
const consentSrc = stripped(CONSENT)
for (const fn of ["mintConsent", "uploadConsentVideo", "findVerifiedConsent", "resolveConsentIdForAvatar"]) {
  check(`lib/did/consent.ts still exports ${fn}`, new RegExp(`export async function ${fn}\\(`).test(consentSrc))
}
const platformModules: Array<[string, string]> = [[PLATFORM_AGENT, agentSrc], [SESSION_ROUTE, stripped(SESSION_ROUTE)], [BRAND, stripped(BRAND)], ["custom-llm platform branch", platformBody]]
for (const [name, s] of platformModules) {
  check(`${name}: never imports the consent write path / create-avatar and never writes a twin row (agent_avatar_assets / agent_voice_profiles)`,
    !/lib\/did\/consent|did\/create-avatar|resolveConsentIdForAvatar|mintConsent/.test(s) && !/from\("agent_avatar_assets"\)|from\("agent_voice_profiles"\)/.test(s))
}
check("POSITIVE CONTROL: the tenant embed session route DOES read agent_avatar_assets (the twin-row scanner discriminates)", /from\("agent_avatar_assets"\)/.test(stripped("app/api/embed/session/route.ts")))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 7 · PLATFORM PRESENTER — the brand kit's, metered under the platform's own brokerage]")
const { resolveProductBrand, resolveProductLiveAgent, DEFAULT_PRODUCT_LIVE_AGENT } = await import("../lib/platform/product-brand")
const { presenterTypeForTwin } = await import("../lib/did/agent-presenter")
check("the presenter lives on product_brand.liveAgent (platform_settings) — default NOT configured (presenterId null)", resolveProductBrand({}).liveAgent.presenterId === null && DEFAULT_PRODUCT_LIVE_AGENT.presenterId === null)
check("a stock D-ID Expressive presenter (`name@avt_…`) is accepted and resolves to the V4 family through the ONE detector (presenterTypeForTwin)",
  resolveProductLiveAgent({ presenterId: "public_mia_elegant@avt_TJ0Tq5" }).presenterId === "public_mia_elegant@avt_TJ0Tq5" && presenterTypeForTwin("public_mia_elegant@avt_TJ0Tq5") === "expressive")
check("a garbage presenter id / a non-https clip URL fall back field by field (never the whole block)",
  resolveProductLiveAgent({ presenterId: "bad id!", demoClipUrl: "http://insecure/clip.mp4", name: "Guide" }).presenterId === null &&
  resolveProductLiveAgent({ presenterId: "bad id!", demoClipUrl: "http://insecure/clip.mp4", name: "Guide" }).demoClipUrl === null &&
  resolveProductLiveAgent({ presenterId: "bad id!", demoClipUrl: "http://insecure/clip.mp4", name: "Guide" }).name === "Guide")
check("the brand editor's merge-write keeps liveAgent (setProductBrandAction spreads current over input)", /resolveProductBrand\(\{ \.\.\.current, \.\.\.input \}\)/.test(stripped("app/actions/superadmin/platform-brand.ts")))
check("ensurePlatformDIDAgent goes through the ONE create path with deployment \"platform\" and the explicit cache seam (never a twin/agent cache)",
  /ensureDIDAgent\(\{[\s\S]{0,300}deployment: "platform"[\s\S]{0,300}cache: platformDidAgentCache\(svc\)/.test(agentSrc))
const agentsSrc = stripped(AGENTS)
check("lib/did/agents.ts honours the cache seam on read AND write and keeps ONE body builder for both deployments",
  /if \(params\.cache\) \{\s*const cached = await params\.cache\.read\(\)/.test(agentsSrc) && /if \(params\.cache\) \{\s*await params\.cache\.write\(didAgentId\)/.test(agentsSrc) &&
  (agentsSrc.match(/function buildAgentBody\(/g) ?? []).length === 1 && (agentsSrc.match(/buildAgentBody\(\{/g) ?? []).length === 2)
check("the platform cache reads/writes product_brand on platform_settings — a MERGE, never a tenant row", /from\("platform_settings"\)\.select\("id, product_brand"\)/.test(agentSrc) && agentSrc.includes("liveAgent: { ...current.liveAgent, didAgentId }"))
check("the metering brokerage is the is_demo showcase tenant (findDemoBrokerage → .eq(\"is_demo\", true)), server-resolved", agentSrc.includes("findDemoBrokerage(svc)") && /\.eq\("is_demo", true\)/.test(stripped("lib/platform/demo-tenant.ts")))
const sessionSrc = stripped(SESSION_ROUTE)
check("the session route meters through the ONE metering writer under that brokerage (startLiveAgentSession({ brokerageId, surface: \"site\" …))", /startLiveAgentSession\(\{ brokerageId, surface: "site", didAgentId: ensured\.didAgentId \}/.test(sessionSrc))
check("the session route trusts NOTHING tenant-shaped from the body (no body.brokerageId / body.publicId / body.presenterId)", !/body\??\.(brokerageId|publicId|presenterId|twinId)/.test(sessionSrc))
check("POSITIVE CONTROL: the body scanner recognises a body-supplied tenant on a fixture", /body\??\.(brokerageId|publicId|presenterId|twinId)/.test("const b = body?.brokerageId"))
const { PLATFORM_PROVIDER_KEYS } = await import("../lib/agentic-os/connector-probe")
check("the credential is the platform's: PLATFORM_PROVIDER_KEYS.did → DID_API_KEY, read by the ONE gateway agents.ts imports", PLATFORM_PROVIDER_KEYS.did === "DID_API_KEY" && /process\.env\.DID_API_KEY/.test(stripped("lib/did/gateway.ts")) && /import\s*\{\s*didRequest\s*\}\s*from\s*["']\.\/gateway["']/.test(agentsSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 8 · HONEST AI + COST POSTURE]")
check("the platform D-ID baseline says it IS an AI and says so when asked (never the tenant's 'never say you are an AI' line)", /PLATFORM_LIVE_INSTRUCTIONS[\s\S]{0,400}say yes — you are the product/.test(agentsSrc))
check("the custom-llm platform branch DERIVES its spoken-delivery rules from the one realism directive minus rule 3 (no second restatement)", /SPOKEN_REALISM_DIRECTIVE\s*\.split\("\\n"\)\s*\.filter\(\(line\) => !\/\^3\\\.\/\.test\(line\)\)/.test(llmSrc))
const { describeProductDemo, splitDemoClipToken, PRODUCT_DEMO_TOPICS } = await import("../lib/platform/product-demo")
const demoSrc = stripped(DEMO)
check("product-demo.ts never renders, never calls a model, never fetches (no generateTextRouted / streamTextRouted / didRequest / fetch)", !/generateTextRouted|streamTextRouted|didRequest|fetch\(/.test(demoSrc))
const catalogue = [{ id: "record_qualification", label: "Record what's been learned", usefulFor: "x" }, { id: "schedule_callback", label: "Call them back later", usefulFor: "y" }]
const shown = describeProductDemo("reception_isa", { brandName: "Acme OS", tierBullets: ["a", "b"], clipUrl: "https://cdn.example.com/demo.mp4", surfaceCanShowClip: true }, catalogue)
const voice = describeProductDemo("reception_isa", { brandName: "Acme OS", clipUrl: "https://cdn.example.com/demo.mp4", surfaceCanShowClip: false }, catalogue)
const noClip = describeProductDemo("bogus", { brandName: "Acme OS", clipUrl: null, surfaceCanShowClip: true }, catalogue)
check("a clip token is returned ONLY on a visual surface with an https clip configured; voice gets none; an unknown topic falls back to overview",
  shown.clipToken === "[[CLIP:https://cdn.example.com/demo.mp4]]" && voice.clipToken === null && noClip.clipToken === null && noClip.topic === "overview" && /offer the live demo/.test(noClip.ifNoClip))
check("the walkthrough is grounded in the injected catalogue labels (never a second spelling) and the live plan bullets", shown.capabilities.some((c) => c.label === "Record what's been learned") && shown.planHighlights.join(",") === "a,b")
check("splitDemoClipToken extracts the clip and strips the token from the spoken text", splitDemoClipToken("Here it is. [[CLIP:https://cdn.example.com/demo.mp4]]").clipUrl === "https://cdn.example.com/demo.mp4" && splitDemoClipToken("Here it is. [[CLIP:https://cdn.example.com/demo.mp4]]").text === "Here it is.")
check("every demo topic has a script", PRODUCT_DEMO_TOPICS.every((t) => describeProductDemo(t, { brandName: "x", surfaceCanShowClip: false }, []).walkthrough.length >= 2))
check("show_product_demo passes surfaceCanShowClip = not-the-phone-line and the brand kit's clip (never a new render)", /surfaceCanShowClip: ctx\.source !== "phone:reception"/.test(toolsSrc) && toolsSrc.includes("clipUrl: ctx.brand.liveAgent.demoClipUrl"))
check("the widget plays the clip only under deployment=platform and only from the agent's token", /isPlatform && demoClipUrl && \(/.test(widgetSrc) && widgetSrc.includes("splitDemoClipToken(raw)"))
check("the session route is throttled through the shared public limiter", /checkPublicRateLimit\("platform-live-agent"/.test(sessionSrc) && sessionSrc.includes("publicCallerIp("))
check("every session-route refusal carries the text fallback (never a dead avatar)", (sessionSrc.match(/fallback: FALLBACK/g) ?? []).length >= 6)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 9 · SURFACES — one widget, two pages, gated server-side; the cron patches the platform agent]")
const wrapperSrc = stripped(WRAPPER)
check("the platform wrapper mounts the ONE widget with deployment=\"platform\" and never talks to the D-ID SDK itself", /<EmbedWidget[\s\S]{0,80}deployment="platform"/.test(wrapperSrc) && !wrapperSrc.includes("@d-id/client-sdk"))
const sdkFiles = runtimeFiles.filter((f) => blankStrings(stripComments(readFileSync(f, "utf8"))).includes("createAgentManager(")).map((f) => f.replace(root + "/", ""))
check(`no new D-ID SDK client implementation (createAgentManager call sites: ${sdkFiles.join(", ")})`, !sdkFiles.includes(WRAPPER) && sdkFiles.includes(WIDGET))
for (const page of ["app/get-started/page.tsx", "app/demo/page.tsx"]) {
  const s = stripped(page)
  check(`${page} mounts <PlatformLiveAgent gated on a presenter + the showcase brokerage (server-resolved)`, s.includes("<PlatformLiveAgent") && s.includes("resolvePlatformLiveAgentBrokerageId(svc)") && /liveAgentAvailable = !!brand\.liveAgent\.presenterId && !!platformBrokerageId/.test(s))
}
check("the wrapper renders nothing when not available (never offers a live agent that cannot mint)", /if \(!available\) return null/.test(wrapperSrc))
check("the did-agent-sync cron PATCHes the platform agent too (deployment \"platform\", brand-kit cache)", /syncDIDAgent\(\{[\s\S]{0,300}deployment: "platform"/.test(stripped("app/api/cron/did-agent-sync/route.ts")))
check("the brand card lets platform staff set the presenter / voice / greeting / clip (no code change to configure)", stripped("app/dashboard/superadmin/growth/brand-topics-card.tsx").includes("liveAgent: { ...brand.liveAgent, presenterId:"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 10 · registration]")
const pkg = raw("package.json")
check(`"test:platform-live-agent" script is registered`, /"test:platform-live-agent":\s*"tsx --conditions=react-server scripts\/platform-live-agent-guard\.ts"/.test(pkg))
const guardLine = /"guard":\s*"([^"]+)"/.exec(pkg)?.[1] ?? ""
check("the guard chain runs it AFTER test:scrapers (wave 77 ruling: new proofs append after test:scrapers)", guardLine.indexOf("npm run test:scrapers") >= 0 && guardLine.indexOf("npm run test:platform-live-agent") > guardLine.indexOf("npm run test:scrapers"))
check("MAINTENANCE_DOMAINS carries platform_live_agent with proof test:platform-live-agent", /platform_live_agent:\s*\{\s*manager:\s*"[a-z_]+",\s*proof:\s*"test:platform-live-agent"/.test(stripped("lib/kernel/manager-registry.ts")))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ PLATFORM_LIVE_AGENT — see failures above")
  process.exit(1)
}
console.log("\n✅ PLATFORM_LIVE_AGENT — one engine, platform brand, prospect tools only, consent gate untouched, platform presenter never a tenant's")
