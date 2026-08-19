#!/usr/bin/env tsx
/**
 * scripts/mail-unsubscribe-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the direct-mail opt-out lane the owner's ruling demands:
 *
 *   "there should be someway for the contact or lead can be traced back to their
 *    direct mail campaign to unsubscribe."
 *
 * Three properties, each proved rather than asserted:
 *
 *   (a) A TOKEN RESOLVES TO EXACTLY ONE RECIPIENT — including after the folding
 *       a human typing off paper needs (case, hyphens, O-for-0, I/L-for-1).
 *       Proved over a 5,000-token corpus minted by the SAME scheme the m493
 *       generator uses, so the folding cannot collapse two real tokens.
 *   (b) A BAD OR ABSENT TOKEN IS REFUSED — malformed, unminted, empty, null,
 *       truncated, over-long, and out-of-alphabet, none of which resolve.
 *   (c) THE MAIL CHANNEL REACHES THE SUPPRESSION THE DISPATCHER READS — checked
 *       against the live source of lib/providers/dispatch.ts dispatchDirectMail,
 *       lib/lead-intent/lead-opt-out.ts and lib/kernel/compliance/check-suppression.ts,
 *       so a rename in any of them fails this simulator instead of silently
 *       unbinding every mail opt-out.
 *
 * Plus the parity that makes (a) meaningful at all: the alphabet and length in
 * the m493 migration's generator and in lib/direct-mail/unsubscribe-token.ts must
 * be byte-for-byte identical. A drift there makes the database mint tokens the
 * application rejects as malformed — which presents to a user as "the printed
 * unsubscribe code does not work", the exact defect this lane exists to remove.
 *
 * Pure + shell-runnable. No database, no network, no mocks of our own code —
 * the token functions are the real ones and the wiring checks read real source.
 *
 * Run: npx tsx scripts/mail-unsubscribe-simulator.ts   (npm run test:mail-unsubscribe)
 */
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  MAIL_UNSUB_ALPHABET,
  MAIL_UNSUB_TOKEN_LENGTH,
  normalizeMailUnsubToken,
  isMailUnsubTokenShaped,
  formatMailUnsubTokenForPrint,
  buildMailUnsubscribeUrl,
  mailOptOutPrintLine,
} from "../lib/direct-mail/unsubscribe-token"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function section(title: string) { console.log(`\n[${title}]`) }
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ Mail opt-out verified — a printed token resolves to exactly one")
  console.log("    recipient, junk is refused, and the write lands where dispatchDirectMail reads.")
  console.log(" MAIL_UNSUBSCRIBE_PASS")
  process.exit(0)
}

const ROOT = process.cwd()
function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
}

