/**
 * scripts/phone-inventory-vocabulary-guard.ts
 *
 * test:phone-inventory-vocabulary — THE LEDGER MUST NAME THE CARRIER IT USES.
 *
 * THE DEFECT. The phone inventory column was called `byoc_credential_id` — a
 * VAPI concept, "bring-your-own-carrier credential", from a provider the owner
 * retired ("no VAPI at all — only Twilio and ElevenLabs"). Four call sites had
 * already stopped believing the name and used it as something else entirely:
 *
 *   number-provisioning  writes  byoc_credential_id: purchasedSid   (Twilio .sid)
 *   phone-provisioning   writes  byoc_credential_id: params.twilioSid
 *   twilio-voice         reads   .../IncomingPhoneNumbers/${byoc_credential_id}.json
 *   provider-posture     maps    sid: n.byoc_credential_id
 *
 * So the column held a Twilio phone-number SID and said it held a VAPI
 * credential. That is survivable while only server code touches it, because the
 * server code agreed with itself. It stopped being survivable at the UI.
 *
 * WHERE IT BECAME A BUG THE USER COULD FEEL. Settings → ISA Calling → Add Number
 * labelled the input "BYOC Credential ID (from VAPI Credentials)" and
 * placeholdered it "cred_xxx". Whatever the admin pasted went into the Twilio
 * REST path above. Twilio 404s on a VAPI credential, bindNumberToTwilioLane
 * fails, and the number's VoiceUrl/SmsUrl are never registered — so a number
 * added through the admin UI could never receive a call or a text. The UI
 * collected one provider's identifier and the lane spent it as another's.
 *
 * TWO MORE BLOCKERS SAT ON THE SAME FORM, both from the same retired vocabulary:
 *   · it REQUIRED a "VAPI Phone Number ID" (handleAdd refused to submit without
 *     one) that nothing in app/ or lib/ ever read — an id from a dashboard this
 *     OS has no account for, gating the only manual registration path;
 *   · it validated the BYOC field against platform_credentials, but the value
 *     is a Twilio SID, so the lookup could never match and the action refused
 *     every time the field was filled.
 * A form that cannot be submitted empty and cannot be submitted filled.
 *
 * THE INVARIANT THIS GUARD HOLDS. The writer and the reader of the carrier's
 * identifier must call it the same thing, and that thing must be the carrier
 * this OS actually dials — because the gap between those two names is exactly
 * where the admin's input went to die.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"

const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${e.name}`
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue
      walk(full, out)
    } else if (/\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}
/** Strip comments so the guard measures CODE, never its own prose. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

const APP_FILES = [...walk("app"), ...walk("lib")]
const SOURCES = APP_FILES.map((f) => ({ file: f, src: code(read(f)) }))

console.log("\n═══ 1. The identifier is named for the carrier that consumes it ═══")
{
  const stale = SOURCES.filter((s) => /\bbyoc_credential_id\b|\bbyocCredentialId\b/.test(s.src))
  ok("no app or lib file still calls the Twilio SID a BYOC credential",
    stale.length === 0, stale.map((s) => s.file).join(", "))

  const writers = SOURCES.filter((s) => /twilio_number_sid\s*:/.test(s.src))
  ok("every writer of the SID writes twilio_number_sid (found " + writers.length + ")",
    writers.length >= 2, "expected the purchase path and the manual-add path")

  // The actual bug was writer/reader disagreement, so assert they MEET: the
  // value interpolated into Twilio's number endpoint comes from that column.
  //
  // SCOPED TO SIDS READ FROM OUR ROW. A first cut banned every interpolation
  // and immediately failed on platform-reception.ts, which resolves its sid
  // from a LIVE Twilio lookup (incoming_phone_numbers[0].sid) and never touches
  // our table — correct code, flagged. Asking "does this come from our row"
  // is the question that actually distinguishes the defect; asking "is this
  // named twilio_number_sid" bans a shape rather than a mistake.
  const bindPaths = SOURCES.flatMap((s) =>
    [...s.src.matchAll(/IncomingPhoneNumbers\/\$\{([^}]+)\}/g)].map((m) => ({ file: s.file, expr: m[1].trim() })))
  const fromOurRow = bindPaths.filter((b) => /^[a-z]\w*\./i.test(b.expr))
  ok(`every IncomingPhoneNumbers/{sid} fed from a DB row uses the SID column` +
     ` (${fromOurRow.length} of ${bindPaths.length} sites read a row)`,
    fromOurRow.length > 0 && fromOurRow.every((b) => /twilio_number_sid/.test(b.expr)),
    fromOurRow.filter((b) => !/twilio_number_sid/.test(b.expr)).map((b) => `${b.file}: ${b.expr}`).join(", "))
}

console.log("\n═══ 2. No admin is asked for a retired provider's identifier ═══")
{
  const ui = read("app/dashboard/settings/isa-calling/isa-calling-client.tsx")
  const uiCode = code(ui)
  ok("the Add Number form never names VAPI to the admin",
    !/VAPI/i.test(uiCode), "the ISA calling client still mentions VAPI in code")
  ok("...and no longer requires an id this OS cannot issue",
    !/vapiPhoneNumberId|newVapiId/.test(uiCode))
  ok("it asks for the Twilio SID instead, which is what the bind actually needs",
    /twilioNumberSid|newTwilioSid/.test(uiCode))

  // The form must stay submittable: the SID is optional, because a number can
  // be registered now and bound later. Requiring it would re-create the exact
  // dead-end this fix removed, just with a different provider's name on it.
  const action = code(read("app/actions/isa-phone-numbers.ts"))
  ok("the SID is OPTIONAL in the action's contract — a required identifier is\n    what made the old form unsubmittable",
    /twilioNumberSid\?:/.test(action))
  ok("...and the UI says plainly what is lost by omitting it, rather than\n    listing the number as though it were live",
    /webhooks/i.test(uiCode) && /(cannot receive|not receive)/i.test(uiCode))
}

console.log("\n═══ 3. The source vocabulary lists only carriers this OS dials ═══")
{
  const action = code(read("app/actions/isa-phone-numbers.ts"))
  ok("PhoneNumberSource is exactly the two values the live CHECK allows",
    /PhoneNumberSource\s*=\s*"byoc_twilio"\s*\|\s*"ported"/.test(action))

  const retired = SOURCES.filter((s) => /"vapi_native"|'vapi_native'|byoc_vonage/.test(s.src))
  ok("no app or lib file offers vapi_native or byoc_vonage",
    retired.length === 0, retired.map((s) => s.file).join(", "))

  const snapshot = read("scripts/check-vocabularies.ts")
  ok("the vocabulary snapshot agrees",
    /number_source:\s*\["byoc_twilio",\s*"ported"\]/.test(snapshot))
}

console.log("\n═══ 4. The dropped columns have no readers left behind ═══")
{
  // Dropping a column is only safe if nothing selects it. tsc cannot see inside
  // a .select("…") string, so this is the check that actually catches it — the
  // rename DID leave three such readers behind, and they were only found by
  // scanning text, not by the type checker.
  for (const col of ["vapi_phone_number_id", "forwarding_target", "ivr_enabled", "ivr_menu"]) {
    const hits = SOURCES.filter((s) =>
      new RegExp(`vapi_phone_numbers[\\s\\S]{0,400}${col}|${col}[\\s\\S]{0,200}vapi_phone_numbers`).test(s.src))
    ok(`nothing reads vapi_phone_numbers.${col}`, hits.length === 0, hits.map((h) => h.file).join(", "))
  }
  ok("the orphan IVR action is gone with the columns it wrote",
    !/updateIsaPhoneIvr/.test(SOURCES.map((s) => s.src).join("\n")))
  const snap = read("scripts/schema-snapshot.ts")
  const listed = snap.match(/vapi_phone_numbers: \[([^\]]*)\]/)?.[1] ?? ""
  ok("the schema snapshot lists the surviving columns only",
    /twilio_number_sid/.test(listed) &&
    !/byoc_credential_id|forwarding_target|ivr_enabled|ivr_menu/.test(listed) &&
    !/"vapi_phone_number_id"/.test(listed))
}

console.log("\n═══ 5. The event the binding stamps says what happened ═══")
{
  const all = SOURCES.map((s) => s.src).join("\n")
  ok("no writer stamps the retired provider's event name", !/vapi_registered/.test(all))
  ok("the binding and A2P paths stamp webhooks_bound",
    (all.match(/webhooks_bound/g) ?? []).length >= 3)
  ok("the vocabulary snapshot agrees",
    /"webhooks_bound"/.test(read("scripts/check-vocabularies.ts")) &&
    !/"vapi_registered"/.test(read("scripts/check-vocabularies.ts")))
}

console.log("\n═══ 6. The detector fires on a reintroduction ═══")
{
  // A guard only tested against the tree it was written from always passes.
  // These are the exact regressions this file exists to stop, run against
  // synthetic text so the assertions above are proven to have teeth.
  const reintroduced = `const { data } = await svc.from("vapi_phone_numbers").select("byoc_credential_id")`
  ok("a re-added byoc_credential_id reader would be caught",
    /\bbyoc_credential_id\b/.test(reintroduced))

  const reWired = 'path: `/2010-04-01/Accounts/${a}/IncomingPhoneNumbers/${n.some_other_col}.json`'
  const reExpr = [...reWired.matchAll(/IncomingPhoneNumbers\/\$\{([^}]+)\}/g)].map((m) => m[1].trim())
  ok("a bind path fed from any OTHER column of our row would be caught",
    reExpr.length === 1 && /^[a-z]\w*\./i.test(reExpr[0]) && !/twilio_number_sid/.test(reExpr[0]))

  // ...and the same check must NOT fire on a sid the code just fetched from
  // Twilio, which is the false positive that taught the scoping above.
  const liveSid = 'path: `/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${sid}.json`'
  const liveExpr = [...liveSid.matchAll(/IncomingPhoneNumbers\/\$\{([^}]+)\}/g)].map((m) => m[1].trim())
  ok("...but a sid resolved live from Twilio is left alone",
    liveExpr.length === 1 && !/^[a-z]\w*\./i.test(liveExpr[0]))

  ok("a re-required VAPI id in the UI would be caught",
    /vapiPhoneNumberId|newVapiId/.test('vapiPhoneNumberId: newVapiId,'))

  ok("a re-added vapi_native option would be caught",
    /"vapi_native"|byoc_vonage/.test('numberSource: "vapi_native"'))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`PHONE INVENTORY VOCABULARY — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nThe writer and the reader of the carrier's identifier must call it")
  console.log("the same thing. The gap between those two names is where the")
  console.log("admin's input goes to die.")
  process.exit(1)
}
console.log("The ledger names the carrier it dials, and the form can be submitted.")
