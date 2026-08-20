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
 *   (d) THE TOKEN REACHES THE PHYSICAL PIECE — the half that was missing. (a)-(c)
 *       proved the mechanism resolves; none of them proved it is ever PRINTED,
 *       and it was not. Following the owner's ruling that "postcards also get a
 *       qrcode so maybe the unsubscribe can be part of it", the piece now
 *       carries the token twice — as a QR and as the same URL in words — and
 *       this section proves the end-to-end property that matters: SCANNING THE
 *       QR ON A GIVEN RECIPIENT'S CARD RESOLVES TO THAT RECIPIENT, over a live
 *       corpus, by round-tripping the encoded URL back through the resolver's
 *       own normaliser. It also proves the campaign-level response QR and the
 *       per-recipient opt-out QR can never be the same object.
 *   (e) AND THE CHAIN THAT FILLS IT IN — campaign-drain → orchestrate-send →
 *       render-postcard → PostcardBack4x6, plus the content contract that makes
 *       a card with no readable opt-out a refusable render.
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
import QRCode from "qrcode"
import {
  buildMailOptOutAffordance,
  mailOptOutProps,
  MAIL_OPT_OUT_QR_PX,
  MAIL_OPT_OUT_QR_OPTIONS,
} from "../lib/direct-mail/mail-opt-out-affordance"
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
  console.log(" ✅ Mail opt-out verified — the token is PRINTED on the piece as a QR and as")
  console.log("    a readable URL, scanning it resolves to exactly that one recipient, junk is")
  console.log("    refused, and the write lands where dispatchDirectMail reads.")
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

