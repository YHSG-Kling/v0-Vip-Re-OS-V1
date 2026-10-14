#!/usr/bin/env tsx
/**
 * scripts/mail-address-suppression-simulator.ts  (npm run test:mail-address-suppression)
 *
 * A MAILED STRANGER CAN NOW BE GIVEN A BINDING OPT-OUT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS PROVES CLOSED
 *
 * m493 printed an opt-out token on the mail piece. `lib/direct-mail/mail-unsubscribe.ts`
 * binds the resulting request onto whichever entity the recipient row names, and
 * for a row that names NEITHER a lead NOR a contact — the purchased farm list,
 * the audience import, the mail-only prospect, i.e. THE NORMAL RECIPIENT of an
 * acquisition mailer — it could only RECORD the request and said so:
 *
 *     "…not linked to a lead or contact, so no sender gate can enforce it
 *      automatically. It needs manual removal from the source list."
 *
 * The cause was structural: `contact_suppression_list` had three identity
 * columns (contact_id, email, phone) and a mail recipient is identified by a
 * MAILBOX. `checkSuppression`'s list arm ORs over exactly those three, so for an
 * address-only recipient the OR list was EMPTY and the gate returned
 * "not suppressed" having asked no question. And `dispatchDirectMail` skipped the
 * suppression gate ENTIRELY when the send named no contactId and no leadId.
 *
 * m503 adds `contact_suppression_list.mailing_address_key`;
 * lib/direct-mail/address-suppression.ts mints/writes/reads it; checkSuppression
 * grows an address arm; dispatchDirectMail consults it unconditionally.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEGATIVE CONTROLS are the point of this file. Every assertion below is paired
 * with one that FAILS if the fix is reverted:
 *   · the key must be ZIP-scoped — a street-only key would suppress one house
 *     number in every ZIP in the country;
 *   · two spellings of one mailbox must collide, or the opt-out is not binding;
 *   · a null/unkeyable address must never widen into "match anything";
 *   · a REFUSED read must fail CLOSED, and a MISSING COLUMN must not (nothing
 *     can be hiding in a column that does not exist);
 *   · the dispatcher must run the gate with NO entity id at all.
 *
 * No database, no creds. Pure units + mock clients + source assertions.
 */
import { readFileSync } from "node:fs"
import {
  mailingAddressSuppressionKey,
  addAddressSuppression,
  checkAddressSuppression,
  isAddressColumnMissing,
  ADDRESS_SUPPRESSION_COLUMN,
  ADDRESS_SUPPRESSION_CHANNEL,
} from "../lib/direct-mail/address-suppression"
import { normalizeAddressKey } from "../lib/analytics/prediction-accuracy"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; failures.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}

const src = (p: string) => readFileSync(p, "utf8")
const code = (p: string) => stripComments(src(p))

/**
 * A supabase-js-shaped mock. `result` is what the terminal call resolves to;
 * every insert/select is captured so an assertion can read the exact row.
 */
function mockClient(opts: {
  insertResult?: { data: any; error: any }
  selectResult?: { data: any; error: any }
} = {}) {
  const captured: { table?: string; row?: any; filters: Array<[string, string, any]> } = { filters: [] }
  const from = (table: string) => {
    captured.table = table
    const b: any = {
      insert: (row: any) => { captured.row = row; return b },
      update: (row: any) => { captured.row = row; return b },
      select: () => b,
      eq: (c: string, v: any) => { captured.filters.push(["eq", c, v]); return b },
      limit: async () => opts.selectResult ?? { data: [], error: null },
      maybeSingle: async () => opts.insertResult ?? { data: { id: "sup-1" }, error: null },
      then: (resolve: any) => resolve(opts.selectResult ?? { data: [], error: null }),
    }
    return b
  }
  return { client: { from }, captured }
}

