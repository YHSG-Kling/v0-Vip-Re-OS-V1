#!/usr/bin/env tsx
/**
 * scripts/capability-contract-simulator.ts (npm run test:capability-contract)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MCP TOOL LIST ADVERTISED 27 CAPABILITIES AND VOUCHED FOR NONE OF THEM.
 *
 * buildFullActionManifest powers /api/agentic-os/actions AND the MCP
 * `tools/list`. It answered ONE question — who is AUTHORIZED (scope) — and left
 * the other unanswered: can this actually RUN for this tenant?
 *
 * Those are different questions. A caller can hold `finance:write` while the
 * tenant has no QuickBooks connected at all. So every connected agent — the voice
 * admin included — saw all 27 app capabilities as available and could only learn
 * otherwise BY CALLING ONE AND WATCHING IT FAIL. An autonomous agent that
 * discovers its own limits by breaking things is the opposite of what a broker
 * needs before switching autonomy on.
 *
 * This is the first slice of the capability CONTRACT: each capability declares
 * what it needs, a resolver evaluates it against the tenant using the machinery
 * that already exists, and the discovery endpoint reports `operable` and `dark`
 * WITH REASONS beside `authorized`.
 *
 * ── PHASE 2: THE CONTRACTS WERE ASSERTED AGAINST THE WRONG EVIDENCE ────────
 * Phase 1 declared four contracts and left eight capabilities on an honest
 * backlog. Two of its choices were wrong, and both were wrong in the direction
 * that makes a readiness mechanism useless:
 *
 *   1. It checked platform lanes against platform_credentials ROWS. Every
 *      dispatcher in the app gates on an ENV KEY instead — dispatchDirectMail on
 *      LOB_API_KEY, messagingSendEmail on SENDGRID_API_KEY, getRentcastComps on
 *      RENTCAST_API_KEY. So a platform with Lob configured and direct mail
 *      sending fine reported direct_mail_send DARK.
 *   2. It filed video_distribute against the D-ID render key. D-ID RENDERS a
 *      video; it does not distribute one. distributeVideo's real branches write
 *      a social_posts row or enqueue an email — the DELIVERY lanes, exactly as
 *      the owner's ruling says (video is not a channel; it is delivered in an
 *      email or an sms).
 *
 * Six of the eight are now declared, each against the gate the code actually
 * hits. The remaining two stay on the backlog for a reason no amount of work
 * removes: their dependency is not a credential. gift_send needs a VENDOR ROW
 * (and already degrades to a task when there is none); handwritten_note_send has
 * no delivery lane at all — a human writes and posts it.
 *
 * Phase 2 also stops asking the readiness question a second way. The app already
 * had one resolver for "can this brokerage use this provider" —
 * resolveBrokerageReadinessState — which folds the tenant's own credential, the
 * platform env key and keyless lanes into one state. The capability resolver now
 * ASKS it instead of reimplementing it, so the manifest and the readiness board
 * cannot drift.
 *
 * And it reports the SELF-HEALING state the OS already tracks: a capability that
 * is dark while connector-healer has an open repair says "being repaired", and
 * one that is operable on a lapsing token says so BEFORE the outage.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  APP_CAPABILITY_REGISTRY,
  UNDECLARED_REQUIREMENTS,
  buildFullActionManifest,
  type AppCapability,
} from "../lib/agentic-os/app-capability-registry"
import { CONNECTOR_PROVIDERS } from "../lib/connections/scope"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")

console.log("══════════════════════════════════════════════════")
console.log(" Capability contract — a capability states what it needs, or is held")
console.log("══════════════════════════════════════════════════")

const CAPS = Object.keys(APP_CAPABILITY_REGISTRY) as AppCapability[]

console.log("\n[every declared requirement names a REAL provider]")
{
  // A contract naming a provider the Connection OS does not offer is worse than
  // no contract: it reports a capability permanently dark for a reason nobody can
  // action. Connection names must come from CONNECTOR_PROVIDERS.
  const known = new Set(Object.values(CONNECTOR_PROVIDERS).flat())
  check(`the Connection OS offers ${known.size} providers`, known.size > 0)

  const badConnections: string[] = []
  for (const c of CAPS) {
    for (const p of APP_CAPABILITY_REGISTRY[c].requires?.connections ?? []) {
      if (!known.has(p)) badConnections.push(`${c}→${p}`)
    }
  }
  check("no capability requires a provider the Connection OS does not offer",
    badConnections.length === 0, badConnections.join(", "))

  // Platform lanes must not be things a tenant CONNECTS AN ACCOUNT to — a social
  // profile or a podcast host is the tenant's own, and showing "waiting on the
  // platform" for one sends a broker looking for a button that does not exist.
  //
  // But a provider CAN legitimately be both, and provider-posture models exactly
  // that with ProviderScope 'both': Twilio resolves a per-actor credential first
  // and falls back to the platform TWILIO_* keys, so inbox_reply_send names it in
  // BOTH lists on purpose. The rule is about account-owned surfaces, not overlap.
  const ACCOUNT_OWNED = new Set([...CONNECTOR_PROVIDERS.social, ...CONNECTOR_PROVIDERS.podcast])
  const miscategorised: string[] = []
  for (const c of CAPS) {
    for (const p of APP_CAPABILITY_REGISTRY[c].requires?.platform ?? []) {
      if (ACCOUNT_OWNED.has(p)) miscategorised.push(`${c}→${p}`)
    }
  }
  check("a tenant's own ACCOUNT (social/podcast) is never claimed as a platform lane",
    miscategorised.length === 0, miscategorised.join(", "))

  check("a declared requirement is never empty (that would read as 'no dependency')",
    CAPS.every((c) => {
      const r = APP_CAPABILITY_REGISTRY[c].requires
      return !r || (r.connections?.length ?? 0) + (r.platform?.length ?? 0) > 0
    }))
}

console.log("\n[the honest backlog stays visible]")
{
  // THE BACKLOG IS EMPTY. It held two capabilities whose dependency looked
  // unassertable; the owner's rulings settled both — a handwritten note runs the
  // POSTCARD line (Lob), and a gift with no vendor row still delivers a real AI
  // recommendation with Etsy vendors from the Gift Studio's own composer, so it
  // needs nothing external at all. The array is pinned EMPTY rather than deleted:
  // the next capability added without a contract has to come through here.
  check("the backlog is EMPTY — every capability states what it needs",
    UNDECLARED_REQUIREMENTS.length === 0,
    [...UNDECLARED_REQUIREMENTS].join(", "))
  check("…and every entry, if one is ever re-added, must be a real capability",
    UNDECLARED_REQUIREMENTS.every((c) => CAPS.includes(c)))

  // A capability cannot be both "declared" and "not modelled" — that ambiguity is
  // how a backlog turns into false confidence.
  const both = UNDECLARED_REQUIREMENTS.filter((c) => !!APP_CAPABILITY_REGISTRY[c].requires)
  check("nothing is both declared AND on the backlog", both.length === 0, both.join(", "))

  console.log(`  · ${UNDECLARED_REQUIREMENTS.length} of ${CAPS.length} capabilities have an unmapped dependency`)
  const declared = CAPS.filter((c) => !!APP_CAPABILITY_REGISTRY[c].requires)
  console.log(`  · ${declared.length} declare one: ${declared.join(", ")}`)
  const free = CAPS.filter((c) =>
    !APP_CAPABILITY_REGISTRY[c].requires &&
    !(UNDECLARED_REQUIREMENTS as readonly string[]).includes(c))
  console.log(`  · ${free.length} run on the kernel alone`)
  check("the three sets partition the registry exactly",
    declared.length + UNDECLARED_REQUIREMENTS.length + free.length === CAPS.length)
}

console.log("\n[the resolver is never optimistic]")
{
  const r = src("lib/agentic-os/resolve-app-capability.ts")
  check("the resolver exists", r.length > 0)
  check("a not-modelled dependency resolves to HELD, never to ready",
    // Order-insensitive: the two fields may sit either way round on one line.
    /operable: false[\s\S]{0,120}?requirement_not_modelled/.test(r) ||
    /requirement_not_modelled[\s\S]{0,120}?operable: false/.test(r))
  check("a failed readiness scan fails CLOSED (undefined readiness → not ready)",
    /if \(!readiness\) return false/.test(r))
  check("…and says so in a comment, because failing open here is the whole bug",
    /Fails CLOSED/.test(r))
  check("it reuses the EXISTING connection resolver rather than a second probe path",
    /from "@\/lib\/integrations\/connection-manager"/.test(r))
  check("…and asks the CANONICAL readiness resolver for platform lanes instead of inventing one",
    /getBrokerageProviderReadiness/.test(r) && !/from\("platform_credentials"\)/.test(r))
  check("…and mirrors the connected-capability resolver's shape",
    /operable/.test(r) && /missing/.test(r) && /satisfiedBy/.test(r))
  check("a tenant-fixable block is distinguished from a platform-only one",
    /no_connection/.test(r) && /no_platform_credential/.test(r))
  check("the platform-only explanation tells the broker there is nothing to do",
    /nothing for you to do/.test(r))
  check("it never throws — a probe failure is an honest verdict, not a 500",
    /Never throws/.test(r))
}

console.log("\n[discovery reports OPERABLE beside AUTHORIZED]")
{
  const route = src("app/api/agentic-os/actions/route.ts")
  check("the discovery endpoint resolves capability readiness",
    /resolveAllAppCapabilities/.test(route))
  check("…reports which actions are operable", /operable/.test(route))
  check("…and which are dark, WITH the reason and what is missing",
    /dark/.test(route) && /reason/.test(route) && /missing/.test(route))
  check("…and omits them rather than guessing when there is no brokerage context",
    /\.\.\.\(operable \? \{ operable, dark, expiring \} : \{\}\)/.test(route))
  check("…reports EXPIRING capabilities too — operable today, dark next week",
    /expiring/.test(route) && /attentionExplanation/.test(route))
  check("…and marks a dark capability the healer is already repairing",
    /healing: r\.healingInFlight/.test(route))
  check("authorized is still reported — scope and readiness are separate answers",
    /authorized: authorizedActions/.test(route))
}

console.log("\n[every declaration is grounded in the gate the code ACTUALLY hits]")
{
  // The rule that keeps this honest: a contract is only allowed to name a
  // provider that the executing path really refuses without. Each pairing below
  // is the dispatcher line that was READ, not a guess about which vendor fits.
  const GROUNDING: Array<{ cap: AppCapability; provider: string; file: string; gate: RegExp }> = [
    { cap: "direct_mail_send",   provider: "lob",      file: "lib/providers/dispatch.ts",   gate: /process\.env\.LOB_API_KEY/ },
    { cap: "newsletter_send",    provider: "sendgrid", file: "lib/providers/messaging/index.ts", gate: /process\.env\.SENDGRID_API_KEY/ },
    { cap: "review_request_send",provider: "sendgrid", file: "lib/providers/messaging/index.ts", gate: /process\.env\.SENDGRID_API_KEY/ },
    { cap: "cma_generate",       provider: "rentcast", file: "lib/property/rentcast.ts",     gate: /process\.env\.RENTCAST_API_KEY/ },
  ]
  for (const g of GROUNDING) {
    const declared = APP_CAPABILITY_REGISTRY[g.cap].requires?.platform ?? []
    check(`${g.cap} requires ${g.provider} — and ${g.file} really gates on its key`,
      (declared as readonly string[]).includes(g.provider) && g.gate.test(src(g.file)))
  }

  // The two phase-1 mistakes, pinned so neither can come back.
  const video = APP_CAPABILITY_REGISTRY.video_distribute.requires
  check("video_distribute is NOT filed against a render provider (D-ID renders; it does not distribute)",
    !(video?.platform ?? []).some((p) => ["did", "elevenlabs", "heygen"].includes(p)))
  check("…it names the DELIVERY lanes instead — social accounts or the email lane",
    (video?.connections?.length ?? 0) > 0 && (video?.platform ?? []).includes("sendgrid"))
  check("…matching distributeVideo's real branches (social_posts row / email_queue)",
    /social_posts/.test(src("app/actions/video/distribute-video.ts")) &&
    /email_queue/.test(src("app/actions/video/distribute-video.ts")))
  check("direct_mail_send + video_distribute are off the backlog now that they are grounded",
    !(UNDECLARED_REQUIREMENTS as readonly string[]).includes("direct_mail_send") &&
    !(UNDECLARED_REQUIREMENTS as readonly string[]).includes("video_distribute"))

  // ── The owner's two rulings, pinned ──────────────────────────────────────
  // "handwritten notes run the same line as a postcard or card" → the direct-mail
  // lane, same Lob gate as direct_mail_send. NOT a human errand.
  check("handwritten_note_send requires the direct-mail lane, like a postcard",
    (APP_CAPABILITY_REGISTRY.handwritten_note_send.requires?.platform ?? []).includes("lob"))
  check("…and it really dispatches there rather than stamping itself sent",
    /dispatchDirectMail/.test(src("app/actions/reputation-kernel.ts")) &&
    /pieceType:\s*"postcard"/.test(src("app/actions/reputation-kernel.ts")))
  check("…with the same platform gate direct_mail_send names",
    (APP_CAPABILITY_REGISTRY.direct_mail_send.requires?.platform ?? []).join() ===
    (APP_CAPABILITY_REGISTRY.handwritten_note_send.requires?.platform ?? []).join())

  // "when the gift send has no gifting vendor row, ai makes a suggestion of the
  // gift and a selection of etsy vendors within the task" → the Gift Studio's
  // composer already did this, so gift_send needs NOTHING external.
  check("gift_send declares no external requirement — the AI picks are in-repo",
    !APP_CAPABILITY_REGISTRY.gift_send.requires)
  const giftAdapter = src("lib/workflow/adapters/send-gift.ts")
  check("…and the no-vendor path runs the STUDIO composer, not a generic search",
    /composeGiftSelections/.test(giftAdapter) && /mineGiftInterests/.test(giftAdapter))
  check("…putting ETSY vendor links for each pick on the agent's task",
    /Etsy vendors: \$\{s\.etsyUrl\}/.test(giftAdapter))
  check("…grounded in the contact's own file, not one link for every client",
    /life_events/.test(giftAdapter) && /ai_insights/.test(giftAdapter) &&
    /pastGiftKeys/.test(giftAdapter))
  check("…and the occasion vocabularies are mapped, since the step offers one the studio does not",
    /normalizeGiftOccasion/.test(giftAdapter) && /just_because/.test(giftAdapter))
  check("the generic keyword search survives ONLY as the zero-picks floor",
    /selections\.length === 0[\s\S]{0,200}?composeShoppableLinks/.test(giftAdapter))

  // The SMS sibling: a machine channel must be dispatched, not declared sent.
  check("an SMS thank-you note routes through dispatchSms",
    /dispatchSms/.test(src("app/actions/reputation-kernel.ts")))
  check("…and records failed with the provider's reason when it is refused",
    /status:\s*sms\.success \? "sent" : "failed"/.test(src("app/actions/reputation-kernel.ts")))

  // ── THE AFFORDANCE FOLLOWS THE LANE ──────────────────────────────────────
  // A previous pass pinned "Mark Sent (SMS)" / "Mark Sent (Handwritten)" as the
  // honest wording, on the reading that a human delivered both. The owner settled
  // it the other way: sms goes through dispatchSms and a handwritten note "runs
  // the same line as a postcard or card". Both are machine channels now, so
  // "Mark Sent" would be the dishonest wording — it would understate a real send.
  const repPanel = src("app/components/reputation/ReputationPanel.tsx")
  check("every channel's button promises a real send, because every channel does one",
    /Send Email/.test(repPanel) && /Send Text/.test(repPanel) && /Mail Card/.test(repPanel) &&
    !/Mark Sent/.test(repPanel))
  check("…and the confirmation names the lane it actually went down",
    /Note sent via email/.test(repPanel) && /Text sent/.test(repPanel) &&
    /Card sent to print & mail/.test(repPanel))
  check("the Copy affordance survives — an agent may still want the draft",
    /copy\(tyDraft, "ty"\)/.test(repPanel))
}

console.log("\n[ANY-of spans BOTH kinds — the phase-1 early return is gone]")
{
  const r = src("lib/agentic-os/resolve-app-capability.ts")
  // Phase 1: `if (req.connections?.length) { ...; return no_connection }` — the
  // platform block below it was unreachable for any capability declaring both.
  check("a declared platform lane is still checked after the connections loop misses",
    /if \(req\.platform\?\.length\)/.test(r) &&
    !/return \{[^}]*reason: "no_connection"[\s\S]{0,200}?\n  \/\/ Platform-owned/.test(r))
  check("…and at least one capability really declares both, so the path is exercised",
    CAPS.some((c) => {
      const q = APP_CAPABILITY_REGISTRY[c].requires
      return (q?.connections?.length ?? 0) > 0 && (q?.platform?.length ?? 0) > 0
    }))
  check("the final verdict names the lane the TENANT can act on when there is one",
    /const tenantActionable/.test(r))
}

console.log("\n[it is built ON the self-healing, not beside it]")
{
  const r = src("lib/agentic-os/resolve-app-capability.ts")
  check("expiry comes from the connectivity agent, not a second expiry rule",
    /deriveConnectivityStatus/.test(r) && /needsAttention/.test(r) &&
    !/EXPIRY_WARNING_DAYS \* /.test(r))
  check("a live-but-lapsing connection is reported as needing attention",
    /attention: needsAttention\(status\)/.test(r))
  check("…which requires the expiry to exist on a resolved connection at all",
    /tokenExpiresAt/.test(src("lib/integrations/connection-manager.ts")))
  check("a dark capability the healer is repairing says so instead of 'not connected'",
    /healingInFlight/.test(r) && /being repaired automatically/.test(r))
  check("…and reads the healer's own queue (status='pending', the auto-applier's)",
    /connector_healing_proposals/.test(r) && /"pending"/.test(r) &&
    /\.eq\("status", "pending"\)/.test(src("lib/agentic-os/connector-auto-applier.ts")))
  check("resolving all 27 costs ONE readiness scan and ONE healing read, not 27 of each",
    /Promise\.all\(\[\s*\n?\s*safeReadiness/.test(r) && /shared: CapabilityResolutionContext/.test(r))
}

console.log("\n[there is ONE env-presence answer]")
{
  const posture = src("lib/platform/provider-posture.ts")
  check("the canonical env-presence helper exists", /export function platformEnvConfigured/.test(posture))
  check("…and returns null (not false) when a provider has no env home at all",
    /if \(vars\.length === 0\) return null/.test(posture))
  check("…derived from the canonical registry, so it knows EVERY var for a provider",
    /getPlatformProviderRegistry\(\)/.test(posture) && /envVarsByProvider/.test(posture))
  check("…and the readiness scan uses that one expression rather than its own",
    (posture.match(/envPresence\(/g) ?? []).length >= 3)
  check("PLATFORM_PROVIDER_KEYS still feeds it — lob/did/elevenlabs were already mapped",
    /PLATFORM_PROVIDER_KEYS/.test(posture) &&
    /lob: "LOB_API_KEY"/.test(src("lib/agentic-os/connector-probe.ts")))
}

console.log("\n[the inbox reply that was never sent]")
{
  // inbox_reply_send could not honestly declare a lane while its own code called
  // no dispatcher: it inserted a messages row with status 'sent' and stopped, so
  // the agent saw a sent reply and the client received nothing.
  const comms = src("lib/kernel/communications.ts")
  check("sendInboxReply now dispatches email through the real lane",
    /dispatchEmail\(/.test(comms))
  check("…tries the agent's OWN connected mailbox first, like the sequence adapter",
    /sendPersonalEmail/.test(comms))
  check("…dispatches sms rather than declaring it sent", /dispatchSms\(/.test(comms))
  check("…and records status from the DISPATCH RESULT, never unconditionally",
    /status: dispatched \? "sent" : "failed"/.test(comms))
  check("…returning the provider's reason so the agent learns it did not go",
    /success: false,\s*\n\s*messageId: msg\.id/.test(comms))
  check("portal/chat stays in-app — an in-app message IS delivered by being stored",
    /channel === "portal"/.test(comms))
  check("inbox_reply_send can therefore declare its lanes honestly",
    !!APP_CAPABILITY_REGISTRY.inbox_reply_send.requires?.platform?.length &&
    !!APP_CAPABILITY_REGISTRY.inbox_reply_send.requires?.connections?.length)
}

console.log("\n[a human can see it too, not only the MCP tool list]")
{
  // The contract answered only to machines. The same tenant could read "7/7
  // providers" on screen while the MCP tool list quietly withheld eight
  // capabilities — two surfaces, two stories. One resolver now feeds both.
  const panel = src("app/dashboard/system/components/os/agent-capability-panel.tsx")
  check("the capability panel exists", panel.length > 0)
  check("…and reads the SAME resolver the discovery endpoint uses",
    /resolveAllAppCapabilities/.test(panel))
  check("…showing runnable, expiring and held-back counts",
    /Runnable now/.test(panel) && /Expiring soon/.test(panel) && /Held back/.test(panel))
  check("…grouping what is dark by WHOSE move it is",
    /Repairing/.test(panel) && /Connect/.test(panel) && /Not lit/.test(panel) && /Held/.test(panel))
  check("…and never renders a bare 'unavailable' where the healer is mid-repair",
    /healingInFlight/.test(panel) && /blockExplanation/.test(panel))
  check("it is actually rendered — a panel nobody mounts is not a surface",
    /AgentCapabilityPanel/.test(src("app/dashboard/system/page.tsx")) &&
    /AgentCapabilityPanel/.test(src("app/dashboard/system/components/os/index.ts")))
  check("…on a broker/admin surface, not an agent one",
    /\['admin', 'broker', 'superadmin'\]/.test(src("app/dashboard/system/page.tsx")))
  check("Provider Health still answers the PROVIDER question — the two are not merged",
    /getBrokerageProviderReadiness/.test(src("app/dashboard/system/components/os/provider-health-panel.tsx")))
}

console.log("\n[the manifest itself is unchanged in shape]")
{
  // The contract must not break existing consumers: the MCP route maps this
  // manifest to tools, and the scraper simulator asserts against it.
  const manifest = buildFullActionManifest()
  check("the manifest still builds", manifest.length > 0)
  check("…still covers every app capability",
    CAPS.every((c) => manifest.some((a) => a.kind === "app" && a.capability === c)))
  check("…and every entry still carries the fields consumers read",
    manifest.every((a) => !!a.action && !!a.verb && !!a.scope && typeof a.mutates === "boolean"))
  check("package.json wires this proof", /test:capability-contract/.test(src("package.json")))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ CAPABILITY_CONTRACT_FAIL"); process.exit(1) }
console.log(" ✅ CAPABILITY_CONTRACT_PASS — nothing is advertised ready without evidence")
