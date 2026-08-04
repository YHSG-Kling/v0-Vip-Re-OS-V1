#!/usr/bin/env tsx
/**
 * scripts/knowledge-lead-wiring-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BRAIN NOBODY COULD ASK, AND THE INTELLIGENCE NOBODY COULD ACT ON.
 *
 * Three capabilities were complete on the server and reachable from nowhere:
 *
 *   1. THE AI CHAT SESSION MODEL. app/actions/ai-chat.ts implements
 *      conversations + messages + ai_suggestions end to end — create, send,
 *      list, resume, close. Nothing in the app called ANY of it. The one screen
 *      that looks like the AI chat (/dashboard/chat) kept its transcript in
 *      React state and routed every question through generateSmartResponse with
 *      `contactId: selectedContactId ?? userId` — and selectedContactId was
 *      never set, so a users.id went into a contacts lookup and office mode
 *      answered "Contact not found" every single time.
 *
 *   2. THE KNOWLEDGE CORPUS AT ANSWER TIME. knowledge_articles and
 *      help_topics_kb are embedded on save and searchable, and buildRAGContext
 *      — the retrieval built specifically for prompts — had no caller at all.
 *      The assistant answered from general real-estate knowledge while the
 *      brokerage's own written policy sat one vector search away.
 *
 *   3. LEAD TRIAGE. updateLeadProfile and getAgentWorkloadStats had no callers.
 *      The leads screen showed the AI's verdict on a unified profile with no
 *      way to correct it, no way to claim it, and no view of who was carrying
 *      what.
 *
 * Wiring them surfaced defects that only matter once something actually calls:
 *   · createChatSession never stamped brokerage_id, and getChatSession filters
 *     on it — the row inserted, then could never be re-opened.
 *   · sendChatMessage inferred the sender as `senderId !== "agent"`, and
 *     messages.sender_id is a uuid — so EVERY agent message was filed as the
 *     client's and scored the lead's temperature from the agent's own typing.
 *   · updateLeadProfile spread `updates: any` into a SERVICE-client update with
 *     no tenant filter — any signed-in agent could rewrite any brokerage's
 *     profile row, including its brokerage_id.
 *   · getAgentWorkloadStats selected first_name/last_name off `agents`, which
 *     has neither; the names live on users, one declared FK away.
 *   · grantMessageAccess took `grantedBy` from the caller — an audit column
 *     whose value the client picks.
 *
 * SOURCE layer: the wiring exists, and each defect above is closed by
 * construct, not by a comment describing it.
 * LIVE layer (creds-gated): every relationship these reads depend on is a
 * DECLARED foreign key, and the phantom columns really are absent.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/** Strip comments so an assertion can never be satisfied by prose describing the fix. */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const AI_CHAT = "app/actions/ai-chat.ts"
const KNOWLEDGE = "app/actions/knowledge/search.ts"
const LEAD_INTEL = "app/actions/lead-intelligence.ts"
const CHAT_UI = "app/dashboard/chat/office-chat-client.tsx"
const LEADS_UI = "app/leads/page.tsx"

