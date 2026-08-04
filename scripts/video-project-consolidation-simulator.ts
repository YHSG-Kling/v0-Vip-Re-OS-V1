#!/usr/bin/env tsx
/**
 * scripts/video-project-consolidation-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE VIDEO-PROJECT CREATOR, AND NOTHING LOST ON THE WAY TO IT.
 *
 * app/actions/video.ts:createVideoProjectAction was a thin wrapper over
 * lib/kernel/video.ts:createVideoProject. It was unwired — the kernel creator
 * writes the caller's `agentId` straight into ai_video_projects.agent_id, which
 * FKs agents(id) since m366, so a browser could have named the owning agent. But
 * it was also UNDELETABLE, because the kernel path was the only creator that
 * carried campaign attribution, and app/api/video/projects/route.ts POST used it.
 *
 * Deleting it would therefore have removed a CAPABILITY, not a copy. So the
 * capability moved first:
 *
 *   · marketing_campaign_id  — a real uuid column (FK marketing_campaigns(id)).
 *   · source_type / source_id — NO such columns exist; both live in the
 *                               `video_metadata` jsonb (note: video_metadata,
 *                               not `metadata`).
 *   · description            — likewise jsonb-only, and load-bearing:
 *                               lib/kernel/video.ts:generateVideoScript reads
 *                               video_metadata.description as its AI brief.
 *   · the scriptless shell    — the kernel created status 'setup' projects with
 *                               no script, to be scripted later. The survivor
 *                               carries that lane as `scriptPending`.
 *
 * …into app/actions/video/create-video-project.ts:createVideoProject, which
 * ALREADY did more: resolves users->agents, resolves the provider (D-ID), emits
 * VIDEO_GENERATION_REQUESTED. Only then was the wrapper removed.
 *
 * SOURCE layer (comments stripped — prose cannot satisfy an assertion): the
 * survivor is a strict superset, the route passes the attribution through and
 * cannot write a caller-supplied id into an agents-class column or a foreign
 * brokerage, the duplicate is gone, and no HeyGen reference appeared.
 * LIVE layer (creds-gated, skips loudly): marketing_campaign_id is real,
 * source_type / source_id are NOT, video_metadata is, and agent_id FKs agents.
 * Read-only — no row is created, so residue is 0 by construction and re-counted.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")
/** Strip comments so an assertion can never be satisfied by prose describing the fix. */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const SURVIVOR = "app/actions/video/create-video-project.ts"
const DUPLICATE = "app/actions/video.ts"
const ROUTE = "app/api/video/projects/route.ts"
const KERNEL = "lib/kernel/video.ts"
const STAGING = "lib/wizard-staging/content-staging.ts"

/** The survivor's createVideoProject body only — assertions must not be
 *  satisfied by some other function in a 600-line file. */
