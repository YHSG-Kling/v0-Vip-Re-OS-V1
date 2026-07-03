#!/usr/bin/env tsx
/**
 * scripts/client-tutor-simulator.ts   (npm run test:client-tutor)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CLIENT EDUCATION TUTOR — a client-safe, role/stage-aware Q&A tutor in the portals that
 * defers specifics to the agent, is Fair-Housing-guarded, surfaces related lessons, and logs every turn
 * (feeding the question→curriculum loop). Injectable generator → no tokens spent in tests.
 *
 * PURE:   buildTutorSystemPrompt (role/stage/agent + hard rules) + tutorAnswerRisky (holds steering /
 *         protected-class answers) + the safe fallback.
 * SOURCE: the action is contact-scoped; the tutor card is mounted on all three portal homes; owned by
 *         shopping_agent with a runnable proof.
 * LIVE (creds-gated): a real contact asks → the injected generator answer is returned + the turn is logged
 *         to chat_messages (session_type portal_widget); a risky answer is HELD → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  buildTutorSystemPrompt,
  tutorAnswerRisky,
  TUTOR_SAFE_FALLBACK,
} from "../lib/education/client-tutor"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[system prompt · pure — client-safe, role/stage aware]")
  const sp = buildTutorSystemPrompt({ firstName: "Sam", role: "buyer", stageLabel: "under contract", agentName: "Dana Kling" })
  check("names the role + stage + agent", /buyer/.test(sp) && /under contract/.test(sp) && /Dana Kling/.test(sp))
  check("forbids legal/financial advice + inventing deal specifics", /Never give legal, tax, or specific financial advice/.test(sp) && /Never invent details about THIS client/.test(sp))
  check("enforces Fair Housing (no steering / protected classes)", /FAIR HOUSING/.test(sp) && /Never steer/.test(sp))
  const spNoAgent = buildTutorSystemPrompt({ firstName: null, role: "homeowner", stageLabel: null, agentName: null })
  check("degrades gracefully with no agent/stage", /reach out to their agent/.test(spNoAgent) && /homeowner/.test(spNoAgent))

  console.log("\n[Fair-Housing / advice guard · pure]")
  check("a steering answer is flagged risky", tutorAnswerRisky("This is a good neighborhood for people like you") === true)
  check("a protected-class answer is flagged risky", tutorAnswerRisky("This area is predominantly one religion") === true)
  check("a normal education answer is NOT flagged", tutorAnswerRisky("Clear to close means your lender finished underwriting. Ask your agent for your exact date.") === false)
  check("the safe fallback defers to the agent", /best answered by your agent/.test(TUTOR_SAFE_FALLBACK))
}

function sourceLayer() {
  console.log("\n[wiring — contact-scoped action, mounted on all portals, owned]")
  const act = src("app/actions/education-tutor.ts")
  check("the action is contact-scoped + calls answerTutorQuestion", /askEducationTutor\(contactId: string, question: string\)/.test(act) && /answerTutorQuestion\(svc, \{ contactId/.test(act))
  const lib = src("lib/education/client-tutor.ts")
  check("answerTutorQuestion holds risky answers + logs the turn to chat_messages", /tutorAnswerRisky\(answer\)/.test(lib) && /from\("chat_messages"\)\.insert/.test(lib) && /session_type: "portal_widget"/.test(lib))
  const card = src("app/components/portal/education-tutor-card.tsx")
  check("the tutor card calls askEducationTutor", /askEducationTutor\(contactId/.test(card))
  for (const home of ["buyer-home", "seller-home", "lifetime-home"]) {
    check(`mounted on the ${home} portal`, /<EducationTutorCard contactId=\{contactId\} \/>/.test(src(`app/portal/[contactId]/${home}.tsx`)))
  }
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by shopping_agent with a runnable proof", /client_education_tutor:\s*\{\s*manager:\s*"shopping_agent",\s*proof:\s*"test:client-tutor"/.test(reg))
  check("package.json wires the proof", /"test:client-tutor":\s*"tsx scripts\/client-tutor-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] a real contact asks (injected generator, no tokens) → answer + logged turn → risky held → clean up")
  const { data: contact } = await svc.from("contacts").select("id").limit(1).maybeSingle()
  if (!contact) { console.log("  ⊘ no contact — skipping"); return }
  const contactId = (contact as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  const { answerTutorQuestion } = await import("../lib/education/client-tutor")
  try {
    const good = await answerTutorQuestion(svc as any, { contactId, question: "what does clear to close mean?", generate: async () => "Clear to close means your lender finished underwriting. Ask your agent for your exact date." })
    check("live: returns the generated answer", /underwriting/.test(good.answer) && !good.held)
    // the logged session (source education_tutor) should exist with 2 messages
    const { data: sess } = await svc.from("chat_sessions").select("id").eq("contact_id", contactId).eq("source", "education_tutor").order("created_at", { ascending: false }).limit(1).maybeSingle()
    check("live: the turn was logged to a portal_widget session", !!sess)
    if (sess) {
      const sid = (sess as any).id
      cleanup.push({ table: "chat_sessions", id: sid })
      const { count } = await svc.from("chat_messages").select("id", { count: "exact", head: true }).eq("session_id", sid)
      check("live: user + assistant messages logged (feeds question→curriculum)", (count ?? 0) === 2)
      // clean the messages first (FK)
      await svc.from("chat_messages").delete().eq("session_id", sid)
    }

    const risky = await answerTutorQuestion(svc as any, { contactId, question: "is this a good neighborhood?", generate: async () => "This is a good neighborhood for people like you." })
    check("live: a risky (steering) answer is HELD → safe fallback", risky.held && /best answered by your agent/.test(risky.answer))
    const { data: sess2 } = await svc.from("chat_sessions").select("id").eq("contact_id", contactId).eq("source", "education_tutor").order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (sess2) { const sid2 = (sess2 as any).id; cleanup.push({ table: "chat_sessions", id: sid2 }); await svc.from("chat_messages").delete().eq("session_id", sid2) }
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CLIENT_TUTOR_FAIL"); process.exit(1) }
  console.log(" ✅ CLIENT_TUTOR_PASS — a client-safe, Fair-Housing-guarded portal tutor that logs turns into the question→curriculum loop")
}
main()