/** PNG IHDR width/height, read straight out of a data URL. */
function pngSize(dataUrl: string): { w: number; h: number } {
  const buf = Buffer.from(dataUrl.split(",")[1] ?? "", "base64")
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

async function main() {
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

  // ── (d) THE OPT-OUT ACTUALLY REACHES THE PHYSICAL PIECE ───────────────────
  // Everything above proves a token RESOLVES. None of it proves the token ever
  // gets PRINTED, and until this section that was the gap: the mechanism was
  // complete and the mail piece carried no trace of it.
  //
  //   owner: "postcards also get a qrcode so maybe the unsubscribe can be part of it"
  //
  // The end-to-end claim being proved here is the one that matters: THE TOKEN
  // ENCODED IN THE QR ON A GIVEN RECIPIENT'S CARD IS THE TOKEN THAT RESOLVES TO
  // THAT RECIPIENT — not merely that a prop exists.
  section("(d) the printed QR carries THIS recipient's token, and no other")

  const BASE = "https://app.vipagentos.com"

  // The premise the QR-equality proof rests on, tested rather than assumed:
  // `qrcode` is deterministic, so two identical PNGs are two encodings of the
  // same payload. If this ever stops holding, every check below stops meaning
  // what it says and fails here first.
  const detA = await QRCode.toDataURL(`${BASE}/unsubscribe/${sample}`, MAIL_OPT_OUT_QR_OPTIONS)
  const detB = await QRCode.toDataURL(`${BASE}/unsubscribe/${sample}`, MAIL_OPT_OUT_QR_OPTIONS)
  check("the encoder is deterministic — identical PNG bytes mean identical payload\n    (the premise every QR check below rests on)", detA === detB)

  // Walk a real slice of the corpus: token → what gets printed → back to a
  // recipient. Every step is the production function.
  const slice = [...table.keys()].slice(0, 250)
  let urlCarriesToken = 0, roundTripped = 0, qrMatchesUrl = 0, rightSize = 0
  const qrSeen = new Map<string, string>()   // qr png → recipientId
  for (const token of slice) {
    const owner2 = table.get(token)!
    const aff = await buildMailOptOutAffordance(token, BASE)
    if (!aff) continue

    if (aff.url === `${BASE}/unsubscribe/${token}`) urlCarriesToken++

    // THE ROUND TRIP. Take the last path segment of the URL the QR encodes —
    // which is literally what the scanner's browser hands app/unsubscribe/[token]
    // — and run it back through the resolver's own normaliser.
    const scanned = aff.url.split("/unsubscribe/")[1] ?? ""
    const hits = resolve(scanned)
    if (hits.length === 1 && hits[0] === owner2) roundTripped++

    // The PNG is bit-for-bit the encoding of THAT recipient's URL.
    const expected = await QRCode.toDataURL(aff.url, MAIL_OPT_OUT_QR_OPTIONS)
    if (aff.qrDataUrl === expected) qrMatchesUrl++

    const { w, h } = pngSize(aff.qrDataUrl!)
    if (w === MAIL_OPT_OUT_QR_PX && h === MAIL_OPT_OUT_QR_PX) rightSize++

    qrSeen.set(aff.qrDataUrl!, owner2)
  }
  check(`all ${slice.length} affordances build a URL ending in that recipient's own token`,
    urlCarriesToken === slice.length, `${urlCarriesToken}/${slice.length}`)
  check(`SCANNING THE PRINTED QR RESOLVES TO EXACTLY THAT ONE RECIPIENT (${slice.length}/${slice.length})`,
    roundTripped === slice.length, `${roundTripped}/${slice.length}`)
  check("the QR image IS the encoding of that recipient's URL — not a stale one,\n    not the campaign's, not a neighbour's",
    qrMatchesUrl === slice.length, `${qrMatchesUrl}/${slice.length}`)
  check(`every QR is a distinct image — ${slice.length} recipients, ${qrSeen.size} codes`,
    qrSeen.size === slice.length, `${qrSeen.size} distinct of ${slice.length}`)
  check(`the PNG is generated at exactly MAIL_OPT_OUT_QR_PX (${MAIL_OPT_OUT_QR_PX}px), so the\n    composition never resamples it — a rescaled QR is how a printed code stops scanning`,
    rightSize === slice.length, `${rightSize}/${slice.length}`)

  // The printed sentence and the QR are two encodings of ONE url.
  const affSample = (await buildMailOptOutAffordance(sample, BASE))!
  check("the printed line and the QR encode the same URL (one token, two affordances)",
    affSample.line === mailOptOutPrintLine(sample, BASE)
    && affSample.line.includes(affSample.url.replace(/^https?:\/\//, "")))
  check("…and the line is what a person can read, type and act on WITHOUT a camera",
    /To stop receiving mail: /.test(affSample.line) && !affSample.line.includes("data:image"))

  // A missing or junk token must NOT produce a plausible-looking opt-out.
  for (const [label, bad] of [["null", null], ["undefined", undefined], ["empty", ""],
                              ["truncated", sample.slice(0, 10)], ["a uuid", "50000000-0000-0000-0000-000000000001"]] as Array<[string, unknown]>) {
    check(`${label} token → NO affordance (a broken opt-out that looks like one is worse\n    than none — it consumes the single attempt most people make)`,
      (await buildMailOptOutAffordance(bad as string, BASE)) === null)
  }
  const nullProps = mailOptOutProps(null)
  check("…and the props are EXPLICIT nulls, never omitted — Remotion merges inputProps\n    over defaultProps, so an omitted prop silently falls back to the Studio default",
    nullProps.optOutLine === null && nullProps.optOutQrDataUrl === null
    && "optOutLine" in nullProps && "optOutQrDataUrl" in nullProps)

  // ── CAMPAIGN-LEVEL QR vs PER-RECIPIENT TOKEN ──────────────────────────────
  // app/api/qr/scan/route.ts states the hazard in its own words: "A QR code is
  // minted PER CAMPAIGN (qr_codes.slug → direct_mail_campaigns.qr_code_id), so a
  // scan can never identify an individual recipient row". If the opt-out rode
  // that table, every card in a campaign would print ONE code and the first scan
  // would suppress one arbitrary stranger.
  section("the campaign QR and the opt-out QR are different objects")
  const [tokA, tokB] = slice.slice(0, 2)
  const affA = (await buildMailOptOutAffordance(tokA, BASE))!
  const affB = (await buildMailOptOutAffordance(tokB, BASE))!
  const campaignScanUrl = `${BASE}/api/qr/scan?slug=fall-farm-2026`   // ONE slug, whole campaign
  const campaignQrForA = await QRCode.toDataURL(campaignScanUrl, { width: 720, margin: 1, errorCorrectionLevel: "M" })
  const campaignQrForB = await QRCode.toDataURL(campaignScanUrl, { width: 720, margin: 1, errorCorrectionLevel: "M" })
  check("two recipients of the SAME campaign share ONE response QR (that is what makes\n    it campaign-level, and why it can never carry an opt-out)",
    campaignQrForA === campaignQrForB)
  check("…and get DIFFERENT opt-out URLs", affA.url !== affB.url && affA.token !== affB.token)
  check("…and DIFFERENT opt-out QR images", affA.qrDataUrl !== affB.qrDataUrl)
  check("neither opt-out QR is the campaign QR",
    affA.qrDataUrl !== campaignQrForA && affB.qrDataUrl !== campaignQrForA)
  check("the opt-out URL routes to the token surface, NOT through /api/qr/scan —\n    an opt-out is not a campaign response and must not count as one",
    !affA.url.includes("/api/qr/scan") && !affA.url.includes("slug=") && !/[?&]/.test(affA.url))

  const affordanceSrc = src("lib/direct-mail/mail-opt-out-affordance.ts")
  const affordanceCode = affordanceSrc.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n")
  check("the affordance builder never reads or writes qr_codes, and mints no slug",
    !/qr_codes|scan_count|slug/.test(affordanceCode))
  check("it takes a TOKEN, not a URL — so a caller cannot hand it the campaign's\n    qrScanUrl by mistake",
    /buildMailOptOutAffordance\(\s*\n?\s*rawToken: string \| null \| undefined/.test(affordanceSrc))

  // ── (e) THE THREE FILES AND THE CHAIN THAT FEEDS THEM ─────────────────────
  section("(e) the piece, its contract, and the chain that fills them in")

  const backSrc = src("remotion/PostcardBack4x6.tsx")
  check("PostcardBack4x6 accepts optOutLine + optOutQrDataUrl",
    /optOutLine: string \| null/.test(backSrc) && /optOutQrDataUrl: string \| null/.test(backSrc))
  check("…destructures BOTH (a declared-but-unread prop is a card with no opt-out)",
    /\{\s*[\s\S]{0,200}?optOutLine, optOutQrDataUrl,[\s\S]{0,80}?\}\s*\)\s*=>/.test(backSrc))
  check("…renders the readable line", /\{optOutLine\}/.test(backSrc))
  check("…renders the QR through Remotion's <Img>", /<Img src=\{optOutQrDataUrl\}/.test(backSrc))
  check("…and labels the square, so the recipient knows what they are scanning BEFORE\n    they scan it — the one thing a QR cannot tell them",
    /SCAN TO/.test(backSrc) && /STOP MAIL/.test(backSrc))
  check(`…at the SAME px the PNG is generated at (${MAIL_OPT_OUT_QR_PX})`,
    backSrc.includes(`const OPT_OUT_QR_PX = ${MAIL_OPT_OUT_QR_PX}`))

  const rootSrc = src("remotion/Root.tsx")
  const backBlock = rootSrc.slice(rootSrc.indexOf('id="PostcardBack4x6"'), rootSrc.indexOf('id="PostcardFront6x9"'))
  check("Root.tsx declares both props on PostcardBack4x6 (a prop missing from the\n    defaults is invisible to the content-contract guard)",
    /optOutLine:\s*null/.test(backBlock) && /optOutQrDataUrl:\s*null/.test(backBlock))
  check("…and defaults them to NULL, never a sample token — a plausible default here\n    would print one stranger's suppression code on every card in the run",
    !/optOutLine:\s*["'`]/.test(backBlock) && !/optOutQrDataUrl:\s*["'`]/.test(backBlock))

  const contract = src("lib/remotion/content-contract.ts")
  const cBlock = contract.slice(contract.indexOf("PostcardBack4x6: {"), contract.indexOf("PostcardFront6x9: {"))
  check("the contract makes optOutLine REQUIRED — a mailed piece with no readable way\n    to say stop is a refusable render, not a silent one",
    /required: \[[^\]]*"optOutLine"/.test(cBlock))
  check("…and optOutQrDataUrl COSMETIC — a failed QR encode degrades the card, it must\n    not cancel an otherwise legitimate send",
    /cosmetic: \[[^\]]*"optOutQrDataUrl"/.test(cBlock))
  check("…and says why the asymmetry is deliberate", /friction/.test(cBlock) && /qr_codes/.test(cBlock))

  const renderer = src("lib/direct-mail/render-postcard.ts")
  check("render-postcard builds the opt-out from the RECIPIENT's token",
    /buildMailOptOutAffordance\(args\.unsubscribeToken\)/.test(renderer))
  check("…and spreads it into the BACK's input props",
    /const backInput = \{[\s\S]{0,400}?\.\.\.optOut,/.test(renderer))
  const backInputBlock = renderer.slice(renderer.indexOf("const backInput = {"), renderer.indexOf('id: "PostcardBack4x6"'))
  check("…while the CAMPAIGN QR stays on the front — the back input never carries\n    qrCodeDataUrl, so the two codes cannot be swapped by a careless edit",
    !backInputBlock.includes("qrCodeDataUrl"))
  const frontInputBlock = renderer.slice(renderer.indexOf("const frontInput = {"), renderer.indexOf('id: "PostcardFront4x6"'))
  check("…and the front never carries the opt-out", !/optOut/.test(frontInputBlock))

  const orchestrator = src("lib/direct-mail/orchestrate-send.ts")
  check("orchestrateRenderAndSend accepts a per-recipient unsubscribeToken",
    /unsubscribeToken\?: string \| null/.test(orchestrator))
  check("…and hands it to the 4x6 render",
    /renderPostcardBothSides4x6\(\{[\s\S]{0,600}?unsubscribeToken: args\.unsubscribeToken \?\? null/.test(orchestrator))
  check("…and SAYS SO when a 6x9 piece mails without one, rather than dropping the\n    token silently — PostcardBack6x9 does not take the props yet",
    /6x9 postcard is mailing WITHOUT a printed opt-out/.test(orchestrator))

  const drain = src("lib/direct-mail/campaign-drain.ts")
  check("campaign-drain selects the token BACK OFF THE INSERT (the DB mints it; this\n    is the only moment it is knowable without a second round trip)",
    /\.select\("id, unsubscribe_token"\)/.test(drain))
  check("…destructures the insert's error, as supabase-js resolves refusals",
    /const \{ data: recRow, error: recErr \}/.test(drain))
  check("…reports a row that came back with NO token instead of mailing quietly",
    /no unsubscribe_token/.test(drain))
  check("…and passes the token into the send that renders the piece",
    /orchestrateRenderAndSend\(\{[\s\S]{0,1400}?unsubscribeToken,/.test(drain))

  // The last link of the loop, checked across files: the column the drain READS
  // off the insert is character-for-character the column the resolver LOOKS UP.
  // A rename on one side alone would print codes that resolve to nobody, which
  // reads to a recipient exactly like an unsubscribe link that does not work.
  const applier2 = src("lib/direct-mail/mail-unsubscribe.ts")
  check('the drain writes and the resolver reads the SAME column, "unsubscribe_token"',
    /\.select\("id, unsubscribe_token"\)/.test(drain)
    && /\.eq\("unsubscribe_token", token\)/.test(applier2))
  // Negative half targets CODE, never prose — the comment above the select says
  // the word "pgcrypto" in order to explain that the DATABASE does the minting.
  const drainCode = drain.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")
  check("…and the m493 migration is the one that mints it, NOT NULL with a CSPRNG\n    default, so the drain never generates a token itself",
    /unsubscribe_token text\s*\n\s*not null default public\.direct_mail_unsubscribe_token\(\)/.test(mig)
    && !/gen_random|randomBytes|crypto|Math\.random/.test(drainCode))

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