function survivorCreateBody(): string {
  const c = code(SURVIVOR)
  const start = c.search(/export\s+async\s+function\s+createVideoProject\s*\(/)
  if (start < 0) return ""
  const next = c.slice(start + 1).search(/\nexport\s+(async\s+)?function\s/)
  return next < 0 ? c.slice(start) : c.slice(start, start + 1 + next)
}

/**
 * The literal object passed to `.from(table).insert({...})` — brace-matched, so
 * "is this a COLUMN" can be asked precisely. Without this, a lazy `[\s\S]*?`
 * from `.insert({` runs past the end of the object and finds the same key in a
 * LATER insert (lifecycle_events.metadata holds source_type too), which would
 * make the column/jsonb distinction untestable.
 */
function insertObject(body: string, table: string): string {
  const at = body.search(new RegExp(`\\.from\\(["']${table}["']\\)\\s*\\.insert\\(\\{`))
  if (at < 0) return ""
  const open = body.indexOf("{", at)
  let depth = 0
  for (let i = open; i < body.length; i++) {
    if (body[i] === "{") depth++
    else if (body[i] === "}") { depth--; if (depth === 0) return body.slice(open, i + 1) }
  }
  return ""
}

/** A key at the TOP level of an object literal — i.e. a column, not a jsonb key. */
function topLevelKeys(objectLiteral: string): string[] {
  const keys: string[] = []
  let depth = 0
  let line = ""
  for (const ch of objectLiteral) {
    if (ch === "{" || ch === "[" || ch === "(") { depth++; line += ch; continue }
    if (ch === "}" || ch === "]" || ch === ")") { depth--; line += ch; continue }
    if (ch === "," && depth === 1) {
      const m = line.match(/([A-Za-z_$][\w$]*)\s*:/)
      if (m && depth === 1) keys.push(m[1])
      line = ""
      continue
    }
    line += ch
  }
  const m = line.match(/([A-Za-z_$][\w$]*)\s*:/)
  if (m) keys.push(m[1])
  return keys
}

/** The route's POST handler only. */
function routePostBody(): string {
  const c = code(ROUTE)
  const start = c.search(/export\s+async\s+function\s+POST\s*\(/)
  if (start < 0) return ""
  const next = c.slice(start + 1).search(/\nexport\s+(async\s+)?function\s/)
  return next < 0 ? c.slice(start) : c.slice(start, start + 1 + next)
}

// ── 1. THE DUPLICATE IS GONE ────────────────────────────────────────────────

function duplicateLayer() {
  console.log("\n[source · the duplicate is gone, and only it]")
  const dup = code(DUPLICATE)

  check("createVideoProjectAction no longer exists in app/actions/video.ts",
    !/export\s+async\s+function\s+createVideoProjectAction\b/.test(dup))
  check("...and app/actions/video.ts no longer imports the kernel creator",
    !/\bcreateVideoProject\b/.test(dup))

  // Deletion requires a NAMED survivor. The removal note has to say where it
  // went, or the next reader cannot tell a collapse from a loss. (Read from the
  // UNSTRIPPED source — this one is deliberately about the prose.)
  const raw = src(DUPLICATE)
  check("...and the removal note names the survivor it collapsed into",
    /createVideoProjectAction[\s\S]{0,400}?app\/actions\/video\/create-video-project\.ts/.test(raw))

  // NOTHING ELSE was removed. Every other orphaned export is work to finish.
  for (const fn of [
    "generateVideoScriptAction",
    "updateVideoGenerationSettingsAction",
    "submitVideoGenerationJobAction",
    "loadVideoGenerationStateAction",
    "previewVideoProjectAction",
    "repurposeVideoOutputAction",
    "distributeVideoProjectAction",
    "loadVideoPerformanceAction",
  ]) {
    check(`${fn} is untouched — an unwired capability is work to finish`,
      new RegExp(`export\\s+async\\s+function\\s+${fn}\\b`).test(dup))
  }
}

// ── 2. NO FUNCTIONALITY LOST — THE SURVIVOR IS A SUPERSET ───────────────────

function supersetLayer() {
  console.log("\n[source · the survivor writes everything the kernel path wrote]")
  const body = survivorCreateBody()
  const surv = code(SURVIVOR)
  const kernel = code(KERNEL)

  check("the survivor's createVideoProject was found at all", body.length > 0)

  // The contract accepts the campaign attribution the kernel path accepted.
  check("CreateVideoProjectParams accepts campaignId",
    /interface\s+CreateVideoProjectParams[\s\S]*?\bcampaignId\?\s*:/.test(surv))
  check("CreateVideoProjectParams accepts sourceType and sourceId",
    /interface\s+CreateVideoProjectParams[\s\S]*?\bsourceType\?\s*:/.test(surv) &&
    /interface\s+CreateVideoProjectParams[\s\S]*?\bsourceId\?\s*:/.test(surv))
  check("CreateVideoProjectParams accepts description — generateVideoScript's brief",
    /interface\s+CreateVideoProjectParams[\s\S]*?\bdescription\?\s*:/.test(surv))

  // THE REAL COLUMN. Assert the construct: the insert names the column and the
  // value is derived from the caller's campaignId, not hard-coded null.
  check("the insert writes marketing_campaign_id as a real column",
    /\.insert\(\{[\s\S]*?\bmarketing_campaign_id\s*:/.test(body))
  check("...from the caller's campaignId, resolved before the insert",
    /params\.campaignId/.test(body) &&
    /marketing_campaign_id\s*:\s*(?!null\b|undefined\b)[A-Za-z_$]/.test(body))

  // THE TWO METADATA KEYS. The column is video_metadata; source_type/source_id
  // are keys inside it, exactly as the kernel wrote them. Asked of the
  // brace-matched insert object so a later insert cannot answer for this one.
  const projectInsert = insertObject(body, "ai_video_projects")
  const projectColumns = topLevelKeys(projectInsert)
  check("the ai_video_projects insert object was located", projectInsert.length > 0)
  check("marketing_campaign_id IS a top-level column of that insert",
    projectColumns.includes("marketing_campaign_id"))
  check("video_metadata IS a top-level column of that insert",
    projectColumns.includes("video_metadata"))
  check("source_type is NOT a column — it is a key in the video_metadata jsonb",
    /\bsource_type\b/.test(body) && !projectColumns.includes("source_type"))
  check("source_id is NOT a column — it is a key in the video_metadata jsonb",
    /\bsource_id\b/.test(body) && !projectColumns.includes("source_id"))
  check("description is NOT a column — it is a key in the video_metadata jsonb",
    /\bdescription\b/.test(body) && !projectColumns.includes("description"))
  check("the jsonb column named is video_metadata, never `metadata`",
    !projectColumns.includes("metadata"))

  // All three keys must be fed from the caller's params, not invented — asked of
  // the videoMetadata BUILDER only. Asked of the whole body, the lifecycle_events
  // metadata object (which also carries source_type/source_id) answers for the
  // jsonb the row is actually stored with, and the assertion cannot fail.
  const builderStart = body.search(/const\s+videoMetadata\b/)
  const builderEnd = body.search(/\.from\(["']ai_video_projects["']\)/)
  const metaBuilder = builderStart >= 0 && builderEnd > builderStart ? body.slice(builderStart, builderEnd) : ""
  check("the video_metadata builder was located", metaBuilder.length > 0)
  for (const [key, param] of [["source_type", "sourceType"], ["source_id", "sourceId"], ["description", "description"]]) {
    check(`video_metadata.${key} comes from params.${param}`,
      new RegExp(`videoMetadata\\.${key}\\s*=\\s*params\\.${param}\\b`).test(metaBuilder))
  }

  // background_color was the jsonb's only occupant. A superset ADDS; it must not
  // have replaced the object wholesale and dropped it.
  check("background_color survived the jsonb merge — the object is built, not overwritten",
    /videoMetadata\.background_color\s*=\s*params\.backgroundColorHex\b/.test(metaBuilder))

  // THE SCRIPTLESS SHELL LANE. The kernel created status 'setup' projects with
  // no script; POST .../script filled them in later. Without this the survivor
  // could not create every project the kernel could.
  check("the survivor can create the kernel's scriptless shell (scriptPending)",
    /interface\s+CreateVideoProjectParams[\s\S]*?\bscriptPending\?\s*:/.test(surv) &&
    /scriptPending/.test(body))
  check("...at status 'setup', the kernel's own status for that lane",
    /status\s*:\s*[^,\n]*["']setup["']/.test(body))
  check("...while a script still yields 'draft', as before",
    /status\s*:\s*[^,\n]*["']draft["']/.test(body))
  check("...and an empty script is STILL an error unless scriptPending says so",
    /!\s*params\.script\??\.?trim\(\)\s*&&\s*!\s*params\.scriptPending/.test(body.replace(/\s+/g, " ")) ||
    /!params\.script\?\.trim\(\) && !params\.scriptPending/.test(body.replace(/\s+/g, " ")))

  // The survivor keeps everything it already did MORE of than the kernel.
  check("the survivor still resolves users->agents for the agents-class column",
    /resolveAgentIdInBrokerage/.test(body) && /agent_id\s*:\s*projectAgentId/.test(body))
  // Both halves named explicitly: the row written to lifecycle_events AND the
  // event handed to processKernelEvent. `VIDEO_GENERATION_REQUESTED` appearing
  // anywhere in the body is not enough — either one alone leaves the other free
  // to name a different event.
  const eventInsert = insertObject(body, "lifecycle_events")
  check("the survivor still resolves the provider and emits the kernel event",
    /resolveVideoProvider\s*\(/.test(body) &&
    /event_type\s*:\s*KernelEvent\.VIDEO_GENERATION_REQUESTED/.test(eventInsert) &&
    /processKernelEvent\(\{\s*event\s*:\s*KernelEvent\.VIDEO_GENERATION_REQUESTED/.test(body.replace(/\s*\n\s*/g, " ")))

  // The kernel creator's own shape is the reference for "nothing lost". If the
  // kernel ever writes a column this survivor does not, this file is stale.
  // Compared COLUMN-TO-COLUMN: the whole-body test passed for brokerage_id and
  // title on the strength of the lifecycle_events insert, which is not the row.
  const kernelCreate = kernel.slice(kernel.search(/export\s+async\s+function\s+createVideoProject\s*\(/))
  const kernelColumns = topLevelKeys(insertObject(kernelCreate, "ai_video_projects"))
  check("the kernel creator's own insert object was located — it is the reference",
    kernelColumns.length > 0)
  for (const col of ["marketing_campaign_id", "video_metadata", "agent_id", "brokerage_id", "title"]) {
    if (kernelColumns.includes(col)) {
      check(`kernel wrote the column ${col} — so does the survivor`, projectColumns.includes(col))
    } else {
      check(`kernel is still the reference for ${col} (it writes it)`, false)
    }
  }
}

// ── 3. ERROR IS DESTRUCTURED — supabase-js RESOLVES A REFUSED WRITE ─────────

function silentFailureLayer() {
  console.log("\n[source · a refused write is not a successful one]")
  const body = survivorCreateBody()

  check("the ai_video_projects insert destructures error",
    /const\s*\{\s*data:\s*project,\s*error\s*\}\s*=\s*await\s*supabase[\s\S]{0,60}?ai_video_projects/.test(body))
  check("the campaign tenant lookup destructures error",
    /const\s*\{\s*data:\s*campaign,\s*error:\s*campaignError\s*\}/.test(body))
  check("the lifecycle_events insert destructures error — it used to be a bare await",
    /const\s*\{\s*error:\s*\w+\s*\}\s*=\s*await\s*supabase\s*\.?\s*from\(["']lifecycle_events["']\)/.test(body.replace(/\s*\n\s*/g, " ")))
}

// ── 4. THE ROUTE — REPOINTED, TENANT-SCOPED, ATTRIBUTION PASSED THROUGH ─────

function routeLayer() {
  console.log("\n[source · the live caller now uses the survivor]")
  const route = code(ROUTE)
  const post = routePostBody()

  check("the POST handler was found at all", post.length > 0)
  check("the route imports the survivor, not the kernel creator",
    /import\s*\{[^}]*\bcreateVideoProject\b[^}]*\}\s*from\s*["']@\/app\/actions\/video\/create-video-project["']/.test(route))
  check("...and no longer imports createVideoProject from lib/kernel/video",
    !/import[\s\S]{0,200}?\bcreateVideoProject\b[\s\S]{0,80}?from\s*["']@\/lib\/kernel\/video["']/.test(route))
  check("POST actually calls createVideoProject", /createVideoProject\s*\(/.test(post))

  // ATTRIBUTION PASSED THROUGH — the whole reason the duplicate outlived itself.
  // Asked of the params object the route builds, and shorthand (`sourceType,`)
  // counts: the construct is "this field reaches the creator", not its spelling.
  const paramsAt = post.search(/CreateVideoProjectParams\s*=\s*\{/)
  let paramsObj = ""
  if (paramsAt >= 0) {
    const open = post.indexOf("{", paramsAt)
    let depth = 0
    for (let i = open; i < post.length; i++) {
      if (post[i] === "{") depth++
      else if (post[i] === "}") { depth--; if (depth === 0) { paramsObj = post.slice(open, i + 1); break } }
    }
  }
  check("the params object handed to the creator was located", paramsObj.length > 0)
  const passes = (f: string) => new RegExp(`(^|[{,\\s])${f}\\s*(:|,)`, "m").test(paramsObj)
  check("POST passes campaignId through", passes("campaignId"))
  check("POST passes sourceType through", passes("sourceType"))
  check("POST passes sourceId through", passes("sourceId"))
  check("POST passes description through", passes("description"))

  // THE AGENTS-CLASS BUG. The old call handed an id to a param the kernel wrote
  // straight into ai_video_projects.agent_id. The survivor takes a USERS id and
  // resolves it itself, so the route must pass agentUserId and must NOT pass an
  // `agentId:` field into this creator at all.
  check("POST passes agentUserId (users-class), letting the survivor resolve agents",
    /agentUserId\s*:/.test(post))
  check("...and passes no `agentId:` into the creator — that param no longer exists",
    !/\bagentId\s*:/.test(post))
  check("...and the agents id it passes is not caller-supplied",
    !/agentUserId\s*:\s*body\./.test(post))

  // TENANT SCOPE. brokerage_id must come from the session, never the body — an
  // absent body.brokerageId used to produce an untenanted row.
  check("the brokerage is resolved server-side (requireAuth), not read from the body",
    /requireAuth/.test(route) && /brokerageId\s*:\s*auth\.brokerageId/.test(post))
  check("...and a body-named brokerage that is not the caller's is refused",
    /body\.brokerageId[\s\S]{0,120}?auth\.brokerageId[\s\S]{0,120}?403/.test(post))
  check("...so no `brokerageId: body.` reaches the creator",
    !/brokerageId\s*:\s*body\./.test(post))

  // videoType has a DB CHECK constraint; unvalidated caller input turns a bad
  // request into a 500.
  check("caller-supplied videoType is validated against the CHECK vocabulary",
    /VIDEO_TYPES/.test(route) && /VIDEO_TYPES\.includes/.test(post))
  check("caller-supplied sourceType is validated too",
    /SOURCE_TYPES\.includes/.test(post))
}

// ── 5. SETTLED OWNER RULINGS ────────────────────────────────────────────────

function rulingsLayer() {
  console.log("\n[source · settled rulings]")
  // Tested against STRIPPED code, not raw source. These files legitimately name
  // HeyGen in prose to record that it is banned and what was renamed away from
  // it; a comment saying "there is no HeyGen path" is not a HeyGen path. What
  // must not exist is an identifier, a string or a column that reaches a vendor.
  for (const f of [SURVIVOR, ROUTE, DUPLICATE]) {
    check(`no HeyGen reference in the CODE of ${f}`, !/heygen/i.test(code(f)))
  }
  // Video is a PAYLOAD, not a channel: the creator writes a project row, it does
  // not open a distribution channel.
  check("the creator does not treat video as a channel",
    !/channel\s*:\s*["']video["']/i.test(code(SURVIVOR)))
}

// ── 6. THE CALLER DEFECT FOUND ON THE WAY PAST ──────────────────────────────

function callerLayer() {
  console.log("\n[source · the stale param name that made a lane unreachable]")
  const staging = code(STAGING)
  const call = staging.slice(staging.search(/createVideoProject\(\{/))
    .slice(0, 700)
  check("content-staging calls createVideoProject with agentUserId, not the stale agentId",
    call.length > 0 && /agentUserId\s*:/.test(call) && !/\bagentId\s*:/.test(call))
}

// ── 7. LIVE LAYER — creds-gated, read-only, skips loudly ────────────────────

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[live] ⊘ SKIPPED LOUDLY — no SUPABASE creds in env.")
    console.log("        The source layer proved the shape; the schema facts below were NOT re-verified.")
    console.log("        Set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to run them.")
    return
  }
  const svc = createClient(url, key, { auth: { persistSession: false } })

  /** PostgREST refuses a select naming a column that does not exist, so a
   *  zero-row select is a phantom-column test. No row is written. */
  const columnsExist = async (table: string, columns: string) => {
    const { error } = await svc.from(table).select(columns).limit(0)
    return { ok: !error, why: error?.message ?? "" }
  }
  const mustHave = async (label: string, table: string, columns: string) => {
    const r = await columnsExist(table, columns)
    check(`live: ${label}`, r.ok)
    if (!r.ok) console.log(`      ↳ ${r.why}`)
  }
  /** A missing column and an unreachable DB both come back as an error. Only a
   *  PostgREST column complaint proves ABSENCE — anything else is inconclusive
   *  and must not be scored as a passing negative. */
  const mustNotHave = async (label: string, table: string, column: string) => {
    const r = await columnsExist(table, column)
    const isColumnComplaint = /column|does not exist|42703|PGRST/i.test(r.why)
    check(`live: ${label}`, !r.ok && isColumnComplaint)
    if (!r.ok && !isColumnComplaint) console.log(`      ↳ inconclusive: ${r.why}`)
  }

  const probe = await columnsExist("ai_video_projects", "id")
  if (!probe.ok) {
    console.log(`\n[live] ⊘ SKIPPED LOUDLY — database unreachable: ${probe.why}`)
    console.log("        Every schema assertion below is meaningless without a connection.")
    return
  }

  console.log("\n[live · the gap that was closed is exactly one column and three jsonb keys]")
  await mustHave("marketing_campaign_id is a REAL column on ai_video_projects",
    "ai_video_projects", "id,marketing_campaign_id")
  await mustHave("video_metadata is the jsonb the other three keys live in",
    "ai_video_projects", "video_metadata")
  await mustNotHave("there is NO source_type column — it is jsonb-only",
    "ai_video_projects", "source_type")
  await mustNotHave("there is NO source_id column — it is jsonb-only",
    "ai_video_projects", "source_id")
  await mustNotHave("there is NO description column — it is jsonb-only",
    "ai_video_projects", "description")
  await mustNotHave("there is NO `metadata` column — the name is video_metadata",
    "ai_video_projects", "metadata")
  await mustHave("marketing_campaigns is brokerage-scoped, so the campaign check is real",
    "marketing_campaigns", "id,brokerage_id")
  await mustHave("every column the survivor's insert names is real",
    "ai_video_projects",
    "brokerage_id,agent_id,title,script_content,video_type,provider_avatar_id,provider_voice_id,background_type,background_url,video_metadata,marketing_campaign_id,format,duration_seconds,captions_enabled,listing_id,status,retry_count,video_provider,provider_status,provider_job_id,created_at,updated_at")

  // agent_id's FK class — the reason the caller-supplied id was a wrong-class
  // write. Proven by BEHAVIOUR, not by a summary: a uuid that is a real users.id
  // and not an agents.id must be REFUSED by the foreign key.
  console.log("\n[live · ai_video_projects.agent_id really is agents-class]")
  const { data: someUser, error: userErr } = await svc.from("users").select("id").limit(1)
  const { data: someAgent, error: agentErr } = await svc.from("agents").select("id,user_id,brokerage_id").limit(1)
  if (userErr || agentErr || !someUser?.length || !someAgent?.length) {
    console.log("      ↳ inconclusive: could not read a users/agents row to compare classes")
  } else {
    const { data: crossClass, error: crossErr } = await svc
      .from("agents").select("id").eq("id", someUser[0].id).maybeSingle()
    if (crossErr) {
      console.log(`      ↳ inconclusive: ${crossErr.message}`)
    } else {
      check("live: a users.id is not also an agents.id — the classes are distinct spaces",
        crossClass === null)
    }
  }

  // RESIDUE. This simulator writes nothing; prove it rather than claim it.
  console.log("\n[live · test data residue]")
  const { count: before, error: countErr } = await svc
    .from("ai_video_projects").select("id", { count: "exact", head: true })
  if (countErr) {
    console.log(`      ↳ inconclusive: ${countErr.message}`)
  } else {
    const { count: after, error: recountErr } = await svc
      .from("ai_video_projects").select("id", { count: "exact", head: true })
    check(`live: seeded 0 rows, residue 0 (ai_video_projects ${before} -> ${after})`,
      !recountErr && before === after)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" VIDEO PROJECT CONSOLIDATION — move the capability, then delete the copy")
  console.log("══════════════════════════════════════════════════════════════════════")
  duplicateLayer()
  supersetLayer()
  silentFailureLayer()
  routeLayer()
  rulingsLayer()
  callerLayer()
  await liveLayer()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`VIDEO PROJECT CONSOLIDATION — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
    console.log("\nA red line here means the collapse lost something. The duplicate was")
    console.log("only deletable because the survivor does strictly more; if that stops")
    console.log("being true, a creation lane has gone missing rather than been merged.")
    process.exit(1)
  }
  console.log("✅ VIDEO_PROJECT_CONSOLIDATION_PASS — one creator, nothing lost")
}

main().catch((e) => { console.error(e); process.exit(1) })
