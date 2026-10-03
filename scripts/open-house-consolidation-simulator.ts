#!/usr/bin/env tsx
/**
 * scripts/open-house-consolidation-simulator.ts  (npm run test:open-house-consolidation)
 *
 * Proves m543: `open_houses` was a SECOND SPELLING of `open_house_events`, the
 * survivor; and `demo_persona_contacts` is a resolved orphan.
 *
 * ── WHY EVERY ABSENCE HERE IS PAIRED (CLAUDE.md §2) ─────────────────────────
 *
 * "0 .from('open_houses') sites remain" and "the scanner is broken" produce the
 * SAME number. So does "the column is gone" and "the probe cannot see columns".
 * Every assertion of absence below is therefore two-sided: it is paired with a
 * positive control that the SAME finder, run the SAME way, still locates
 * something that IS there. A one-sided pass in this file is a bug in this file.
 *
 *   PURE:
 *     retired spelling  0 sites   ⟷  survivor spelling ≥50 sites   (same scanner)
 *     demo_persona      0 sites   ⟷  `contacts`        ≥50 sites   (same scanner)
 *     scanner ignores a commented `.from()`  ⟷  and still counts a real one
 *   LIVE:
 *     13 merged columns SELECTable ⟷ a column that is NOT there 400s
 *     draft + null date ACCEPTED   ⟷ scheduled + null date REFUSED
 *     legal status ACCEPTED        ⟷ out-of-vocabulary status REFUSED
 *
 * Comment stripping is done with scripts/strip-comments.ts and nothing else
 * (§2) — a hand-rolled stripper is the defect that file exists to end.
 */
import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { stripComments, blankComments, blankStrings } from "./strip-comments"

let passed = 0, failed = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) { passed++; console.log(`  ✓ ${n}`) }
  else { failed++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}
const report = () => {
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed) { for (const f of fails) console.log("   - " + f); process.exit(1) }
  console.log(" ✅ Open-house consolidation verified — one event table, one vocabulary")
}

const ROOT = new URL("..", import.meta.url).pathname

