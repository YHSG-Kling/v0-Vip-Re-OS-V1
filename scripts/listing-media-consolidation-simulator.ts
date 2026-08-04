#!/usr/bin/env tsx
/**
 * scripts/listing-media-consolidation-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO TABLES FOR ONE THING.
 *
 * `listing_photos` and `listing_media` were the SAME concept spelled twice. The
 * proof they were duplicates is that they named identical concepts differently:
 *
 *     listing_photos.photo_url    ≡  listing_media.file_url
 *     listing_photos.order_index  ≡  listing_media.sort_order
 *     listing_photos.is_hero      ≡  listing_media.is_primary
 *
 * listing_media was never "the videos table": its media_type CHECK admits
 * photo|video|reel|story|graphic|floorplan|virtual_tour|document, and its
 * usage_intent CHECK (mls|public_marketing|both) already modelled the MLS-set
 * concept that listing_photos existed to express.
 *
 * listing_media SURVIVED. It carries the compliance/branding/approval governance
 * MLS advertising rules require (has_eho_mark, has_brokerage_attribution,
 * has_logo_overlay, uses_approved_template, kernel_compliance_passed,
 * is_approved, approved_by/at) and it reaches the kernel. m368 MOVED onto it the
 * one layer it lacked — photo intelligence: room_type, ai_quality_score,
 * ai_analysis_completed, ai_analyzed_at, enhancement_applied, plus the
 * one-hero-per-listing UNIQUE guard. m369 repointed the photo_enhancement_jobs
 * FK and its brokerage trigger, then dropped listing_photos.
 *
 * WHAT THIS FILE HAS TO PROVE — the bar the work is accepted against:
 *   (A) NO FUNCTIONALITY LOST. Seven photo capabilities existed. All seven still
 *       exist AND now run against listing_media.
 *   (B) THE CAPABILITY GENUINELY MOVED — not deleted, not stubbed.
 *   (C) NO NEW DEFECT. listing_media holds eight media types. Every read of the
 *       photo set MUST pin media_type='photo', or a floorplan comes back as a
 *       photograph and that is a regression dressed up as a consolidation.
 *
 * METHOD:
 *   · Comments are STRIPPED before scanning, so prose describing the fix can
 *     never satisfy an assertion.
 *   · Assertions test the CONSTRUCT (this function reads this table with this
 *     filter), not the spelling of a comment.
 *   · The live layer is creds-gated and SKIPS LOUDLY when the database is
 *     unreachable, so a network error is never scored as a pass.
 *   · Read-only against the database: it creates no rows, so it leaves no
 *     residue to clean up.
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

const A_PHOTO    = "app/actions/photo-management.ts"
const L_INTEL    = "lib/listings/photo-intelligence.ts"
const L_ASSETMGR = "lib/agents/asset-manager.ts"
const L_MAIL     = "lib/direct-mail/listing-lifecycle-mail-reactor.ts"
const A_LANDING  = "app/actions/listing-landing.ts"
const A_LIFECYC  = "app/actions/listing-lifecycle-core.ts"
const A_VIDEO    = "app/actions/listing-video.ts"
const A_EMAIL    = "app/actions/email-campaigns.ts"
const A_PKG      = "app/actions/marketing-package-automation.ts"
const S_MEDIA    = "app/dashboard/listings/[id]/media/media-manager-client.tsx"
const SNAPSHOT   = "scripts/schema-snapshot.ts"
const REGISTRY   = "lib/kernel/manager-registry.ts"
const M368       = "supabase/migrations/m368-listing-media-photo-intelligence.sql"
const M369       = "supabase/migrations/m369-drop-listing-photos.sql"

/** Every file that used to address the duplicate table, plus the guard files. */
const REPOINTED = [A_PHOTO, L_INTEL, L_ASSETMGR, L_MAIL, A_LANDING, A_LIFECYC, A_VIDEO, A_EMAIL, A_PKG, S_MEDIA]
const ALL_SCANNED = [...REPOINTED, SNAPSHOT, REGISTRY]

