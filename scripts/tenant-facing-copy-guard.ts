#!/usr/bin/env tsx
/**
 * scripts/tenant-facing-copy-guard.ts — THE TENANT-FACING MESSAGE CONTRACT (wave 152, lane 152A). npm run test:tenant-facing-copy.
 *
 * Owner (verbatim, 2026-11-11): "the honest connection states need to be more tenant friendly along with any other tenant
 * faing errors, etc. the connections for tenant shouldn't say brokerage pays unless the tenant is a brokerage, etc.."
 *
 * The survivor is lib/errors/index.ts (the action error boundary, in the app/crm graph at its budget): ONE rule list
 * (TENANT_COPY_RULES via tenantCopyVerdict), ONE presenter (presentTenantMessage / presentTenantError /
 * presentTenantConnection), ONE payer resolver (resolveTenantPayer — the session tenant's own plan tier).
 *
 *   A  the GATE: one forged specimen per rule is refused (each finder's POSITIVE CONTROL), clean sentences pass, the relayed
 *      mode passes a plain refusal and refuses a database one, the payer rule admits a brokerage claim ONLY for a brokerage;
 *      lib/support/ticket-triage.ts tenantFacingGate answers exactly as the one list does, and its old local list is gone
 *      from STRIPPED source while the tombstone that names the survivor stays in the raw text (§2: a tombstone is not code);
 *   B  the PRESENTER contract: what · affects · work truth · next actor · ONE action · reference; a retry / tracked claim
 *      WITHOUT its evidence is dropped; a leaking input is replaced, never shown;
 *   C  SIX PERSONAS rendered (solo agent, independent team, one-office brokerage, multi-location staff, a Contact, an
 *      assigned vendor) from the payer the resolver reads off each tenant's own plan tier — role-neutral, payer-true, no
 *      brokerage wording outside a brokerage, no cost / credential line for a Contact or a vendor; an unreadable tier is
 *      actor-neutral (fail closed);
 *   D  the SURFACES this lane rewired, scanned on STRIPPED source (entities decoded): no brokerage-payer claim, no hard-coded
 *      phone price, no raw database error returned by the two connection action files; positive controls on each finder
 *      with the pre-fix specimens; the WIDER census of payer phrases in app/** is PUBLISHED (counted, not asserted);
 *   E  THE ACTION BOUNDARY: handleError / handleAction relay a plain refusal unchanged and replace a Postgres / RLS /
 *      JSON refusal with the contract sentence and a reference;
 *   F  THE OPERATION BELL (lib/kernel/immediate-operations.ts): "tracked" only with the ticket id that makes it true, and the
 *      side named is the side that answers (platform support only for a platform-visible subject); the ticket fallback no
 *      longer claims a repair that already failed;
 *   G  OWNERSHIP: a MAINTENANCE_DOMAINS row owns this proof; the script is registered and on the guard chain.
 *
 * BLIND SPOTS (published): D scans the surfaces this lane owns and rewired — the wider app census is a count, not a gate
 * (outside-lane files are listed in the lane notes); the gate reads text, it cannot judge whether a true-looking sentence is
 * true (the work-truth evidence in B is what enforces that); React renders are not executed — C renders the presenter's
 * strings, which is exactly what the server actions hand the components.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const ROOT = process.cwd()
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const decode = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&")

async function main() {
  const E = await import("../lib/errors")
  const brokeragePayer = { kind: "brokerage" as const }

  console.log("\nA — the gate: one rule list, a positive control per finder")
  const SPECIMENS: Array<[string, string]> = [
    ["a key-shaped string", "use sk_live_abc123"],
    ["a credential value", "Authorization: Bearer abcdefghijklmnop"],
    ["a provider / database internal", "PGRST204 on the insert"],
    ["a database refusal", "new row violates row-level security policy for table \"x\""],
    ["a stack frame", "failed at Object.run (/var/task/index.js:10:5)"],
    ["a source path", "see lib/providers/dormant-adapters.ts for details"],
    ["a provider HTTP status", "BatchData answered HTTP 401"],
    ["a raw response body", "{\"error\":\"bad request\"}"],
    ["an internal identifier (table, column, policy or field name)", "state pending_owner_licensing"],
    ["an environment / configuration name", "set SECRETS_ENCRYPTION_KEY in Production"],
    ["credential vocabulary", "the provider refused your token"],
    ["a price", "it costs $49 a month"],
    ["the platform-pays phrase", "this is platform-covered"],
    ["a brokerage-payer claim", "AI usage is billed to your brokerage"],
  ]
  for (const [why, specimen] of SPECIMENS) {
    const v = E.tenantCopyVerdict(specimen)
    check(`refuses ${why}: "${specimen}"`, !v.ok && (v as { reason: string }).reason === `contains ${why}`, JSON.stringify(v))
  }
  const CLEAN = [
    "Your invitation could not be sent — resend it from Users › Invitations.",
    "Open Settings → Integrations and reconnect the provider.",
    "Check the MLS connection under Settings and run the sync again.",
    "This connection needs to be updated. New data from BatchData is paused; saved records are unaffected.",
    "Invitations were sent to jane_doe@example.com.",
  ]
  check("clean sentences pass (including an email address with an underscore — not an internal identifier)", CLEAN.every((c) => E.tenantCopyVerdict(c).ok), CLEAN.filter((c) => !E.tenantCopyVerdict(c).ok).join(" | "))
  check("relayed mode: a plain refusal passes, a database refusal and a PGRST code are refused", E.tenantCopyVerdict("Address is required", { mode: "relayed" }).ok && !E.tenantCopyVerdict("duplicate key value violates unique constraint \"x_key\"", { mode: "relayed" }).ok && !E.tenantCopyVerdict("PGRST204", { mode: "relayed" }).ok)
  check("relayed mode does not police authored-copy rules (a price in a validation message is the caller's own text)", E.tenantCopyVerdict("Enter an amount under $500", { mode: "relayed" }).ok && !E.tenantCopyVerdict("Enter an amount under $500").ok)
  check("the payer rule admits a brokerage-payer claim ONLY when the verified payer IS a brokerage", E.tenantCopyVerdict("BatchData bills your brokerage's BatchData account directly.", { payer: brokeragePayer }).ok && !E.tenantCopyVerdict("BatchData bills your brokerage's BatchData account directly.", { payer: { kind: "team" } }).ok && !E.tenantCopyVerdict("BatchData bills your brokerage's BatchData account directly.").ok)
  const tt = await import("../lib/support/ticket-triage")
  const all = [...SPECIMENS.map(([, s]) => s), ...CLEAN, "", "   "]
  check("ticket-triage tenantFacingGate answers exactly as the one list (delegation, not a second list)", all.every((s) => tt.tenantFacingGate(s).ok === E.tenantCopyVerdict(s).ok))
  const triageRaw = read("lib/support/ticket-triage.ts")
  const triageStripped = stripComments(triageRaw)
  check("the old local forbidden list is gone from STRIPPED source and the gate delegates to tenantCopyVerdict", !/TENANT_FACING_FORBIDDEN/.test(triageStripped) && /return tenantCopyVerdict\(text, \{ mode: "authored" \}\)/.test(triageStripped))
  check("positive control: the tombstone naming the survivor is still in the RAW text (the stripped scan is what passes, not a missing comment)", /TOMBSTONE[\s\S]{0,200}TENANT_FACING_FORBIDDEN[\s\S]{0,400}lib\/errors\/index\.ts TENANT_COPY_RULES/.test(triageRaw))

  console.log("\nB — the presenter: the message contract, claims only with their evidence")
  const m1 = E.presentTenantMessage({ what: "Your report couldn't be saved", affects: "Your draft is still open", work: { state: "not_saved" }, next: "you", action: { label: "Try again" }, referenceId: "le-1234-abcd-ef" })
  check("composes what · affects · work · ONE action · reference (sentence form carries the action in words)", /^Your report couldn't be saved\. Your draft is still open\. Nothing was saved\. Next step: try again\. Reference: LE1234AB\.$/.test(m1.sentence) && m1.action?.label === "Try again" && m1.referenceId === "LE1234AB" && !m1.replaced, m1.sentence)
  const noRetry = E.presentTenantMessage({ what: "The provider didn't respond", work: { state: "retrying", retryRef: null }, next: "provider", provider: "BatchData" })
  const retry = E.presentTenantMessage({ what: "The provider didn't respond", work: { state: "retrying", retryRef: "job-77" }, next: "provider", provider: "BatchData" })
  check("a retry claim WITHOUT its retry reference is dropped; with one it is said", !/retry/i.test(noRetry.text) && /We'll retry automatically\./.test(retry.text), `${noRetry.text} || ${retry.text}`)
  const noTicket = E.presentTenantMessage({ what: "Billing activation needs your attention", work: { state: "ticket_open", ticketId: null, answeredBy: "platform_support" }, next: "you" })
  const platformTicket = E.presentTenantMessage({ what: "Billing activation needs your attention", work: { state: "ticket_open", ticketId: "tk-1", answeredBy: "platform_support" }, next: "you" })
  const officeTicket = E.presentTenantMessage({ what: "Invitation delivery needs your attention", work: { state: "ticket_open", ticketId: "tk-2", answeredBy: "account_admin" }, next: "you" })
  check("'tracked' only with a ticket id, naming the side that answers (platform support vs the account's own admins)", !/track/i.test(noTicket.text) && /Our support team is tracking it\./.test(platformTicket.text) && /tracked as a support request your account's admins can see/.test(officeTicket.text) && !/support team/i.test(officeTicket.text))
  const leak = E.presentTenantMessage({ what: "insert refused: new row violates row-level security policy for table \"platform_credentials\"", next: "platform_support", action: { label: "Try again" } })
  check("a leaking input is REPLACED (replaced: true) and the leak never reaches the text", leak.replaced && !/row-level|platform_credentials/.test(leak.sentence) && /didn't go through as expected/.test(leak.sentence), leak.sentence)
  check("positive control: the leaking input itself fails the gate", !E.tenantCopyVerdict("insert refused: new row violates row-level security policy for table \"platform_credentials\"").ok)
  const support = E.presentTenantMessage({ what: "We couldn't read the latest data", next: "platform_support", action: { label: "Contact support" } })
  check("'contact support' as the action is not said twice", (support.sentence.match(/contact support/gi) ?? []).length === 1, support.sentence)
  const err = E.presentTenantError({ what: "Your provider connections couldn't be loaded right now", raw: { message: "permission denied for table platform_credentials" }, work: { state: "unchanged" }, context: "guard" })
  check("presentTenantError: the raw refusal is logged (a reference minted), the person reads what + work + action + reference", /^Your provider connections couldn't be loaded right now\. Nothing was changed\. Next step: try again\. If it keeps happening, contact support\. Reference: [A-Z0-9]{8}\.$/.test(err.sentence) && !/permission denied/.test(err.sentence), err.sentence)

  console.log("\nC — six personas, rendered (payer read from each tenant's own plan tier)")
  const svc = memSupabase({ brokerages: [
    { id: "b-solo", plan_tier: "solo_agent" }, { id: "b-team", plan_tier: "team" }, { id: "b-brk", plan_tier: "brokerage" }, { id: "b-multi", plan_tier: "multi_location" }, { id: "b-null", plan_tier: null },
  ] } as never)
  const payerOf = async (id: string) => E.resolveTenantPayer(svc as never, id)
  const [solo, team, brk, multi, nul] = await Promise.all(["b-solo", "b-team", "b-brk", "b-multi", "b-null"].map(payerOf))
  const refused = await E.resolveTenantPayer({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "permission denied" } }) }) }) }) } as never, "b-brk")
  check("the resolver reads each tier's business kind (solo · team · brokerage · brokerage) and an unread / refused tier is unknown (fail closed)", solo.kind === "solo" && team.kind === "team" && brk.kind === "brokerage" && multi.kind === "brokerage" && nul.kind === "unknown" && refused.kind === "unknown" && (await E.resolveTenantPayer(svc as never, null)).kind === "unknown")
  const failure = (payer: typeof solo, audience: "account" | "contact" | "vendor") => E.presentTenantConnection({ provider: "BatchData", availability: "degraded", cause: "provider_refused", credentials: "this_account", cost: "your_provider_account", payer, audience })
  const personas: Array<{ who: string; payer: typeof solo; audience: "account" | "contact" | "vendor"; owner: RegExp | null; brokerageWord: boolean; nextLine: RegExp | null }> = [
    { who: "solo agent", payer: solo, audience: "account", owner: /bills your BatchData account directly/, brokerageWord: false, nextLine: null },
    { who: "independent team", payer: team, audience: "account", owner: /bills your team's BatchData account directly/, brokerageWord: false, nextLine: null },
    { who: "one-office brokerage", payer: brk, audience: "account", owner: /bills your brokerage's BatchData account directly/, brokerageWord: true, nextLine: null },
    { who: "multi-location staff", payer: multi, audience: "account", owner: /bills your brokerage's BatchData account directly/, brokerageWord: true, nextLine: null },
    { who: "Contact (client of a brokerage)", payer: brk, audience: "contact", owner: null, brokerageWord: false, nextLine: /Your agent can help with this\./ },
    { who: "assigned vendor (works with a team)", payer: team, audience: "vendor", owner: null, brokerageWord: false, nextLine: /The team you work with can help with this\./ },
  ]
  for (const p of personas) {
    const v = failure(p.payer, p.audience)
    const rendered = [v.label, v.message.text, v.message.sentence, v.credentialLine, v.costLine].filter(Boolean).join(" ")
    const ok = E.tenantCopyVerdict(rendered, { payer: p.payer }).ok
      && (p.owner ? p.owner.test(v.costLine ?? "") : v.costLine === null && v.credentialLine === null)
      && /\bbrokerage\b/i.test(rendered) === p.brokerageWord
      && (p.nextLine ? p.nextLine.test(v.message.text) && !/BatchData/.test(rendered) && v.message.action === null : /Next step: update connection\./.test(v.message.sentence))
      && v.label === "Needs attention" && !/connected and confirmed/i.test(rendered)
    check(`${p.who}: role-neutral, payer-true, gate-clean${p.audience !== "account" ? ", no provider name / cost / credential line / account button" : ""}`, ok, rendered)
  }
  const att = (payer: typeof solo) => E.tenantProviderAttestation("BatchData", payer)
  check("the connect attestation is payer-true: 'my account' / 'my team' / 'my brokerage' — never 'my brokerage' for a solo agent, a team or an unread tier", /for my account\./.test(att(solo)) && /for my team\./.test(att(team)) && /for my brokerage\./.test(att(brk)) && /for my account\./.test(att(nul)) && ![solo, team, nul].some((p) => /brokerage/.test(att(p))))
  const unknownCost = failure(nul, "account").costLine ?? ""
  check("an unknown payer reads actor-neutral ('your BatchData account'), never a guessed brokerage", /bills your BatchData account directly/.test(unknownCost) && !/brokerage/.test(unknownCost), unknownCost)

  console.log("\nD — the rewired surfaces (stripped source, entities decoded)")
  const PAYER = /\b(?:brokerage (?:pays|will pay|is paying)|(?:billed|charged|invoiced) to (?:your |the |my )?brokerage|(?:your|the|my) brokerage(?:'s)? (?:is |will be )?(?:billed|charged|invoiced)\b|bills? (?:your|the|my) brokerage|payer:?\s*(?:<strong>)?\s*(?:your |the |my )?brokerage|paid by (?:your|the|my) brokerage|on (?:my|your) brokerage's behalf)/i
  const SURFACES = [
    "app/dashboard/settings/usage/page.tsx",
    "app/dashboard/admin/phone-settings/phone-settings-client.tsx",
    "app/dashboard/settings/integrations/lead-sources/acquisition-providers-panel.tsx",
    "app/dashboard/settings/integrations/lead-sources/lead-sources-client.tsx",
    "app/dashboard/settings/integrations/lead-sources/page.tsx",
    "app/actions/tenant-connections.ts",
    "app/actions/tenant-sso.ts",
    "lib/platform/provider-posture.ts",
    "lib/providers/tenant-provider-connections.ts",
    "lib/kernel/immediate-operations.ts",
    "lib/support/ticket-triage.ts",
  ]
  const payerHits = SURFACES.flatMap((f) => decode(stripComments(read(f))).split("\n").map((l, i) => ({ f, i: i + 1, l })).filter((x) => PAYER.test(x.l)).map((x) => `${x.f}:${x.i}`))
  check(`no brokerage-payer claim on the ${SURFACES.length} rewired surfaces (${payerHits.length} found)`, payerHits.length === 0, payerHits.join(", "))
  const PRE_FIX = ["AI, voice and storage consumption is billed to your brokerage, so the meter is", "\"~$1.15/mo per number, billed to brokerage. Agents get a number on signup.\"", "authorize this OS to call it on my brokerage&apos;s behalf. The provider bills my brokerage directly", "Cost payer: <strong>your brokerage</strong> (never the platform)"]
  check("positive control: every pre-fix payer sentence is caught by the same finder", PRE_FIX.every((s) => PAYER.test(decode(s))))
  const PHONE_PRICE = /~?\$\d+(?:\.\d+)?\/mo per number/
  check("the phone page no longer hard-codes a per-number price (the allowance it reads is the truth)", !PHONE_PRICE.test(stripComments(read("app/dashboard/admin/phone-settings/phone-settings-client.tsx"))) && PHONE_PRICE.test(PRE_FIX[1]))
  const rawReturn = /return\s*\{[^}]*\berror:\s*(?:(?:error|err|[a-z]+Err)\??\.message\b|`[^`]*\$\{(?:error|err|[a-z]+Err)\??\.message\}[^`]*`)/
  const rawHits = ["app/actions/tenant-connections.ts", "app/actions/tenant-sso.ts"].flatMap((f) => stripComments(read(f)).split("\n").map((l, i) => ({ f, i: i + 1, l })).filter((x) => rawReturn.test(x.l)).map((x) => `${x.f}:${x.i}`))
  check(`the two connection action files return no raw database error to the person (${rawHits.length} found)`, rawHits.length === 0, rawHits.join(", "))
  check("positive control: the raw-error finder flags the pre-fix shapes", rawReturn.test("if (error) return { ok: false, error: error.message }") && rawReturn.test("return { ok: false, error: `connections could not be read: ${error.message}` }"))
  const panel = decode(stripComments(read("app/dashboard/settings/integrations/lead-sources/acquisition-providers-panel.tsx")))
  check("the panel renders the presenter's view (label, message, credential and cost lines) and spells no state label or payer of its own", /p\.view\.label/.test(panel) && /p\.view\.message\.text/.test(panel) && /p\.view\.credentialLine/.test(panel) && /p\.view\.costLine/.test(panel) && /p\.attestation/.test(panel) && !/STATE_LABEL|Pending owner licensing|Unsupported \(no transport\)|pricingNote|lastHealth/.test(panel))
  check("the panel never offers a scheduled pull as if it runs (daily / weekly say 'not running yet')", /Daily pull — not running yet/.test(panel) && /Weekly pull — not running yet/.test(panel) && !/>Daily poll<|>Weekly poll</.test(panel))
  // The WIDER census (published, not asserted): payer phrases in app/** outside the rewired surfaces.
  const { readdirSync, statSync } = await import("node:fs")
  const walk = (d: string): string[] => readdirSync(join(ROOT, d)).flatMap((n) => { const p = `${d}/${n}`; const s = statSync(join(ROOT, p)); return s.isDirectory() ? (n === "node_modules" ? [] : walk(p)) : /\.tsx?$/.test(n) ? [p] : [] })
  const wider = walk("app").filter((f) => !SURFACES.includes(f)).flatMap((f) => decode(stripComments(read(f))).split("\n").map((l, i) => ({ f, i: i + 1, l })).filter((x) => PAYER.test(x.l)).map((x) => `${x.f}:${x.i}`))
  console.log(`  · census (published, not asserted): ${wider.length} payer-phrase line(s) elsewhere in app/** — ${wider.join(", ") || "none"}`)

  console.log("\nE — the action boundary (handleError / handleAction)")
  const quiet = console.error
  console.error = () => {}
  try {
    const r1 = E.handleError({ message: "new row violates row-level security policy for table \"platform_credentials\"" }, "guard")
    const r2 = E.handleError(new Error("Address is required"), "guard")
    const r3 = E.handleError({ code: "23505" }, "guard")
    const r4 = await E.handleAction(async () => { throw new Error("relation \"open_houses\" does not exist") }, "guard")
    const r5 = await E.handleAction(async () => 7, "guard")
    check("a Postgres / RLS refusal is REPLACED with the contract sentence and a reference", /^This didn't finish because of a problem on our side\. Next step: try again\. If it keeps happening, contact support\. Reference: [A-Z0-9]{8}\.$/.test(r1.error) && !/row-level|platform_credentials/.test(r1.error), r1.error)
    check("a plain validation refusal passes UNCHANGED (the boundary never degrades a good message)", r2.error === "Address is required", r2.error)
    check("a JSON-stringified error object is replaced (a raw response body never reaches the person)", !/23505|"code"/.test(r3.error) && /Reference:/.test(r3.error), r3.error)
    check("handleAction: the same rule on the thrown path; success untouched", !r4.success && !/open_houses|does not exist/.test((r4 as { error: string }).error) && r5.success && (r5 as { data: number }).data === 7, JSON.stringify(r4))
  } finally { console.error = quiet }

  console.log("\nF — the operation bell: 'tracked' only with the ticket that makes it true")
  const io = await import("../lib/kernel/immediate-operations")
  const bus = memSupabase({ support_tickets: [], notifications: [], users: [] } as never, { uuidIds: true, stampCreatedAt: true })
  const bells: string[] = []
  const notifyOrg = async (_s: unknown, _b: string, n: { body: string }) => { bells.push(n.body); return 1 }
  const sig = (platform_visible: boolean) => ({ id: "sig-f", entityType: "user_invitations", entityId: "inv-1", payload: { operation: "invitation", readiness_keys: [], tenant_facing: "Invitation delivery did not verify — the email never left", platform_visible } })
  const ctx = { brokerageId: "11111111-1111-4111-8111-111111111111", supabase: bus }
  await io.handleOperationFailureEscalated(sig(false), ctx, { notifyOrg, notifyStaff: async () => 1, openTicket: async () => ({ ticketId: null, created: false, error: "refused" }) })
  await io.handleOperationFailureEscalated(sig(false), ctx, { notifyOrg, notifyStaff: async () => 1, openTicket: async () => ({ ticketId: "tk-9", created: true, error: null }) })
  await io.handleOperationFailureEscalated(sig(true), ctx, { notifyOrg, notifyStaff: async () => 1, openTicket: async () => ({ ticketId: "tk-10", created: true, error: null }) })
  check("no ticket → the bell claims nothing is tracked; an account-lane ticket → 'tracked … your account's admins'; a platform-visible ticket → 'Our support team is tracking it'", bells.length === 3 && !/track|support team/i.test(bells[0]) && /tracked as a support request your account's admins can see/.test(bells[1]) && !/support team/i.test(bells[1]) && /Our support team is tracking it\./.test(bells[2]), JSON.stringify(bells))
  const ioSrc = stripComments(read("lib/kernel/immediate-operations.ts"))
  check("the bell never promises 'Our support team has the details' ahead of a ticket (stripped source)", !/has the details/.test(ioSrc) && /presentTenantMessage\(\{ what: body0, work: \{ state: "ticket_open", ticketId, answeredBy \}/.test(ioSrc))
  const t = await tt.ensureOperationTicket(bus, { brokerageId: ctx.brokerageId, operation: "phone_a2p", tenantFacing: "registration refused: api key sk_live_abc rejected", platformVisible: false })
  const tk = ((bus as unknown as { tables: Record<string, Array<Record<string, any>>> }).tables.support_tickets ?? []).find((r) => r.id === t.ticketId)
  check("the ticket fallback no longer says the OS 'is checking and repairing it' after the repair already failed", !!tk && /did not verify, and the automatic re-check could not fix it\./.test(String(tk.description)) && !/checking and repairing/.test(String(tk.description)), String(tk?.description ?? t.error))

  console.log("\nG — ownership and the chain")
  const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
  const owner = Object.entries(MAINTENANCE_DOMAINS).find(([, d]) => (d as { proof: string }).proof === "test:tenant-facing-copy")
  check("a MAINTENANCE_DOMAINS row owns test:tenant-facing-copy (data_steward)", !!owner && (owner[1] as { manager: string }).manager === "data_steward", owner?.[0] ?? "none")
  const pkg = read("package.json")
  check("registered and on the guard chain", /"test:tenant-facing-copy":\s*"tsx[^"]*scripts\/tenant-facing-copy-guard\.ts"/.test(pkg) && /npm run test:tenant-facing-copy\b/.test(pkg))

  console.log(`\nTENANT-FACING COPY — RESULT: ${passed} passed, ${failed} failed ${failed === 0 ? "✅ TENANT_FACING_COPY_PASS" : "❌ TENANT_FACING_COPY_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error("tenant-facing-copy guard crashed:", e); process.exit(1) })
