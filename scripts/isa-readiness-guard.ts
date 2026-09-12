/**
 * scripts/isa-readiness-guard.ts
 *
 * test:isa-readiness — "AI CALLING NOT CONFIGURED" MUST MEAN SOMETHING TRUE.
 *
 * Three ISA surfaces asked whether the brokerage could place an AI call, and
 * all three answered it by testing for a VAPI assistant id:
 *
 *   · app/dashboard/isa/page.tsx          — process.env.VAPI_ISA_ASSISTANT_ID
 *   · app/dashboard/voice/isa/page.tsx    — ai_identity_profiles.vapi_assistant_id
 *   · app/dashboard/isa/calling/page.tsx  — ai_identity_profiles.vapi_assistant_id
 *
 * VAPI IS RETIRED. VOICE_ENGINE is gone and placeOutboundAiCall never touches
 * it. So all three were false in both directions at once: a working Twilio
 * brokerage saw a red "VAPI Assistant Not Configured" alert claiming AI calling
 * was unavailable, and every CTA sent the agent to configure a vendor this OS
 * does not call. A dead banner wastes a glance; a banner that dispatches a
 * human to do pointless work costs them an afternoon.
 *
 * The rule this guard keeps: readiness is resolved ONCE, from the gates the
 * executor really enforces, and the copy names something the agent can act on.
 */
import { readFileSync, existsSync } from "node:fs"
import { describeIsaBlocker } from "../lib/voice/isa-readiness-copy"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
/** Comments stripped — an assertion must target CODE, never prose. */
const code = (p: string) =>
  stripComments(src(p))

const SURFACES = [
  "app/dashboard/isa/page.tsx",
  "app/dashboard/voice/isa/page.tsx",
  "app/dashboard/isa/calling/page.tsx",
]

console.log("\n═══ 1. No surface decides this for itself any more ═══")
{
  for (const p of SURFACES) {
    ok(`${p} resolves readiness from the shared helper`,
      code(p).includes("resolveIsaCallingReadiness("), p)
  }
  ok("the local `vapiConfigured` flag is gone from every one of them",
    SURFACES.every((p) => !/vapiConfigured/.test(code(p))))
}

console.log("\n═══ 2. The retired vendor is not consulted, named, or linked ═══")
{
  ok("no surface reads the VAPI env vars",
    SURFACES.every((p) => !/VAPI_API_KEY|VAPI_ISA_ASSISTANT_ID/.test(code(p))))
  ok("no surface SELECTs vapi_assistant_id",
    SURFACES.every((p) => !/vapi_assistant_id/.test(code(p))))
  // code(), not src(): the assertion is about what an AGENT READS, which lives
  // in JSX. Comments explaining the retired vendor are allowed to name it — and
  // targeting src() here failed on this guard's own sibling comments, the same
  // prose-vs-code trap that keeps catching assertions in this repo.
  ok("no surface still tells an agent to configure VAPI — the instruction that\n    sent them to provision a vendor this OS does not call",
    SURFACES.every((p) => !/Configure VAPI|VAPI Assistant Not Configured|VAPI is not configured/i.test(code(p))))

  const console_ = code("app/dashboard/isa/ai-isa-console-client.tsx")
  ok("the ISA console's dead `vapiNotConfigured` toast is gone — no route ever\n    returned that field, so it could never fire and pointed at VAPI anyway",
    !console_.includes("vapiNotConfigured"))
  ok("...and the executor's own precise refusal reaches the agent instead",
    console_.includes("data.error"))

  ok("the launch checklist no longer carries the vapi_legacy entry, which was\n    keyed to VOICE_ENGINE=vapi — a flag that no longer exists, so it could\n    never light up and only asked an operator to provision a dead vendor",
    !code("lib/platform/launch-checklist.ts").includes("vapi_legacy"))
}

console.log("\n═══ 3. Readiness mirrors the gates the executor really enforces ═══")
{
  const helper = code("lib/voice/isa-readiness.ts")
  const exec = code("lib/voice/twilio-outbound.ts")
  ok("the helper checks for an ACTIVE tenant number…", /tenant_phone_numbers[\s\S]{0,200}is_active/.test(helper))
  ok("…which is exactly what the executor's first hard stop is",
    /tenant_phone_numbers[\s\S]{0,300}"is_active", true/.test(exec) || /tenant_phone_numbers[\s\S]{0,300}is_active/.test(exec))
  ok("the helper resolves tenant Twilio creds through the SAME resolver the\n    executor uses, so the two can never disagree",
    helper.includes("resolveTenantTwilioCreds") && exec.includes("resolveTenantTwilioCreds"))
  ok("TCPA and vendor budget are NOT reported as readiness — they are\n    per-contact and per-moment, and a brokerage that can call is still\n    correctly refused for one person on the DNC list",
    !/tcpa|enforceTCPACompliance|checkVendorBudget/i.test(helper))
}

console.log("\n═══ 4. An unknown answer fails OPEN, not into a false alarm ═══")
{
  const helper = code("lib/voice/isa-readiness.ts")
  ok("a read failure reports READY rather than telling a working brokerage\n    their calling is broken — the executor is the real gate and refuses with\n    a precise reason, which is a far better failure than a lying banner",
    /catch \{[\s\S]{0,80}return ready\(null\)/.test(helper))
  ok("...while a missing brokerage is still an honest blocker",
    /if \(!brokerageId\) return ready\("no_brokerage"\)/.test(helper))
}

console.log("\n═══ 5. The copy names something the agent can actually do ═══")
{
  const no_number = describeIsaBlocker("no_number")
  ok("the no-number case sends them to connect a number",
    no_number.ctaHref === "/settings/phone" && !!no_number.ctaLabel)
  ok("...and explains WHY it needs one — calls show the agent's own line,\n    never a shared one, which is the caller-ID honesty rule behind it",
    /own to dial from|never a shared one/.test(no_number.reason ?? ""))

  const no_twilio = describeIsaBlocker("no_twilio")
  ok("the no-provider case is distinct from the no-number case, because the\n    fixes are different",
    no_twilio.reason !== no_number.reason)

  ok("no blocker mentions VAPI to the agent",
    (["no_brokerage", "no_number", "no_twilio", null] as const)
      .every((b) => !/vapi/i.test(describeIsaBlocker(b).reason ?? "")))
  ok("ready means no reason and no CTA — nothing to nag about",
    describeIsaBlocker(null).reason === null && describeIsaBlocker(null).ctaHref === null)
  ok("every blocker that CAN be self-served carries a CTA",
    (["no_number", "no_twilio"] as const).every((b) => !!describeIsaBlocker(b).ctaHref))
  ok("...and the one the agent cannot fix alone does NOT pretend they can",
    describeIsaBlocker("no_brokerage").ctaHref === null)
}

console.log("\n═══ 6. The console button reflects it before a click is spent ═══")
{
  const c = code("app/dashboard/isa/ai-isa-console-client.tsx")
  ok("the AI-call button is disabled when calling cannot run", /disabled=\{!callingReady\}/.test(c))
  ok("...with the reason on hover rather than a silent dead control",
    /title=\{callingReady \? undefined : callingBlockedReason/.test(c))
  ok("the prop is named for what it means, not for a vendor",
    c.includes("callingReady") && !c.includes("vapiConfigured"))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`ISA READINESS — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nAI calling readiness has ONE answer, resolved from the gates")
  console.log("placeOutboundAiCall really enforces. Do not reintroduce a VAPI test:")
  console.log("the voice lane is Twilio-native and never calls that vendor.")
  process.exit(1)
}
console.log("Every ISA surface answers 'can we call?' the same way, and the answer is true.")