/** Mirrors the m493 generator exactly: one CSPRNG byte per char, reduced mod 32. */
function mintToken(): string {
  const b = randomBytes(MAIL_UNSUB_TOKEN_LENGTH)
  let out = ""
  for (let i = 0; i < MAIL_UNSUB_TOKEN_LENGTH; i++) {
    out += MAIL_UNSUB_ALPHABET[b[i]! % 32]
  }
  return out
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Direct-mail per-recipient opt-out simulator")
  console.log("══════════════════════════════════════════════════")

  // ── THE ALPHABET ──────────────────────────────────────────────────────────
  section("alphabet — it has to survive being read off print")
  check("32 symbols exactly (5 bits per character)", MAIL_UNSUB_ALPHABET.length === 32,
    `got ${MAIL_UNSUB_ALPHABET.length}`)
  check("no duplicate symbols", new Set(MAIL_UNSUB_ALPHABET).size === 32)
  for (const bad of ["I", "L", "O", "U"]) {
    check(`excludes '${bad}' (Crockford: confusable off paper, or unlucky)`, !MAIL_UNSUB_ALPHABET.includes(bad))
  }
  check("14 characters = 70 bits of entropy", MAIL_UNSUB_TOKEN_LENGTH === 14)

  // ── (a) EXACTLY ONE RECIPIENT ─────────────────────────────────────────────
  section("(a) a token resolves to exactly one recipient")

  // A stand-in for the unique index: token → recipient. The resolver's real
  // lookup is `.eq('unsubscribe_token', normalize(raw))`, so what has to hold is
  // that normalize is INJECTIVE over minted tokens. If it were not, one person's
  // typo could suppress a different person.
  const CORPUS = 5000
  const table = new Map<string, string>()   // token → recipientId
  for (let i = 0; i < CORPUS; i++) {
    const t = mintToken()
    if (table.has(t)) continue              // a real collision would fail the unique index too
    table.set(t, `recipient-${i}`)
  }
  check(`minted ${CORPUS} tokens with no collision (unique index would hold)`,
    table.size >= CORPUS - 1, `distinct=${table.size}`)

  const resolve = (raw: string | null | undefined): string[] => {
    const t = normalizeMailUnsubToken(raw)
    if (!t) return []
    const hit = table.get(t)
    return hit ? [hit] : []
  }

  let exactlyOne = 0, identity = 0
  for (const [token, recipient] of table) {
    const hits = resolve(token)
    if (hits.length === 1 && hits[0] === recipient) exactlyOne++
    if (normalizeMailUnsubToken(token) === token) identity++
  }
  check(`every one of ${table.size} minted tokens resolves to EXACTLY ONE recipient`,
    exactlyOne === table.size, `matched ${exactlyOne}/${table.size}`)
  check("normalisation is the identity on minted tokens (mint and read agree)",
    identity === table.size, `identity on ${identity}/${table.size}`)

  // Injectivity under folding: fold the whole corpus and count distinct results.
  // If O→0 or I/L→1 could ever merge two minted tokens this drops below size.
  const folded = new Set([...table.keys()].map((t) => normalizeMailUnsubToken(t)!))
  check("folding cannot merge two minted tokens (one typo never reaches another person)",
    folded.size === table.size, `${folded.size} distinct of ${table.size}`)

  // The forms a human actually produces off paper — all must reach the same row.
  const sample = [...table.keys()][0]!
  const owner = table.get(sample)!
  const typedForms: Array<[string, string]> = [
    ["exact", sample],
    ["lower case", sample.toLowerCase()],
    ["printed grouped form", formatMailUnsubTokenForPrint(sample)],
    ["grouped + lower case", formatMailUnsubTokenForPrint(sample).toLowerCase()],
    ["with stray spaces", ` ${sample.slice(0, 5)} ${sample.slice(5)} `],
    ["typed 'O' for '0'", sample.replace(/0/g, "O")],
    ["typed 'I' for '1'", sample.replace(/1/g, "I")],
    ["typed 'l' for '1'", sample.replace(/1/g, "l")],
  ]
  for (const [label, form] of typedForms) {
    const hits = resolve(form)
    check(`${label} → the same one recipient`, hits.length === 1 && hits[0] === owner,
      `resolved to ${JSON.stringify(hits)}`)
  }

  // The unbiased-reduction claim in the migration, measured. 256 = 8x32, so each
  // symbol should appear ~1/32 of the time. A biased generator silently costs
  // entropy the security argument is spending.
  const counts = new Map<string, number>()
  for (const t of table.keys()) for (const c of t) counts.set(c, (counts.get(c) ?? 0) + 1)
  const totalChars = table.size * MAIL_UNSUB_TOKEN_LENGTH
  const expected = totalChars / 32
  let worstDev = 0
  for (const c of MAIL_UNSUB_ALPHABET) {
    worstDev = Math.max(worstDev, Math.abs((counts.get(c) ?? 0) - expected) / expected)
  }
  check("byte % 32 is unbiased — every symbol within 15% of uniform",
    worstDev < 0.15, `worst deviation ${(worstDev * 100).toFixed(1)}%`)

  // ── (b) A BAD OR ABSENT TOKEN IS REFUSED ──────────────────────────────────
  section("(b) a bad or absent token is refused")
  const junk: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["a number, not a string", 12345678901234],
    ["one character short", sample.slice(0, 13)],
    ["one character long", sample + "7"],
    ["contains 'U' (outside the alphabet)", "U" + sample.slice(1)],
    ["contains punctuation", sample.slice(0, 13) + "!"],
    ["a uuid (the OLD credential shape)", "50000000-0000-0000-0000-000000000001"],
    ["SQL-ish", "' or 1=1 --"],
    ["a path traversal", "../../etc/passwd"],
    ["all separators", "--------------"],
  ]
  for (const [label, value] of junk) {
    check(`${label} → refused`, normalizeMailUnsubToken(value as string) === null && resolve(value as string).length === 0)
  }
  // Well-formed but never minted: the shape check passes, the lookup finds nothing.
  const unminted = "00000000000000"
  check("a well-formed but UNMINTED token is shaped-ok and resolves to nobody",
    isMailUnsubTokenShaped(unminted) && resolve(unminted).length === 0)
  check("isMailUnsubTokenShaped agrees with normalize on a real token", isMailUnsubTokenShaped(sample))

  // ── THE POSTCARD CONSTRAINT ───────────────────────────────────────────────
  section("it has to fit on a postcard")
  const url = buildMailUnsubscribeUrl(sample, "https://vipagentos.com")
  check(`canonical URL is ${url.length} chars (<= 60, prints on a 4x6 back)`, url.length <= 60, url)
  check("URL carries the token and no identifier", url.endsWith(`/unsubscribe/${sample}`) && !/[?&]/.test(url))
  check("trailing slash on the base is trimmed, never doubled",
    buildMailUnsubscribeUrl(sample, "https://x.com/") === `https://x.com/unsubscribe/${sample}`)
  check("a printed grouped token still builds the canonical URL",
    buildMailUnsubscribeUrl(formatMailUnsubTokenForPrint(sample), "https://x.com") === `https://x.com/unsubscribe/${sample}`)
  const line = mailOptOutPrintLine(sample, "https://vipagentos.com")
  check(`print line is ${line.length} chars and drops the scheme nobody types`,
    line.length <= 72 && !line.includes("https://"), line)
  check("printed grouping is 5-5-4 and folds back to the same token",
    formatMailUnsubTokenForPrint(sample).split("-").map((s) => s.length).join(",") === "5,5,4" &&
    normalizeMailUnsubToken(formatMailUnsubTokenForPrint(sample)) === sample)

  // ── PARITY WITH THE MIGRATION ─────────────────────────────────────────────
  section("m493 mints exactly what this module reads")
  const mig = src("supabase/migrations/m493-a-mailed-recipient-has-no-way-to-say-stop.sql")
  check("the generator's alphabet literal is byte-for-byte MAIL_UNSUB_ALPHABET",
    mig.includes(`k_alphabet constant text := '${MAIL_UNSUB_ALPHABET}'`))
  check("the generator's length matches MAIL_UNSUB_TOKEN_LENGTH",
    mig.includes(`k_len      constant int  := ${MAIL_UNSUB_TOKEN_LENGTH}`))
  // Scoped to the generator BODY (between the $fn$ delimiters) rather than the
  // whole file — the prose above it names random() in order to say it is not used,
  // and a check that cannot tell code from commentary proves nothing.
  const genBody = mig.slice(mig.indexOf("as $fn$"), mig.lastIndexOf("$fn$;"))
  check("draws from pgcrypto's CSPRNG (gen_random_bytes)", genBody.includes("gen_random_bytes(k_len)"))
  check("the generator body never calls random(), which is not cryptographically secure",
    genBody.length > 100 && !/(?<!gen_)\brandom\(\)/.test(genBody))
  check("reduction is the unbiased byte % 32", genBody.includes("get_byte(v_bytes, i) % 32"))
  check("token column is NOT NULL with the generator as DEFAULT",
    /unsubscribe_token text\s*\n\s*not null default public\.direct_mail_unsubscribe_token\(\)/.test(mig))
  check("token column is UNIQUELY indexed (one token, one recipient — enforced)",
    mig.includes("create unique index if not exists direct_mail_recipients_unsubscribe_token_key"))
  check("the migration refuses to run if the column already exists", mig.includes("ALREADY has unsubscribe_token"))
  check("the migration refuses to run without pgcrypto", mig.includes("pgcrypto is not installed"))
  check("the trace column unsubscribed_at is added", mig.includes("add column if not exists unsubscribed_at timestamptz"))
  check("no CHECK vocabulary is added or changed", mig.includes("unexpected CHECK constraint(s) on direct_mail_recipients"))

  // ── (c) THE WRITE LANDS WHERE THE DISPATCHER READS ────────────────────────
  section("(c) the mail suppression lands where dispatchDirectMail reads")

  const dispatch = src("lib/providers/dispatch.ts")
  const gate = dispatch.slice(dispatch.indexOf("export async function dispatchDirectMail"))
  check("dispatchDirectMail consults checkSuppression on channel \"mail\"",
    /checkSuppression\(\{[\s\S]{0,400}?channel:\s*"mail"/.test(gate))
  check("…and reads the lead row's own direct_mail_opt_out / dnc_status flags",
    /direct_mail_opt_out\s*===\s*true/.test(gate) && /dnc_status\s*===\s*true/.test(gate))
  check("…and honours BOTH spellings in leads.opt_out_channels",
    /opt_out_channels[\s\S]{0,200}?"direct_mail"[\s\S]{0,40}?"mail"/.test(gate))

  const leadOptOut = src("lib/lead-intent/lead-opt-out.ts")
  check("applyLeadOptOut maps 'direct_mail' → the CHECK-admitted 'mail' suppression channel",
    /direct_mail:\s*"mail"/.test(leadOptOut))
  check("applyLeadOptOut sets leads.direct_mail_opt_out — the flag the gate reads first",
    /direct_mail:\s*"direct_mail_opt_out"/.test(leadOptOut))
  check("applyLeadOptOut admits the 'inbound_direct_mail' source this surface uses",
    /"inbound_direct_mail"/.test(leadOptOut))

  const suppression = src("lib/kernel/compliance/check-suppression.ts")
  check("checkSuppression's list arm matches on contact_id + channel (the contact-side mail arm)",
    /contact_id\.eq\.\$\{params\.contactId\}/.test(suppression) && /\.eq\('channel', params\.channel\)/.test(suppression))
  check("SuppressionChannel includes 'mail'", /SuppressionChannel\s*=[^\n]*'mail'/.test(suppression))

  const applier = src("lib/direct-mail/mail-unsubscribe.ts")
  check("the mail surface reuses applyLeadOptOut for a LEAD (no second suppression path)",
    /applyLeadOptOut\(\{/.test(applier) && /channel:\s*args\.request === "all" \? "all" : "direct_mail"/.test(applier))
  check("…and reuses addSuppression for a CONTACT on channel 'mail'",
    /addSuppression\(\{/.test(applier) && /wanted: SuppressionChannel\[\] = args\.request === "all" \? ALL_CONTACT_CHANNELS : \["mail"\]/.test(applier))
  check("it defines no suppression table write of its own beyond the audit row",
    (applier.match(/\.from\("contact_suppression_list"\)/g) ?? []).length === 1 &&
    /\.select\("id"\)/.test(applier),
    "the single contact_suppression_list reference must be the read-back, not an insert")
  check("addSuppression's result is READ BACK before success is reported (it returns void)",
    /suppressionRowExists\(/.test(applier) && /could not be confirmed/.test(applier))
  check("a resolver read refusal is reported as 'unreadable', never as 'not_found'",
    /reason: "unreadable"/.test(applier) && /if \(error\) \{[\s\S]{0,200}?reason: "unreadable"/.test(applier))
  check("the recipient stamp happens AFTER a binding write, never before",
    applier.indexOf("wroteSomethingBinding") < applier.indexOf("unsubscribed_at: now"))
  check("an unbindable recipient is reported, not silently reported as success",
    /bindingGap/.test(applier) && /MAIL_OPT_OUT_UNBOUND/.test(applier))

  // ── THE PUBLIC SURFACE ────────────────────────────────────────────────────
  section("the public surface accepts a token and nothing else")
  const tokenRoute = src("app/api/unsubscribe/token/route.ts")
  check("no brokerage / lead / contact / recipient id is ever read from the request",
    !/body\.(brokerageId|leadId|contactId|recipientId)/.test(tokenRoute) &&
    !/searchParams\.get\("(brokerageId|leadId|contactId|recipientId)"\)/.test(tokenRoute))
  check("GET is read-only — it resolves and never applies",
    !/applyMailUnsubscribe/.test(tokenRoute.slice(tokenRoute.indexOf("export async function GET"), tokenRoute.indexOf("export async function POST"))))
  check("POST is the only write", /export async function POST/.test(tokenRoute) && /applyMailUnsubscribe/.test(tokenRoute))
  check("both verbs are rate limited (entropy is the boundary; this is depth)",
    (tokenRoute.match(/checkPublicRateLimit\(/g) ?? []).length === 2)
  check("an unrecognised 'request' value narrows to 'mail', never widens to 'all'",
    /body\.request === "all" \? "all" : "mail"/.test(tokenRoute))
  check("a database refusal is a retryable 503, not a 404 that sends a real person away",
    /status: 503/.test(tokenRoute) && /reason === "unreadable"/.test(tokenRoute))

  // ── THE LEGACY ROUTE ──────────────────────────────────────────────────────
  section("the legacy ?contactId= route — repaired, kept, and labelled")
  const legacy = src("app/api/unsubscribe/route.ts")
  check("it no longer looks contacts up by ONLY the wrong unique column",
    /\.eq\("id", contactId\)/.test(legacy))
  check("…and still accepts the secondary contacts.contact_id shape",
    /\.eq\("contact_id", contactId\)/.test(legacy))
  check("addSuppression is passed contacts.id, NOT contacts.contact_id (the FK target)",
    /contactId: contact\.id,/.test(legacy) && !/contactId:\s*contact\.contact_id/.test(legacy))
  check("a LEAD's footer link now resolves (it pointed at `contacts` and could never match)",
    /\.from\("leads"\)/.test(legacy) && /applyLeadOptOut\(\{/.test(legacy))
  check("its writes are read back before success is reported",
    /suppressionLanded\(/.test(legacy))
  check("every read is destructured and a refusal is a 503, never a silent 404",
    /if \(byIdErr\) return unreadable/.test(legacy) && /if \(leadErr\) return unreadable/.test(legacy))
  check("it is rate limited", /checkPublicRateLimit\("unsub-legacy"/.test(legacy))
  check("the compliance ledger records that this path's credential was unverified",
    /const UNVERIFIED_SOURCE = "email_footer_unverified"/.test(legacy) && /source: UNVERIFIED_SOURCE/.test(legacy))
  check("'mail' is now an accepted channel on the legacy shape too",
    /ALLOWED: SuppressionChannel\[\] = \["email", "sms", "mail"\]/.test(legacy))

  // The live emitter still exists and still emits the old shape — which is the
  // whole reason this route is repaired rather than deleted. If this check ever
  // fails, the sender was repointed and the legacy path can be retired.
  const assemble = src("lib/kernel/communications/assemble-email.ts")
  check("assemble-email STILL emits the legacy link — so removing this route would 404 live footers",
    /\/unsubscribe\?contactId=\$\{params\.contactId\}&channel=email/.test(assemble))

  report()
}

main()