async function main(): Promise<void> {
  // ═══ 1. THE KEY IS THE EXISTING NORMALIZER, NOT A SECOND ONE ══════════════
  console.log("\n[1 · one normalizer, delegated — never re-implemented]")
  {
    check(
      "mailingAddressSuppressionKey returns EXACTLY what normalizeAddressKey returns —\n    a second implementation would be a second answer to 'is this the same house'",
      mailingAddressSuppressionKey({ street: "1234 N. Lamar Boulevard, Apt 5B", zip: "78701-1234" })
        === normalizeAddressKey("1234 N. Lamar Boulevard, Apt 5B", "78701-1234"),
    )
    const modSrc = code("lib/direct-mail/address-suppression.ts")
    check(
      "...and it does so by IMPORTING it — the module contains no normalization of its own",
      modSrc.includes('from "@/lib/analytics/prediction-accuracy"')
        && !/replace\(\/\[\.,#\]/.test(modSrc)
        && !/toLowerCase\(\)[\s\S]{0,80}split\(\/\\s\+\//.test(modSrc),
    )
  }

  // ═══ 2. TWO SPELLINGS OF ONE MAILBOX MUST COLLIDE ═════════════════════════
  console.log("\n[2 · the key identifies a HOUSEHOLD, not a string]")
  {
    const a = mailingAddressSuppressionKey({ street: "1234 N. Lamar Boulevard, Apt 5B", zip: "78701" })
    const b = mailingAddressSuppressionKey({ street: "1234 north lamar blvd", zip: "78701-9999" })
    check("'1234 N. Lamar Boulevard, Apt 5B' and '1234 north lamar blvd' are ONE key —\n    otherwise the opt-out binds to a spelling and the next campaign misses it",
      a !== null && a === b, `${a} vs ${b}`)
    check("...and the unit designator is gone — a mailbox is the household",
      (a ?? "").includes("1234 n lamar blvd") && !(a ?? "").includes("5b"), String(a))
  }

  // ═══ 3. ZIP IS LOAD-BEARING (the over-suppression control) ════════════════
  console.log("\n[3 · ZIP scoping — a street-only key would suppress a house number nationwide]")
  {
    const austin = mailingAddressSuppressionKey({ street: "123 Main St", zip: "78701" })
    const denver = mailingAddressSuppressionKey({ street: "123 Main St", zip: "80202" })
    check("the same street number in two ZIPs is TWO keys", austin !== denver && austin !== null)
    check("...and the ZIP is IN the key, so a reader can see the scope", (austin ?? "").endsWith("|78701"), String(austin))
  }

  // ═══ 4. AN UNKEYABLE ADDRESS REFUSES — IT NEVER WIDENS ════════════════════
  console.log("\n[4 · null is a refusal, never a wildcard]")
  {
    check("no house number → null (a street is not a household)",
      mailingAddressSuppressionKey({ street: "Main St", zip: "78701" }) === null)
    check("no ZIP → null", mailingAddressSuppressionKey({ street: "123 Main St", zip: null }) === null)
    check("a non-numeric ZIP → null", mailingAddressSuppressionKey({ street: "123 Main St", zip: "TX" }) === null)
    check("empty everything → null", mailingAddressSuppressionKey({ street: "", zip: "" }) === null)

    const { client, captured } = mockClient()
    const w = await addAddressSuppression(client, {
      brokerageId: "b1", street: "Main St", zip: "78701", reason: "r", source: "inbound_direct_mail",
    })
    check("an unkeyable address is NOT written — a row with a null key would match nothing\n    and report a suppression that binds nobody",
      w.unkeyable && !w.suppressed && captured.row === undefined)

    const r = await checkAddressSuppression(client, { brokerageId: "b1", street: null, zip: null })
    check("...and an unkeyable CHECK asks no question rather than matching null keys —\n    which are every email and phone suppression on the table",
      r.unkeyable && !r.suppressed && captured.filters.length === 0)
  }

  // ═══ 5. THE WRITE LANDS ON THE EXISTING LIST, WITH REAL COLUMNS ═══════════
  console.log("\n[5 · one suppression list, not a second one]")
  {
    const { client, captured } = mockClient({ insertResult: { data: { id: "sup-9" }, error: null } })
    const w = await addAddressSuppression(client, {
      brokerageId: "b1", street: "1234 N Lamar Blvd", zip: "78701",
      reason: "Opted out via the code printed on a mail piece", source: "inbound_direct_mail",
    })
    check("the row goes on contact_suppression_list — the SAME table checkSuppression reads",
      captured.table === "contact_suppression_list")
    check(`channel is '${ADDRESS_SUPPRESSION_CHANNEL}' — the value the live CHECK admits`,
      captured.row?.channel === "mail")
    check("contact_id / email / phone are all NULL — this person has none of them",
      captured.row?.contact_id === null && captured.row?.email === null && captured.row?.phone === null)
    check("the key is the normalized household, never the raw address",
      captured.row?.[ADDRESS_SUPPRESSION_COLUMN] === "1234 n lamar blvd|78701",
      String(captured.row?.[ADDRESS_SUPPRESSION_COLUMN]))
    check("suppressed:true only because the insert RETURNED AN ID", w.suppressed && !w.pendingMigration)

    // EVERY column named in that insert must exist, or PostgREST refuses the
    // whole write (PGRST204) — the failure mode this repo keeps re-learning.
    const live = new Set(SCHEMA_SNAPSHOT.contact_suppression_list)
    const named = Object.keys(captured.row ?? {})
    const absent = named.filter((c) => c !== ADDRESS_SUPPRESSION_COLUMN && !live.has(c))
    check("every OTHER column in the insert exists in the live schema snapshot",
      absent.length === 0, absent.join(", "))
    // THIS CHECK USED TO ASSERT THE OPPOSITE, AND HAD A SHELF LIFE.
    //
    // It read `!live.has(ADDRESS_SUPPRESSION_COLUMN)` — "the snapshot does NOT
    // carry this column, therefore m503 is the migration that has to add it".
    // That is a true and useful thing to say exactly once: while m503 is still
    // pending. The moment m503 was applied and the schema cache regenerated from
    // the live database, the column appeared in the snapshot and the assertion
    // went red — not because anything broke, but because the world caught up
    // with it. A proof that can only pass BEFORE the change it describes is a
    // countdown, not an invariant, and it fails in the confusing direction: the
    // guard goes red on the success.
    //
    // Inverted into the invariant that actually holds forever, and is strictly
    // stronger: the column the module writes IS in the snapshot, so the code and
    // the schema cache agree. If m503 were reverted, or the cache regenerated
    // against a database that never took it, this goes red for a REAL reason —
    // the insert would name a column PostgREST would refuse the whole write for
    // (PGRST204), which is the failure mode the block above exists to catch.
    check(`...and ${ADDRESS_SUPPRESSION_COLUMN} is in the snapshot — m503 is applied and the cache knows it`,
      live.has(ADDRESS_SUPPRESSION_COLUMN),
      `snapshot columns: ${[...live].join(", ")}`)
  }

  // ═══ 6. A DUPLICATE IS AN HONOURED REQUEST, NOT A FAILURE ═════════════════
  console.log("\n[6 · one human decision, one consent record]")
  {
    const { client } = mockClient({
      insertResult: { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint' } },
    })
    const w = await addAddressSuppression(client, {
      brokerageId: "b1", street: "1234 N Lamar Blvd", zip: "78701", reason: "r", source: "inbound_direct_mail",
    })
    check("a second campaign's token for the same household reports SUPPRESSED, not failed —\n    the person is protected and the ledger does not claim they asked twice",
      w.suppressed && w.alreadySuppressed && !w.error)
  }

  // ═══ 7. THE THREE "NO"s ARE THREE DIFFERENT ANSWERS ═══════════════════════
  console.log("\n[7 · pendingMigration ≠ unreadable ≠ not-suppressed]")
  {
    check("PGRST204 is recognised as 'the column is not there yet'",
      isAddressColumnMissing({ code: "PGRST204", message: "Could not find the 'mailing_address_key' column" }))
    check("...and by message alone, for a client that drops the code",
      isAddressColumnMissing({ code: null, message: "column mailing_address_key does not exist in the schema cache" }))
    check("a plain RLS refusal is NOT mistaken for a pending migration",
      !isAddressColumnMissing({ code: "42501", message: "new row violates row-level security policy" }))

    const missing = mockClient({ selectResult: { data: null, error: { code: "PGRST204", message: "mailing_address_key not found in the schema cache" } } })
    const rm = await checkAddressSuppression(missing.client, { brokerageId: "b1", street: "1234 N Lamar Blvd", zip: "78701" })
    check("a MISSING COLUMN does not hold the mail — no row can exist without the column,\n    so failing closed here would be a self-inflicted outage protecting nobody",
      rm.pendingMigration && !rm.suppressed && !rm.unreadable)

    const refused = mockClient({ selectResult: { data: null, error: { code: "42501", message: "permission denied" } } })
    const rr = await checkAddressSuppression(refused.client, { brokerageId: "b1", street: "1234 N Lamar Blvd", zip: "78701" })
    check("a REFUSED read fails CLOSED — 'I could not check' must never render as 'they are not on it'",
      rr.unreadable && !rr.suppressed && !!rr.reason)

    const wm = mockClient({ insertResult: { data: null, error: { code: "PGRST204", message: "mailing_address_key not found" } } })
    const w = await addAddressSuppression(wm.client, {
      brokerageId: "b1", street: "1234 N Lamar Blvd", zip: "78701", reason: "r", source: "inbound_direct_mail",
    })
    check("a WRITE against a pending migration reports pendingMigration and NOT success —\n    the person must not be told they were unsubscribed",
      w.pendingMigration && !w.suppressed)
  }

  // ═══ 8. A MATCH BINDS, AND IT IS SCOPED ═══════════════════════════════════
  console.log("\n[8 · the read finds the row, on the right predicates]")
  {
    const hit = mockClient({ selectResult: { data: [{ id: "s1", suppression_reason: "Opted out via the code printed on a mail piece" }], error: null } })
    const r = await checkAddressSuppression(hit.client, { brokerageId: "b1", street: "1234 north lamar blvd", zip: "78701-4242" })
    check("a household that asked to stop is SUPPRESSED, even spelled differently\n    and with a ZIP+4", r.suppressed)
    check("...and the reason names the request, not a generic error", (r.reason ?? "").includes("printed on a mail piece"))

    const f = hit.captured.filters
    const has = (col: string, val?: any) => f.some(([, c, v]) => c === col && (val === undefined || v === val))
    check("the query is tenant-scoped", has("brokerage_id", "b1"))
    check("...channel-scoped to mail — an email opt-out must not stop a postcard\n    and vice versa", has("channel", "mail"))
    check("...and keyed on the normalized household", has(ADDRESS_SUPPRESSION_COLUMN, "1234 n lamar blvd|78701"))
  }

  // ═══ 9. THE GATE ACTUALLY CONSULTS IT ═════════════════════════════════════
  console.log("\n[9 · checkSuppression grew an address arm, and dispatchDirectMail feeds it]")
  {
    const cs = code("lib/kernel/compliance/check-suppression.ts")
    check("checkSuppression accepts the mailing address", /mailingStreet\?:\s*string/.test(cs) && /mailingZip\?:\s*string/.test(cs))
    check("...and calls the ONE address module rather than re-querying by hand",
      cs.includes("checkAddressSuppression") && cs.includes("@/lib/direct-mail/address-suppression"))
    check("...only for channel 'mail' — the other three have no address",
      /params\.channel === 'mail' && \(params\.mailingStreet/.test(cs))
    check("...and an unreadable address list fails CLOSED there too",
      /addr\.unreadable[\s\S]{0,200}suppressed:\s*true/.test(cs))

    const d = code("lib/providers/dispatch.ts")
    const gateAt = d.indexOf("channel:     \"mail\"")
    const mailingArg = d.indexOf("mailingStreet: params.mailingAddress")
    check("dispatchDirectMail passes the address it is about to PRINT into the gate",
      mailingArg > 0 && gateAt > 0 && Math.abs(mailingArg - gateAt) < 500)
    check("...and the gate no longer requires an entity id — an address-only send used\n    to skip suppression entirely",
      !/if \(params\.contactId \|\| params\.leadId\) \{\s*const supSvc/.test(d))
    // The de-conflict gate below it is still entity-scoped, deliberately: an
    // over-touch cap needs a touch history, which an anonymous address has none of.
    check("...while the de-conflict gate stays entity-scoped (an anonymous address has\n    no touch history to cap against)",
      /if \(params\.contactId \|\| params\.leadId\) \{\s*const deferred = await deconflictGate/.test(d))
  }

  // ═══ 10. THE TOKEN OPT-OUT NOW BINDS FOR A STRANGER ═══════════════════════
  console.log("\n[10 · mail-unsubscribe binds the address-only case]")
  {
    const mu = code("lib/direct-mail/mail-unsubscribe.ts")
    check("the address-only branch calls addAddressSuppression", mu.includes("addAddressSuppression("))
    check("...reading the address SERVICE-SIDE off the recipient row, not from the resolver —\n    a token holder is entitled to act, not to read the file",
      mu.includes('.select("address_line1, zip")') && !/ResolvedMailRecipient[\s\S]{0,600}address_line1/.test(mu))
    check("...and reports bindingGap ONLY when the write did not land",
      /addr\.suppressed[\s\S]{0,200}wroteSomethingBinding = true/.test(mu))
    check("...naming migration m503 when that is the actual reason", mu.includes("m503"))
    check("'mailing_address' is a distinct binding — 'recipient_only' no longer covers\n    for a suppression that really did bind",
      /"mailing_address"/.test(mu) && /MailUnsubBinding =[\s\S]{0,200}mailing_address/.test(mu))
    check("an unreadable address is NOT reported as 'no address'",
      /addrError[\s\S]{0,300}could not be read/.test(mu))
  }

  // ═══ 11. THE MIGRATION SAYS WHAT THE CODE ASSUMES ═════════════════════════
  console.log("\n[11 · m503 is the migration the code is written against]")
  {
    const m = src("supabase/migrations/m503-an-address-only-recipient-can-be-given-a-code-but-no-suppression-identity.sql")
    check("adds the column the module names",
      new RegExp(`add column if not exists ${ADDRESS_SUPPRESSION_COLUMN}`).test(m))
    check("...idempotently, so a re-run is safe", m.includes("add column if not exists"))
    check("...with a read index on the exact predicate the gate runs",
      /create index if not exists[\s\S]{0,200}\(brokerage_id, channel, mailing_address_key\)/.test(m))
    check("...and a partial UNIQUE so one household cannot be ledgered twice",
      /create unique index[\s\S]{0,300}where mailing_address_key is not null/.test(m))
    check("...carrying a write proof that ABORTS rather than reporting success",
      m.includes("raise exception") && m.includes("WRITE PROOF"))
    check("...which proves the ZIP scoping in the database, not just in TypeScript",
      m.includes("leaked onto the same street number in another"))
    check("...and proves the tenant boundary", m.includes("crossed a brokerage boundary"))
  }

  console.log(`\n${"═".repeat(70)}`)
  console.log(`MAIL ADDRESS SUPPRESSION — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log("A recipient who has a mailbox and nothing else can be given an opt-out that binds.")
}

main().catch((e) => { console.error(e); process.exit(1) })