function brainLayer() {
  console.log("\n[the brain is asked · knowledge reaches the answer]")
  const chat = code(AI_CHAT)
  const knowledge = code(KNOWLEDGE)

  check("buildRAGContext is still exported by the knowledge action",
    /export async function buildRAGContext\s*\(/.test(knowledge))

  // The CONSTRUCT: the AI responder pulls RAG context for the user's own
  // message. A retrieval keyed on anything else is not grounding this answer.
  check("the AI responder retrieves knowledge for the message being answered",
    /import\(\s*["']@\/app\/actions\/knowledge\/search["']\s*\)[\s\S]{0,200}?buildRAGContext\s*\(\s*userMessage/.test(chat)
    || /buildRAGContext\s*\(\s*userMessage[\s\S]{0,200}?/.test(chat) && /@\/app\/actions\/knowledge\/search/.test(chat))

  // Retrieved and then not used is the same as not retrieved.
  check("...and the retrieved context is interpolated into the prompt",
    /const\s+prompt\s*=\s*`[\s\S]*?\$\{knowledgeBlock\}[\s\S]*?`/.test(chat))

  // A knowledge-base outage must degrade the answer, never withhold it.
  check("...best-effort: a KB failure is caught, not thrown at the agent",
    /try\s*\{[\s\S]{0,400}?buildRAGContext[\s\S]{0,200}?\}\s*catch/.test(chat))

  // buildRAGContext scopes from the caller's cookie session, which is exactly
  // why it belongs in a server action and not in the webhook/cron rail.
  check("the knowledge search is brokerage-scoped from the session, not the caller",
    /getAgentContext\(\)/.test(knowledge) &&
    /brokerageId:\s*brokerageId\s*\?\?\s*undefined/.test(knowledge))
}

function sessionLayer() {
  console.log("\n[the session model has a surface]")
  const chat = code(AI_CHAT)
  const ui = code(CHAT_UI)

  const importsAiChat = /from\s*["']@\/app\/actions\/ai-chat["']/.test(ui)
  for (const fn of ["createChatSession", "sendChatMessage", "getAgentChatSessions", "getChatSession", "endChatSession"]) {
    check(`the chat screen calls ${fn}`, importsAiChat && new RegExp(`${fn}\\s*\\(`).test(ui))
  }

  // The screen must no longer feed a users.id into a contacts-keyed generator.
  check("the screen no longer passes `selectedContactId ?? userId` to a contact generator",
    !/contactId:\s*selectedContactId\s*\?\?\s*userId/.test(ui))

  console.log("\n[the session is findable after it is created]")
  // getChatSession/getAgentChatSessions both filter brokerage_id. An insert
  // without one produces a row that exists and can never be re-opened.
  // `[^}]*` cannot leave the insert's own object literal — otherwise a correctly
  // stamped `messages` insert further down satisfies an assertion about
  // `conversations`, which is exactly the bug this guards.
  check("createChatSession stamps the tenant anchor its own readers filter on",
    /from\("conversations"\)\s*\.insert\(\s*\{[^}]*brokerage_id:\s*identity\.brokerageId/.test(chat))
  check("...and reads it back through the same anchor",
    /from\("conversations"\)[\s\S]{0,300}?\.eq\("brokerage_id",\s*brokerageId\)/.test(chat))

  console.log("\n[who is talking is stated, not inferred from an id]")
  // messages.sender_id is uuid, so `senderId !== "agent"` was true for every
  // real caller: every agent message was filed as the client's.
  check("the sender-type string comparison against an id column is gone",
    !/senderId\s*!==\s*"agent"/.test(chat))
  check("...replaced by an explicit sender type on the call signature",
    /senderType:\s*"agent"\s*\|\s*"client"/.test(chat) &&
    /const\s+isClientMessage\s*=\s*data\.senderType\s*===\s*"client"/.test(chat))
  check("...and the surface states it when the agent types",
    /senderType:\s*"agent"/.test(ui))

  console.log("\n[a raw session id is not a passport]")
  check("sendChatMessage anchors the conversation to the caller's brokerage before writing",
    /from\("conversations"\)[\s\S]{0,300}?\.eq\("id",\s*data\.sessionId\)[\s\S]{0,200}?\.eq\("brokerage_id",\s*identity\.brokerageId\)/.test(chat))
  check("endChatSession refuses a conversation outside the caller's brokerage",
    /export async function endChatSession[\s\S]{0,900}?\.eq\("brokerage_id",\s*identity\.brokerageId\)/.test(chat))

  console.log("\n[the suggestions survive their own insert]")
  // ai_suggestions.suggestion_content is TEXT and the prompt asks the model for
  // an object; getChatSession reads them back filtered on brokerage_id.
  check("suggestions are stamped with the brokerage getChatSession filters on",
    /from\("ai_suggestions"\)[\s\S]{0,200}?insert|suggestion_type/.test(chat) &&
    /brokerage_id:\s*identity\.brokerageId,\s*[\s\S]{0,80}?agent_id:\s*identity\.agentId,\s*[\s\S]{0,120}?suggestion_type/.test(chat))
  check("...and a non-string suggestion body is serialised for a TEXT column",
    /suggestion_content:[\s\S]{0,160}?JSON\.stringify/.test(chat))

  console.log("\n[the identity classes stay distinct]")
  check("no users.id is substituted into an agents-class field",
    !/agent_id:\s*[\w.]*\s*\?\?\s*[\w.]*[Uu]serId/.test(chat) &&
    !/agentId\s*\?\?\s*[\w.]*[Uu]serId/.test(chat))
  check("the canonical resolver is used, via dynamic import",
    /await import\(\s*["']@\/lib\/kernel\/agent-identity-resolver["']\s*\)/.test(chat) &&
    /resolveUserIdToAgentRecord\(/.test(chat))

  console.log("\n[the repaired embeds stay repaired]")
  // One unresolvable embed fails the WHOLE request, and these three name
  // relationships pg_constraint does not declare — reintroducing any of them
  // silently returns the AI to "No lead selected" on every reply.
  const selects = chat.match(/\.select\(\s*`[\s\S]*?`\s*\)/g) ?? []
  check("no select() re-embeds lead_intelligence / lead_behavioral_data / ai_suggestions",
    selects.every((s) => !/lead_intelligence|lead_behavioral_data|ai_suggestions\s*\(/.test(s)))
  check("the AI responder still destructures and reports its context error",
    /const\s*\{\s*data:\s*session,\s*error:\s*sessionError\s*\}/.test(chat) &&
    /if\s*\(sessionError\)/.test(chat))
}

function accessLayer() {
  console.log("\n[conversation sharing: grant / list / revoke]")
  const chat = code(AI_CHAT)
  const ui = code(CHAT_UI)

  for (const fn of ["grantMessageAccess", "revokeMessageAccess", "getMessageAccessList"]) {
    check(`the chat screen calls ${fn}`, new RegExp(`${fn}\\s*\\(`).test(ui))
  }

  // An audit column whose value the client picks records whatever the client says.
  check("grantedBy is no longer a caller-supplied parameter",
    !/grantedBy:\s*string/.test(chat))
  check("...it is the session's user",
    /granted_by:\s*scope\.userId/.test(chat))

  // message_access_control has NO foreign keys, so the tenant check must be in code.
  check("all three access actions go through one tenant check",
    (chat.match(/conversationInCallerTenant\(/g) ?? []).length >= 4)
  check("...and that check filters the conversation by the caller's brokerage",
    /conversationInCallerTenant[\s\S]{0,800}?\.eq\("brokerage_id",\s*identity\.brokerageId\)/.test(chat))
  check("the grantee is confirmed to be in the same brokerage",
    /from\("users"\)[\s\S]{0,200}?\.eq\("id",\s*data\.userId\)[\s\S]{0,120}?\.eq\("brokerage_id",\s*scope\.brokerageId\)/.test(chat))
}

function leadLayer() {
  console.log("\n[lead intelligence reaches the agent]")
  const intel = code(LEAD_INTEL)
  const ui = code(LEADS_UI)

  check("the leads screen calls updateLeadProfile", /updateLeadProfile\s*\(/.test(ui))
  check("the leads screen calls getAgentWorkloadStats", /getAgentWorkloadStats\s*\(/.test(ui))

  console.log("\n[the update is no longer a blank cheque]")
  // Was: `updates: any` spread straight into a SERVICE-client update with no
  // tenant filter. requirePermission defers non-broker callers to RLS, and the
  // service client is the one client RLS does not apply to.
  check("updateLeadProfile no longer takes an untyped `updates: any`",
    !/updateLeadProfile\(profileId:\s*string,\s*updates:\s*any\)/.test(intel))
  check("...it builds an allow-listed patch instead of spreading the input",
    /const\s+patch:\s*Record<string,\s*unknown>\s*=\s*\{\}/.test(intel) &&
    /from\("unified_lead_profile"\)\s*\.update\(patch\)/.test(intel))
  check("...anchored to the caller's brokerage",
    /\.update\(patch\)[\s\S]{0,200}?\.eq\("brokerage_id",\s*auth\.brokerageId\)/.test(intel))
  // A filtered update that matches nothing is not an error to PostgREST.
  check("...and a zero-row update is reported as a failure, not as success",
    /if\s*\(!data\)\s*return\s*\{\s*success:\s*false/.test(intel))

  console.log("\n[assignment resolves an id class, it does not substitute one]")
  // unified_lead_profile.assigned_agent_id has NO foreign key, so a users.id
  // written here is accepted by the database and belongs to nobody.
  check("'me' resolves users.id → agents.id through the canonical resolver",
    /await import\(\s*["']@\/lib\/kernel\/agent-identity-resolver["']\s*\)[\s\S]{0,300}?resolveUserIdToAgentRecord\(\s*auth\.userId/.test(intel))
  check("...with no `?? auth.userId` fallback into the agents-class column",
    !/assigned_agent_id\s*=\s*[\s\S]{0,40}?\?\?\s*auth\.userId/.test(intel))
  check("a browser-supplied agent id is confirmed to be in this brokerage",
    /from\("agents"\)[\s\S]{0,240}?\.eq\("id",\s*updates\.assigned_agent_id\)[\s\S]{0,140}?\.eq\("brokerage_id",\s*auth\.brokerageId\)/.test(intel))

  console.log("\n[the workload panel reads columns that exist]")
  // Scoped to the one function, so a correct sibling elsewhere in the file
  // cannot satisfy an assertion about this one.
  const workloadFn = intel.slice(intel.indexOf("export async function getAgentWorkloadStats"))

  // `agents` carries licence/fee/profile columns and no name at all. The test
  // is whether a name is asked for as a COLUMN OF agents — strip every embed
  // (…) out of the select list and nothing name-shaped may remain.
  const agentSelects = [...intel.matchAll(/from\("agents"\)\s*\.select\(\s*"([^"]*)"/g)].map((m) => m[1])
  const topLevelOf = (sel: string) => sel.replace(/\([^)]*\)/g, "")
  check("no agents select asks for a name column that agents does not have",
    agentSelects.length > 0 && agentSelects.every((s) => !/first_name|last_name|email/.test(topLevelOf(s))))
  check("...they come through the declared agents.user_id → users relationship",
    agentSelects.some((s) => /users:user_id\(\s*first_name/.test(s)))
  // temperature is a nullable free-text column; `row[temperature]++` on a null
  // key made the whole agent's row NaN.
  check("an unscored profile cannot turn a workload row into NaN",
    /if\s*\(t\s*===\s*"hot"\s*\|\|\s*t\s*===\s*"warm"\s*\|\|\s*t\s*===\s*"cold"\)/.test(workloadFn))
  check("every supabase read in the workload path destructures its error",
    /const\s*\{\s*data,\s*error\s*\}\s*=\s*await supabase[\s\S]{0,300}?if\s*\(error\)/.test(workloadFn))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the source layer proved the shape"); return }
  console.log("\n[live · every embed names a DECLARED foreign key]")
  const svc = createClient(url, key, { auth: { persistSession: false } })

  // A probe read is the honest test: PostgREST answers an undeclared embed with
  // PGRST200 and an unknown column with PGRST204/42703, so a clean read proves
  // both the relationship and the columns.
  const probe = async (name: string, run: () => Promise<{ error: unknown }>) => {
    const { error } = await run()
    check(`live: ${name}`, !error)
  }

  await probe("conversations → contacts + messages embed resolves", async () =>
    await svc.from("conversations").select("id, contacts (*), messages (*)").limit(1))
  await probe("agents → users:user_id embed resolves (names live on users)", async () =>
    await svc.from("agents").select("id, users:user_id(first_name, last_name, email)").limit(1))
  await probe("unified_lead_profile carries the triage columns", async () =>
    await svc.from("unified_lead_profile")
      .select("id, brokerage_id, temperature, intent_type, intent_strength, estimated_timeline, ready_for_outreach, assigned_agent_id, ai_summary")
      .limit(1))
  await probe("message_access_control carries the grant columns", async () =>
    await svc.from("message_access_control")
      .select("conversation_id, user_id, user_type, can_read, can_write, granted_by, expires_at")
      .limit(1))

  // The phantom the workload panel used to select. This read MUST fail.
  const { error: phantomError } = await svc.from("agents").select("id, first_name").limit(1)
  check("live: agents.first_name really is a phantom column", Boolean(phantomError))
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" KNOWLEDGE + LEAD WIRING — the brain nobody could ask")
  console.log("══════════════════════════════════════════════════════════════════════")
  brainLayer()
  sessionLayer()
  accessLayer()
  leadLayer()
  await liveLayer()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`KNOWLEDGE + LEAD WIRING — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
    console.log("\nEach of these guards a failure that LOOKS like success: an AI that answers")
    console.log("confidently without the brokerage's own knowledge, a conversation that saves")
    console.log("and can never be re-opened, a triage click that updates zero rows and says")
    console.log("'saved'. None of them raise; all of them are silent.")
    process.exit(1)
  }
  console.log("✅ KNOWLEDGE_LEAD_WIRING_PASS — the middle is connected")
}

main().catch((e) => { console.error(e); process.exit(1) })