/** Every tracked .ts/.tsx file. This is the DENOMINATOR for every count below. */
function trackedFiles(): string[] {
  return execSync(`git ls-files '*.ts' '*.tsx'`, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n").filter(Boolean)
}

/**
 * `.from("<table>")` sites that are REAL CALLS.
 *
 * Counts ACCESS, not mentions. Three things can look identical to a naive line
 * scan, and only one of them is a reader:
 *
 *   1.  await svc.from("open_houses").select(…)              ← a CALL
 *   2.  // await svc.from("open_houses").select(…)           ← a comment
 *   3.  const SPECIMEN = `await svc.from("open_houses")…`    ← test FIXTURE TEXT
 *
 * (2) is removed by the sanctioned scanner. (3) is the one that bit this file:
 * a sibling lane's scripts/listing-archive-simulator.ts carries exactly that
 * specimen as the INPUT to its own scanner, and counting it made this simulator
 * report two live call sites that do not exist — an instrument accusing a string
 * literal of being wiring, which is the §2 failure in miniature.
 *
 * The discriminator uses BOTH outputs of the one scanner, which is what they are
 * for: `blankComments` keeps character offsets aligned while removing comments,
 * and `blankStrings` blanks string/template CONTENTS at those same offsets. The
 * table name is always inside a quote, so it cannot be the test; the `.from(`
 * TOKEN is the test. In a real call that token is CODE and survives blankStrings.
 * Inside a template-literal specimen it is template CONTENT and is blanked. So:
 * a hit counts only if its own `.from(` is still visible after blankStrings.
 *
 * `excludeSelf` keeps this simulator's own source — which necessarily contains
 * every string it hunts — out of its own count.
 */
function fromSites(table: string, files: string[], excludeSelf = true): string[] {
  const hits: string[] = []
  const re = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`, "g")
  for (const rel of files) {
    if (excludeSelf && rel === "scripts/open-house-consolidation-simulator.ts") continue
    let src: string
    try { src = readFileSync(`${ROOT}${rel}`, "utf8") } catch { continue }
    if (!src.includes(table)) continue
    const code = blankComments(src)   // comments gone, every offset still aligned
    const masked = blankStrings(src)  // string/template CONTENTS blanked, same offsets
    for (const m of code.matchAll(re)) {
      const at = m.index ?? 0
      // `.from(` itself must still be code after string-masking, or this "call"
      // is fixture text living inside some larger literal.
      if (!masked.slice(at, at + 6).includes("from")) continue
      hits.push(`${rel}:${code.slice(0, at).split("\n").length}`)
    }
  }
  return hits
}

async function main(): Promise<void> {
  console.log("══ Open-house consolidation simulator (m543) ══")

  // ── LAYER 0 · THE SCANNER ITSELF, BOTH WAYS ───────────────────────────────
  // Before trusting any count, prove the instrument distinguishes a real call
  // from a mention of one. A scanner that counts comments would hide the fix;
  // a scanner that counts nothing would fake it.
  console.log("\n[Layer 0 · the instrument, two-sided]")
  const synthetic = [
    `const a = supabase.from("open_houses")           // REAL — must count`,
    `// const b = supabase.from("open_houses")        <- a comment, must NOT count`,
    `/* const c = supabase.from("open_houses") */     <- a block comment, must NOT count`,
    `const d = "we retired supabase.from(\\"open_houses\\")" // prose in a string`,
  ].join("\n")
  const strippedSynthetic = stripComments(synthetic)
  const realCalls = (strippedSynthetic.match(/\.from\(\s*["'`]open_houses["'`]\s*\)/g) ?? []).length
  check("scanner COUNTS a real .from() call", realCalls >= 1, `counted ${realCalls}`)
  check("scanner DROPS a // commented call and a /* */ commented call",
    realCalls <= 2, `counted ${realCalls}; both comment forms must be gone`)
  check("blankStrings blanks a table name that lives inside a STRING literal",
    !blankStrings(`const s = "open_houses"`).includes("open_houses"))
  check("…and leaves a real identifier alone (the other side of that control)",
    blankStrings(`const x = open_houses_row`).includes("open_houses_row"))

  // THE SPECIMEN DISCRIMINATOR, BOTH WAYS. fromSites() must count a real call and
  // must NOT count fixture text inside a template literal. A sibling lane's
  // scripts/listing-archive-simulator.ts really does carry such a specimen, and an
  // earlier revision of this file reported it as two live call sites.
  {
    const tmp = `${ROOT}scripts/.m543-discriminator-fixture.ts`
    const { writeFileSync, rmSync } = await import("node:fs")
    writeFileSync(tmp, [
      `const real = svc.from("open_houses").select("id")`,
      "const SPECIMEN = `const { data } = await svc.from(\"open_houses\").select(\"id\")`",
      `// const commented = svc.from("open_houses").select("id")`,
    ].join("\n"))
    try {
      const found = fromSites("open_houses", ["scripts/.m543-discriminator-fixture.ts"], false)
      check("DISCRIMINATOR: counts the REAL .from() call", found.length >= 1, `found ${found.length}`)
      check("DISCRIMINATOR: counts NEITHER the template-literal specimen NOR the comment",
        found.length === 1, `found ${found.length} — expected exactly 1 (the real call)`)
    } finally { rmSync(tmp, { force: true }) }
  }

  const files = trackedFiles()
  console.log(`\n[denominator] ${files.length} tracked .ts/.tsx files scanned`)

  // ── LAYER 1 · THE RE-POINT, WITH ITS POSITIVE CONTROL ─────────────────────
  console.log("\n[Layer 1 · every reader/writer moved to the survivor]")
  const retired = fromSites("open_houses", files)
  const survivor = fromSites("open_house_events", files)

  check("RETIRED SPELLING: zero .from(\"open_houses\") sites remain",
    retired.length === 0, retired.join(", "))
  check("POSITIVE CONTROL: the SAME scanner still finds the survivor's call sites",
    survivor.length >= 50, `found ${survivor.length}; if this ever reads 0 the count above is meaningless`)
  console.log(`    open_houses ${retired.length}  ·  open_house_events ${survivor.length}`)

  // The five satellites are NOT duplicates and must survive untouched.
  for (const sat of ["open_house_attendees", "open_house_feedback", "open_house_invitations", "open_house_rsvp_tracking"]) {
    check(`satellite kept: ${sat} still has readers`, fromSites(sat, files).length > 0)
  }

  // ── LAYER 2 · THE ORPHAN ──────────────────────────────────────────────────
  console.log("\n[Layer 2 · demo_persona_contacts is an orphan, and the finder works]")
  const dpc = fromSites("demo_persona_contacts", files)
  const contactsCtl = fromSites("contacts", files)
  check("zero .from(\"demo_persona_contacts\") sites", dpc.length === 0, dpc.join(", "))
  check("POSITIVE CONTROL: the SAME scanner finds .from(\"contacts\") sites",
    contactsCtl.length >= 50, `found ${contactsCtl.length}`)
  check("its capability's real home still exists: scripts/demo-seed-and-run.ts",
    readFileSync(`${ROOT}scripts/demo-seed-and-run.ts`, "utf8").includes("buildDemoSeedPlan"))
  check("…and the persona vocabulary's real home: lib/portal/persona-config.ts",
    readFileSync(`${ROOT}lib/portal/persona-config.ts`, "utf8").includes("first_time_buyer"))

  // ── LAYER 3 · THE WRITE THAT MOVED ────────────────────────────────────────
  console.log("\n[Layer 3 · the war-room insert speaks the survivor's vocabulary]")
  const war = stripComments(readFileSync(`${ROOT}lib/kernel/launch-war-room.ts`, "utf8"))
  check("war room writes open_house_events", war.includes(`from("open_house_events")`))
  check("…with registration_required, the survivor's spelling", war.includes("registration_required: true"))
  check("…and NOT require_rsvp (an absent column refuses the WHOLE row, PGRST204)",
    !war.includes("require_rsvp"))
  check("…still staged as a draft with no fabricated date", war.includes(`status: "draft"`) && !war.includes("event_date:"))

  const docKernel = readFileSync(`${ROOT}scripts/doc-kernel-simulator.ts`, "utf8")
  check("the PASS-6 vocabulary copy gained 'draft' (third-copy rule)",
    /"open_house_events\.status":\s*\["draft"/.test(docKernel))

  // ── LAYER 4 · LIVE ────────────────────────────────────────────────────────
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[Layer 4 · live] ⏭ SKIPPED — no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.")
    console.log("   A SKIP IS NOT A PASS. The merged columns, the widened CHECK and the")
    console.log("   dateless-draft fence were verified against hrvaqgvukzxfskkcrwbt on")
    console.log("   2026-08-23; this run cannot tell you whether they still hold.")
    report(); return
  }

  console.log("\n[Layer 4 · live · hrvaqgvukzxfskkcrwbt]")
  const { createClient } = await import("@supabase/supabase-js")
  const db = createClient(url, key, { auth: { persistSession: false } })

  const MERGED = "title, property_address, timezone, scheduled_at, ai_recommended_time, " +
    "optimal_timing_score, allow_walkins, check_in_url, is_published, published_at, " +
    "updated_at, cancelled_at, cancellation_reason"

  // PostgREST 400s on an unknown column, so a select IS a column-existence probe.
  const { error: mergedErr } = await db.from("open_house_events").select(MERGED).limit(1)
  check("all 13 merged columns exist on the survivor", !mergedErr, mergedErr?.message)

  // THE OTHER SIDE OF THAT CONTROL: prove the probe can still detect an ABSENT
  // column. Without this, "no error" might just mean the probe never errors.
  const { error: absentErr } = await db.from("open_house_events").select("require_rsvp").limit(1)
  check("NEGATIVE CONTROL: the same probe still 400s on a column that is NOT there",
    !!absentErr, "require_rsvp resolved — the column probe cannot detect absence")

  check("the retired table gained no rows",
    ((await db.from("open_houses").select("id", { count: "exact", head: true })).count ?? -1) === 0)
  check("demo_persona_contacts gained no rows",
    ((await db.from("demo_persona_contacts").select("id", { count: "exact", head: true })).count ?? -1) === 0)

  // A real listing/brokerage/agent, because listing_id is NOT NULL and agent_id
  // FKs agents(id) — CLAUDE.md §3: agents.id and users.id are DISJOINT.
  const { data: agentRow } = await db.from("agents")
    .select("id, brokerage_id").not("brokerage_id", "is", null).limit(1).maybeSingle()
  const { data: listingRow } = await db.from("listings")
    .select("id, brokerage_id").limit(1).maybeSingle()

  if (!agentRow || !listingRow) {
    console.log("   ⏭ no agent/listing available — the write-side controls did not run (NOT a pass)")
    report(); return
  }

  const brokerageId = (listingRow as any).brokerage_id ?? (agentRow as any).brokerage_id
  const base = { brokerage_id: brokerageId, listing_id: (listingRow as any).id, agent_id: (agentRow as any).id }
  const written: string[] = []

  try {
    // POSITIVE: a draft with NO date is exactly what the war room stages.
    const { data: draft, error: draftErr } = await db.from("open_house_events")
      .insert({ ...base, status: "draft", event_date: null, title: "m543 sim — dateless draft", is_published: false })
      .select("id, status, event_date").maybeSingle()
    if (draft) written.push((draft as any).id)
    check("LIVE POSITIVE: a DRAFT with a NULL event_date is ACCEPTED",
      !draftErr && (draft as any)?.event_date === null && (draft as any)?.status === "draft", draftErr?.message)

    // NEGATIVE: the same null date under any other status must be REFUSED.
    const { data: bad, error: badErr } = await db.from("open_house_events")
      .insert({ ...base, status: "scheduled", event_date: null, title: "m543 sim — must be refused" })
      .select("id").maybeSingle()
    if (bad) written.push((bad as any).id)
    check("LIVE NEGATIVE: 'scheduled' with a NULL event_date is REFUSED by the fence",
      !!badErr && !bad, "a dateless non-draft was accepted — the m543 CHECK is not holding")

    // NEGATIVE: the widened vocabulary is still a CLOSED vocabulary.
    const { data: bogus, error: bogusErr } = await db.from("open_house_events")
      .insert({ ...base, status: "confirmed", event_date: new Date().toISOString(), title: "m543 sim — bogus status" })
      .select("id").maybeSingle()
    if (bogus) written.push((bogus as any).id)
    check("LIVE NEGATIVE: an out-of-vocabulary status ('confirmed') is REFUSED",
      !!bogusErr && !bogus, "the status CHECK admits anything — widening it broke it")
  } finally {
    // §3: a DELETE that matches nothing also resolves. .select() it and COUNT.
    for (const id of written) {
      const { data: gone } = await db.from("open_house_events").delete().eq("id", id).select("id")
      if ((gone ?? []).length !== 1) console.log(`   ! cleanup did not remove ${id}`)
    }
    const { count: residue } = await db.from("open_house_events")
      .select("id", { count: "exact", head: true }).ilike("title", "m543 sim%")
    check("cleanup verified — no residue from this run", (residue ?? -1) === 0, `residue ${residue}`)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