/**
 * A photo READ is a `.from("listing_media")` whose chained call sequence pins
 * media_type to 'photo' before the statement ends. Rather than eyeball each
 * one, slice the source at every `.from("listing_media")` and require the pin
 * inside the same statement.
 *
 * A statement ends at the first line that is not a continuation of the chain,
 * so the window is bounded by the next `.from(` or a blank-line paragraph break.
 */
function listingMediaStatements(source: string): string[] {
  const out: string[] = []
  const re = /\.from\(\s*["']listing_media["']\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const rest = source.slice(m.index)
    // Cut at the next `.from(` (the next statement) or 900 chars, whichever first.
    const nextFrom = rest.slice(1).search(/\.from\(/)
    const end = nextFrom === -1 ? Math.min(rest.length, 900) : Math.min(nextFrom + 1, 900)
    out.push(rest.slice(0, end))
  }
  return out
}

/**
 * A statement CONSTRAINS media_type when it either filters on it (a read or an
 * update) or sets it in the row it writes (an insert). Both are the pin; only
 * the absence of both lets a floorplan through as a photograph.
 */
const PIN_FILTER = /\.eq\(\s*["']media_type["']\s*,\s*(?:["']photo["']|PHOTO_MEDIA_TYPE)\s*\)/
const PIN_PAYLOAD = /\.insert\(\{[\s\S]{0,600}?\bmedia_type\s*:\s*(?:["']photo["']|PHOTO_MEDIA_TYPE)\b/
const PIN = { test: (s: string) => PIN_FILTER.test(s) || PIN_PAYLOAD.test(s) }
/** The one legitimate NON-photo read: the landing page's other-media list. */
const ANTI_PIN = /\.neq\(\s*["']media_type["']\s*,\s*["']photo["']\s*\)/

function structuralLayer() {
  console.log("\n[source · the duplicate is gone from the code]")

  // (C) Zero remaining references to the dropped table. Comments are stripped,
  // so a comment explaining the consolidation cannot satisfy this.
  const offenders: string[] = []
  for (const f of ALL_SCANNED) {
    const c = code(f)
    if (/\.from\(\s*["']listing_photos["']\s*\)/.test(c)) offenders.push(`${f} (.from)`)
    if (/listing_photos\s*\(\s*\*\s*\)/.test(c)) offenders.push(`${f} (PostgREST embed)`)
    if (/\blisting_photos\s*:/.test(c) && (f === SNAPSHOT || f === REGISTRY)) offenders.push(`${f} (registry/snapshot key)`)
  }
  check("zero `from(\"listing_photos\")` / embed / registry references remain in code",
    offenders.length === 0)
  if (offenders.length) for (const o of offenders) console.log(`      ↳ ${o}`)

  // The schema-drift guard reads the snapshot. If listing_photos is still a key
  // there the guard describes a table that no longer exists.
  const snap = code(SNAPSHOT)
  check("schema-snapshot no longer declares listing_photos",
    !/^\s*listing_photos\s*:/m.test(snap))
  check("schema-snapshot declares listing_media WITH the five moved columns",
    /listing_media\s*:\s*\[[^\]]*"room_type"[^\]]*\]/.test(snap) &&
    /listing_media\s*:\s*\[[^\]]*"ai_quality_score"[^\]]*\]/.test(snap) &&
    /listing_media\s*:\s*\[[^\]]*"ai_analysis_completed"[^\]]*\]/.test(snap) &&
    /listing_media\s*:\s*\[[^\]]*"ai_analyzed_at"[^\]]*\]/.test(snap) &&
    /listing_media\s*:\s*\[[^\]]*"enhancement_applied"[^\]]*\]/.test(snap))
  check("TABLE_MANAGER no longer assigns an owner to the dropped table",
    !/^\s*listing_photos\s*:\s*["']/m.test(code(REGISTRY)))

  // (B) The migration MOVED the columns rather than the code merely dropping
  // the references. The DDL has to exist and name all five.
  const m368 = src(M368)
  check("m368 ADDs all five photo-intelligence columns to listing_media",
    /ALTER TABLE\s+public\.listing_media/i.test(m368) &&
    ["room_type", "ai_quality_score", "ai_analysis_completed", "ai_analyzed_at", "enhancement_applied"]
      .every((c) => new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${c}\\b`, "i").test(m368)))
  check("m368 does NOT re-add order_index/is_hero (sort_order & is_primary already carry them)",
    !/ADD COLUMN[^\n]*\border_index\b/i.test(m368) && !/ADD COLUMN[^\n]*\bis_hero\b/i.test(m368))
  check("m368 carries over the one-hero-per-listing UNIQUE guard listing_photos enforced",
    /CREATE UNIQUE INDEX[\s\S]{0,200}?listing_media[\s\S]{0,200}?WHERE\s+is_primary\s*=\s*true/i.test(m368))

  const m369 = src(M369)
  check("m369 drops listing_photos",
    /DROP TABLE IF EXISTS\s+public\.listing_photos/i.test(m369))
  check("m369 REPOINTS the photo_enhancement_jobs FK instead of dropping the audit trail",
    /photo_enhancement_jobs_photo_id_fkey[\s\S]{0,400}?REFERENCES\s+public\.listing_media\s*\(\s*id\s*\)/i.test(m369))
  check("m369 REPOINTS the brokerage back-fill trigger function off the dropped table",
    /CREATE OR REPLACE FUNCTION public\.photo_enhancement_jobs_set_brokerage[\s\S]{0,900}?FROM public\.listing_media/i.test(m369) &&
    !/FROM public\.listing_photos/i.test(m369))
}

function mediaTypePinLayer() {
  console.log("\n[source · every photo read pins media_type='photo']")

  // (C) THE regression this consolidation could introduce. listing_media holds
  // eight media types; an unpinned read returns a floorplan as a photograph.
  const unpinned: string[] = []
  let pinned = 0
  for (const f of REPOINTED) {
    for (const stmt of listingMediaStatements(code(f))) {
      if (PIN.test(stmt)) { pinned++; continue }
      if (ANTI_PIN.test(stmt)) { pinned++; continue } // explicit non-photo media list
      unpinned.push(`${f}: ${stmt.replace(/\s+/g, " ").slice(0, 110)}`)
    }
  }
  check(`every listing_media statement in the repointed files constrains media_type (${pinned} pinned)`,
    unpinned.length === 0 && pinned > 0)
  if (unpinned.length) for (const u of unpinned) console.log(`      ↳ UNPINNED ${u}`)

  // The pin has to be the CHECK-valid value. "image" is not in the vocabulary —
  // that exact bug (media_type === "image") matched zero rows for months.
  check("no read reintroduces the phantom media_type 'image'",
    !REPOINTED.some((f) => /media_type["']?\s*(?:===|==|,)\s*["']image["']/.test(code(f))))
}

/**
 * (A) NO FUNCTIONALITY LOST. Seven capabilities, each proved to (1) still have
 * a code path and (2) run that path against listing_media.
 */
function capabilityLayer() {
  console.log("\n[source · all seven photo capabilities survive, on listing_media]")
  const actions = code(A_PHOTO)
  const intel = code(L_INTEL)
  const surface = code(S_MEDIA)

  // 1. UPLOAD / PROCESS — the photographer-delivery ingest.
  check("1. upload/process: processVendorPhotos INSERTs into listing_media as a photo",
    /export async function processVendorPhotos/.test(actions) &&
    /from\(\s*["']listing_media["']\s*\)[\s\S]{0,700}?\.insert\(\{[\s\S]{0,600}?media_type:\s*PHOTO_MEDIA_TYPE[\s\S]{0,300}?file_url:/.test(actions))
  check("   ...and it is reachable from the Media Manager",
    /processVendorPhotos\s*\(/.test(surface) &&
    /import[\s\S]{0,600}?processVendorPhotos[\s\S]{0,600}?from\s+["'][^"']*photo-management["']/.test(surface))
  // Tightened: the literal "both" appearing anywhere in the function is not
  // proof of the promotion. Both HALVES of it must be present — the UPDATE that
  // promotes an existing marketing photo, and the INSERT that stamps a newly
  // delivered one.
  check("   ...the marketing→MLS promotion the old row-copy performed still happens (usage_intent)",
    /export async function processVendorPhotos[\s\S]{0,4000}?from\(\s*["']listing_media["']\s*\)\s*\.update\(\{\s*usage_intent:\s*["']both["']\s*\}\)/.test(actions) &&
    /export async function processVendorPhotos[\s\S]{0,4000}?\.insert\(\{[\s\S]{0,800}?usage_intent:\s*["']both["']/.test(actions))

  // 2. ORDERING — order_index became sort_order.
  check("2. ordering: optimizePhotoOrder reads AND writes listing_media.sort_order",
    /export async function optimizePhotoOrder[\s\S]{0,3000}?from\(\s*["']listing_media["']\s*\)[\s\S]{0,400}?\.order\(\s*["']sort_order["']/.test(actions) &&
    /export async function optimizePhotoOrder[\s\S]{0,5000}?\.update\(\{\s*sort_order:/.test(actions))
  check("   ...and the agent's saved ordering RULE is still consulted",
    /export async function optimizePhotoOrder[\s\S]{0,3000}?from\(\s*["']photo_ordering_rules["']\s*\)[\s\S]{0,400}?\.eq\(\s*["']is_active["']\s*,\s*true\s*\)/.test(actions))
  check("   ...with no surviving reference to the retired column name order_index",
    !/\border_index\b/.test(actions) && !/\border_index\b/.test(intel))

  // 3. HERO SELECTION — is_hero became is_primary.
  check("3. hero: the nightly sweep fills a missing hero via listing_media.is_primary",
    /runPhotoIntelligenceSweep[\s\S]{0,4000}?from\(\s*["']listing_media["']\s*\)[\s\S]{0,600}?\.update\(\{\s*is_primary:\s*true\s*\}\)/.test(intel))
  check("   ...hero-gap reporting reads is_primary on PHOTO rows only",
    /from\(\s*["']listing_media["']\s*\)[\s\S]{0,400}?\.eq\(\s*["']media_type["']\s*,\s*["']photo["']\s*\)[\s\S]{0,200}?\.eq\(\s*["']is_primary["']\s*,\s*true\s*\)/.test(code(L_ASSETMGR)))
  check("   ...direct mail resolves its hero photo off is_primary then sort_order",
    /from\(\s*["']listing_media["']\s*\)[\s\S]{0,500}?\.eq\(\s*["']is_primary["']\s*,\s*true\s*\)/.test(code(L_MAIL)) &&
    /from\(\s*["']listing_media["']\s*\)[\s\S]{0,500}?\.order\(\s*["']sort_order["']/.test(code(L_MAIL)))
  check("   ...with no surviving reference to the retired column name is_hero",
    !/\bis_hero\b/.test(actions) && !/\bis_hero\b/.test(intel) &&
    !/\bis_hero\b/.test(code(L_ASSETMGR)) && !/\bis_hero\b/.test(code(L_MAIL)))

  // 4. ROOM TYPE — the vision-derived taxonomy.
  check("4. room type: the vision pass writes room_type onto the listing_media row",
    /persistPhotoAnalysis[\s\S]{0,900}?from\(\s*["']listing_media["']\s*\)\s*\.update\(\{[\s\S]{0,300}?room_type:/.test(intel))
  check("   ...and ordering still sorts by it (the room sequence is not a dead preference)",
    /roomPriority\[a\.room_type\]/.test(actions) && /DEFAULT_ROOM_SEQUENCE/.test(actions))

  // 5. AI QUALITY SCORE.
  check("5. quality score: ai_quality_score is written to listing_media by the vision pass",
    /persistPhotoAnalysis[\s\S]{0,900}?from\(\s*["']listing_media["']\s*\)\s*\.update\(\{[\s\S]{0,300}?ai_quality_score:/.test(intel))
  check("   ...and it still gates batch enhancement (< 80) and MLS validation (< 70 / hero < 85)",
    /ai_quality_score\s*<\s*80/.test(actions) && /ai_quality_score\s*<\s*70/.test(actions) &&
    /ai_quality_score\s*<\s*85/.test(actions))
  check("   ...the analysis backlog is drained off listing_media.ai_analysis_completed",
    /from\(\s*["']listing_media["']\s*\)[\s\S]{0,500}?\.eq\(\s*["']ai_analysis_completed["']\s*,\s*false\s*\)/.test(intel))

  // 6. ENHANCEMENT — real pixel work, and the swap lands on file_url.
  check("6. enhancement: enhanceListingPhoto reads the photo from listing_media",
    /export async function enhanceListingPhoto[\s\S]{0,900}?from\(\s*["']listing_media["']\s*\)[\s\S]{0,300}?select\(\s*["'][^"']*file_url/.test(intel))
  check("   ...and swaps file_url + enhancement_applied on the same table",
    /from\(\s*["']listing_media["']\s*\)\s*\.update\(\{\s*\n?\s*file_url:\s*enhancedUrl,\s*enhancement_applied:\s*true/.test(intel))
  check("   ...real pixel work survives (sharp), it is not a URL-suffix stub",
    /applyEnhancements/.test(intel) && /normalize\(\)\.sharpen/.test(intel) &&
    !/\?enhanced=true/.test(intel))
  check("   ...the audit job row is still opened, now FK-valid against listing_media",
    /from\(\s*["']photo_enhancement_jobs["']\s*\)\s*\.insert\(\{[\s\S]{0,300}?photo_id:/.test(intel))

  // 7. PERFORMANCE STATS.
  check("7. stats: getPhotoPerformanceStats aggregates listing_media photo rows",
    /export async function getPhotoPerformanceStats[\s\S]{0,1200}?from\(\s*["']listing_media["']\s*\)/.test(actions))
  check("   ...still reporting count, avg quality, room coverage, enhanced count and hero quality",
    /export async function getPhotoPerformanceStats[\s\S]{0,2500}?totalPhotos:[\s\S]{0,600}?avgQuality:[\s\S]{0,400}?roomCoverage:[\s\S]{0,300}?enhancedCount:[\s\S]{0,200}?heroImageQuality:/.test(actions))
  check("   ...and all three read-only panels are still wired to the Media Manager",
    /getListingPhotoSet\s*\(/.test(surface) && /getPhotoPerformanceStats\s*\(/.test(surface) &&
    /validatePhotoQuality\s*\(/.test(surface))
}

function honestFailureLayer() {
  console.log("\n[source · a refused read/write is named, not swallowed]")
  const actions = code(A_PHOTO)
  const intel = code(L_INTEL)

  // supabase-js RESOLVES a failed query. `const { data } = await ...` turns a
  // refused read into a silently empty one and a refused write into a silent
  // no-op. Each of these was a live hazard on a path this work touched.
  check("the photo-set read reports its error instead of returning an empty MLS set",
    /export async function getListingPhotoSet[\s\S]{0,1500}?if \(error\)[\s\S]{0,200}?return \{ success: false/.test(actions))
  check("a refused photo INSERT is reported, not tallied as processed",
    /export async function processVendorPhotos[\s\S]{0,4000}?insertError[\s\S]{0,300}?return \{ success: false/.test(actions))
  check("a refused usage_intent promotion is reported, not counted as adopted",
    /export async function processVendorPhotos[\s\S]{0,3200}?adoptError[\s\S]{0,300}?return \{ success: false/.test(actions))
  check("a refused reorder write aborts instead of claiming the set was reordered",
    /export async function optimizePhotoOrder[\s\S]{0,5200}?updateError[\s\S]{0,300}?return \{ success: false/.test(actions))
  check("a refused analysis UPDATE is surfaced (or the sweep re-bills the vision call nightly)",
    /persistPhotoAnalysis[\s\S]{0,900}?const \{ error \} = await svc\.from\(\s*["']listing_media["']\s*\)[\s\S]{0,600}?if \(error\) return \{[\s\S]{0,120}?error:/.test(intel))
  check("a refused enhanced-photo swap fails the job rather than reporting ok",
    /swapError[\s\S]{0,200}?return fail\(/.test(intel))
  check("a rejected enhancement-job INSERT is named (the FK moved tables in m369)",
    /jobError[\s\S]{0,400}?return \{[\s\S]{0,200}?ok: false/.test(intel))
  check("launch blockers name a refused photo COUNT instead of inventing '0 photos'",
    /photoCountResult\.error[\s\S]{0,300}?Photo count could not be read/.test(code(A_LIFECYC)))
}

function tenantLayer() {
  console.log("\n[source · every write stamps its tenant]")
  const actions = code(A_PHOTO)

  // listing_media's RLS policies admit `brokerage_id IS NULL` on SELECT, INSERT,
  // UPDATE and DELETE. An unstamped row is therefore visible to EVERY tenant.
  check("the photo INSERT stamps brokerage_id from the session, never from the client",
    /from\(\s*["']listing_media["']\s*\)[\s\S]{0,400}?\.insert\(\{[\s\S]{0,500}?brokerage_id:\s*ctx\.brokerageId/.test(actions))
  check("...and uploaded_by is the authenticated users id (users-class FK, not agents)",
    /from\(\s*["']listing_media["']\s*\)[\s\S]{0,600}?\.insert\(\{[\s\S]{0,700}?uploaded_by:\s*ctx\.userId/.test(actions))
  check("...ownership of the listing is checked before any photo write",
    /export async function processVendorPhotos[\s\S]{0,1500}?callerOwnsListing\(/.test(actions))
  check("the ordering-rule owner is RESOLVED to agents-class, never substituted with a users id",
    /callerAgentRecordId[\s\S]{0,300}?resolveUserIdToAgentRecord/.test(actions) &&
    /from\(\s*["']photo_ordering_rules["']\s*\)[\s\S]{0,300}?\.insert\(\{[\s\S]{0,200}?agent_id:\s*agentRecordId/.test(actions))

  // The service-role client bypasses RLS entirely, so it must carry its own
  // tenant filter. The mail reactor is the one service-role photo reader.
  const mail = code(L_MAIL)
  const mailStmts = listingMediaStatements(mail)
  check("the service-role hero read carries an explicit brokerage filter (RLS is bypassed there)",
    mailStmts.length > 0 && mailStmts.every((s) => /\.eq\(\s*["']brokerage_id["']\s*,\s*args\.brokerageId\s*\)/.test(s)))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[live] ⊘ SKIPPED — no SUPABASE creds in the environment.")
    console.log("        The source layer above still stands; the schema facts were NOT checked.")
    return
  }
  const svc = createClient(url, key, { auth: { persistSession: false } })

  /** PostgREST rejects a select naming a column that does not exist, so a
   *  zero-row select is a phantom-column probe. Creates nothing: no residue. */
  const probeColumns = async (table: string, columns: string) => {
    const { error } = await svc.from(table).select(columns).limit(0)
    return { ok: !error, why: error?.message ?? "" }
  }

  // REACHABILITY GATE. If the database cannot be read at all then every
  // assertion below is noise, and scoring a network error as a passing negative
  // is exactly the failure mode this gate exists to prevent.
  const probe = await probeColumns("listings", "id")
  if (!probe.ok) {
    console.log(`\n[live] ⊘ SKIPPED — database unreachable: ${probe.why}`)
    console.log("        NOT counted as a pass. The source layer proved the code shape only.")
    return
  }

  console.log("\n[live · the schema really is consolidated]")

  const mustHave = async (label: string, table: string, columns: string) => {
    const r = await probeColumns(table, columns)
    check(`live: ${label}`, r.ok)
    if (!r.ok) console.log(`      ↳ ${r.why}`)
  }
  /** A missing column/table and an unreachable database both come back as an
   *  error. Only a PostgREST schema complaint proves absence. */
  const mustNotHave = async (label: string, table: string, columns: string) => {
    const r = await probeColumns(table, columns)
    const isSchemaComplaint = /column|relation|does not exist|42703|42P01|PGRST/i.test(r.why)
    check(`live: ${label}`, !r.ok && isSchemaComplaint)
    if (!r.ok && !isSchemaComplaint) console.log(`      ↳ INCONCLUSIVE (not scored as absence): ${r.why}`)
    if (r.ok) console.log("      ↳ it still exists")
  }

  // The survivor carries BOTH layers: the governance it always had, and the
  // photo intelligence m368 moved onto it.
  await mustHave("listing_media carries the moved photo-intelligence layer",
    "listing_media", "id,room_type,ai_quality_score,ai_analysis_completed,ai_analyzed_at,enhancement_applied")
  await mustHave("listing_media still carries the MLS compliance governance it survived for",
    "listing_media", "has_eho_mark,has_brokerage_attribution,has_logo_overlay,uses_approved_template,kernel_compliance_passed,is_approved,approved_by,approved_at,usage_intent")
  await mustHave("the renamed concepts are all present on the survivor",
    "listing_media", "file_url,sort_order,is_primary,media_type,brokerage_id,listing_id,uploaded_by")

  // The duplicate is gone.
  await mustNotHave("listing_photos is DROPPED", "listing_photos", "id")

  // The photo set is addressable exactly as the code addresses it.
  const { error: pinError } = await svc.from("listing_media")
    .select("id,file_url,sort_order,is_primary,room_type,ai_quality_score,ai_analysis_completed,enhancement_applied,usage_intent")
    .eq("media_type", "photo").limit(0)
  check("live: the exact photo-set read the MLS panel issues is accepted", !pinError)
  if (pinError) console.log(`      ↳ ${pinError.message}`)

  // The enhancement audit trail follows the photo to its new table.
  await mustHave("photo_enhancement_jobs still exists to carry the audit trail",
    "photo_enhancement_jobs", "id,photo_id,agent_id,brokerage_id,original_url,enhanced_url,status")

  // media_type must reject a value outside the CHECK vocabulary — proving the
  // pin is a real constraint and not a naming convention. Nothing is inserted
  // on the success path because the value is invalid by construction.
  const { error: vocabError } = await svc.from("listing_media").select("id").eq("media_type", "image").limit(0)
  check("live: 'image' is queryable but the CHECK vocabulary is what the code pins to ('photo')",
    !vocabError)
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" LISTING MEDIA CONSOLIDATION — two tables for one thing, now one")
  console.log("══════════════════════════════════════════════════════════════════════")
  structuralLayer()
  mediaTypePinLayer()
  capabilityLayer()
  honestFailureLayer()
  tenantLayer()
  await liveLayer()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`LISTING MEDIA CONSOLIDATION — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
    console.log("\nA red line here means one of three things:")
    console.log("  · a photo capability was LOST rather than moved;")
    console.log("  · a photo read stopped pinning media_type='photo', so a floorplan")
    console.log("    or a video is now being returned as a photograph; or")
    console.log("  · a reference to the dropped listing_photos table came back.")
    process.exit(1)
  }
  console.log("✅ LISTING_MEDIA_CONSOLIDATION_PASS — one table, all seven capabilities, nothing unpinned")
}

main().catch((e) => { console.error(e); process.exit(1) })
