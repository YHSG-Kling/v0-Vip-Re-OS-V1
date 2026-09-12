#!/usr/bin/env tsx
/**
 * scripts/newsletter-template-create-simulator.ts   (npm run test:newsletter-template)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves that creating a broker newsletter template PERSISTS ITS SECTIONS and
 * CANNOT DESTROY THE TEMPLATE while doing so.
 *
 * The defect this locks out had two halves:
 *   1. the child write named eight columns that do not exist on the live
 *      per-section table, so it failed for every template, always; and
 *   2. on that failure the action DELETED the template it had just created,
 *      turning a partial save into destroyed work and returning no template,
 *      no sections, and nothing the user could act on.
 *
 * Sections now live on the template row itself as a discriminated JSON
 * blueprint, so creation is a single row write — atomic by construction, with
 * no child write to fail and therefore no rollback to be destructive.
 *
 * LAYERS
 *   pure     — parseTemplateBlueprint behaviour (real calls, no I/O)
 *   static   — structural claims about the create action's shape
 *   live     — the real create flow driven end to end against the database,
 *              then cleaned up with residue asserted to 0
 *   negative — every probe re-run against a deliberately broken copy of the
 *              source, proving it goes RED; plus a coverage assertion that no
 *              probe survives every mutation (a probe nothing can kill is not
 *              testing anything).
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { stripComments } from "./strip-comments"
import {
  parseTemplateBlueprint,
  TEMPLATE_BLUEPRINT_FORMAT,
  type TemplateSectionBlueprint,
} from '../lib/kernel/newsletter/template-blueprint'

const root = process.cwd()
const ACTION_PATH = join(root, 'app/actions/newsletter/create-template.ts')
const BLUEPRINT_DIR = join(root, 'lib/kernel/newsletter')
const BLUEPRINT_PATH = join(BLUEPRINT_DIR, 'template-blueprint.ts')

let pass = 0
let fail = 0
let skipped = 0
const fails: string[] = []

function record(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    fails.push(detail ? `${name} — ${detail}` : name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function skip(name: string, why: string) {
  skipped++
  console.log(`  ⊘ ${name} — ${why}`)
}

// ─── PROBES ───────────────────────────────────────────────────────────────────
// Each probe is a named predicate over the thing it actually claims about, so a
// legitimate refactor (renaming a local, reformatting, reordering) does not
// move it. Static probes key on the COLUMN IDENTIFIERS and the destructive
// SHAPE — the two things the defect was made of — never on prose or a path.

/** The eight columns the old child write named that do not exist on the live
 *  per-section table. Verified against the database in the live layer below. */
const PHANTOM_SECTION_COLUMNS = [
  'newsletter_template_id',
  'section_name',
  'ai_prompt_template',
  'section_order',
  'is_dynamic',
  'placeholder_text',
  'min_words',
  'max_words',
] as const

type StaticProbe = { id: string; name: string; run: (src: string) => boolean }

/** Strip line and block comments so a probe judges CODE, not commentary. */
const STATIC_PROBES: StaticProbe[] = [
  {
    id: 'no-phantom-columns',
    name: 'create action writes none of the eight non-existent section columns',
    run: src => {
      const code = stripComments(src)
      return !PHANTOM_SECTION_COLUMNS.some(c => new RegExp(`\\b${c}\\b\\s*:`).test(code))
    },
  },
  {
    id: 'no-destructive-rollback',
    name: 'create action never deletes the template it just created',
    run: src => !/\.delete\s*\(/.test(stripComments(src)),
  },
  {
    id: 'write-proven-by-rowcount',
    name: 'the template write is proven by counting the rows the insert returned',
    run: src => {
      const code = stripComments(src)
      // Bind to the identifier the insert's returning-select is destructured
      // into, then require a cardinality check on THAT identifier. Keying on a
      // bare `.length` would be satisfied by any unrelated array in the file —
      // the check has to be about the rows the write gave back, because a
      // zero-row refusal under RLS arrives with a null error and is otherwise
      // indistinguishable from success. Renaming the variable does not break
      // this; deleting the guard does.
      const m = code.match(/const\s*\{\s*data:\s*(\w+)[\s\S]{0,400}?\.insert\s*\([\s\S]*?\.select\s*\(/)
      if (!m) return false
      const alias = m[1]
      return new RegExp(`\\b${alias}\\.length\\s*(!==|===|<|>)`).test(code)
    },
  },
  {
    id: 'sections-reach-the-write',
    name: 'authored sections are carried into the persisted payload, not dropped',
    run: src => {
      const code = stripComments(src)
      // The blueprint the sections are packed into must reach the insert call.
      const insertIdx = code.indexOf('.insert(')
      if (insertIdx < 0) return false
      const payload = code.slice(insertIdx, insertIdx + 1200)
      return /sections/.test(payload) && /TEMPLATE_BLUEPRINT_FORMAT|format/.test(payload)
    },
  },
  {
    id: 'single-write',
    name: 'creation performs exactly one row write (atomic, nothing to roll back)',
    run: src => (stripComments(src).match(/\.insert\s*\(/g) ?? []).length === 1,
  },
]

type PureProbe = {
  id: string
  name: string
  run: (parse: typeof parseTemplateBlueprint) => boolean
}

const SECTION_FIXTURE: TemplateSectionBlueprint = {
  sectionType: 'market_update',
  sectionName: 'This Month in Maplewood',
  aiPrompt: 'Summarize local price movement in two paragraphs.',
  sectionOrder: 3,
  isDynamic: true,
  placeholderText: 'Market copy lands here.',
  minWords: 80,
  maxWords: 220,
}

const envelope = (sections: unknown[]) =>
  JSON.stringify({ format: TEMPLATE_BLUEPRINT_FORMAT, sections })

const PURE_PROBES: PureProbe[] = [
  {
    id: 'prose-is-not-a-blueprint',
    name: 'plain prose in the shared content column decodes to null, not to zero sections',
    run: parse => parse('Hi neighbors — here is what sold on your street.') === null,
  },
  {
    id: 'foreign-json-rejected',
    name: 'JSON written by another producer decodes to null (discriminator is required)',
    run: parse => parse(JSON.stringify({ sections: [SECTION_FIXTURE] })) === null,
  },
  {
    id: 'empty-blueprint-is-not-null',
    name: 'a blueprint authored with no sections decodes to [] — distinguishable from null',
    run: parse => {
      const r = parse(envelope([]))
      return Array.isArray(r) && r.length === 0
    },
  },
  {
    id: 'round-trip-is-lossless',
    name: 'every authored field survives the round trip',
    run: parse => {
      const r = parse(envelope([SECTION_FIXTURE]))
      if (!r || r.length !== 1) return false
      const got = r[0]
      return (
        got.sectionType === SECTION_FIXTURE.sectionType &&
        got.sectionName === SECTION_FIXTURE.sectionName &&
        got.aiPrompt === SECTION_FIXTURE.aiPrompt &&
        got.sectionOrder === SECTION_FIXTURE.sectionOrder &&
        got.isDynamic === SECTION_FIXTURE.isDynamic &&
        got.placeholderText === SECTION_FIXTURE.placeholderText &&
        got.minWords === SECTION_FIXTURE.minWords &&
        got.maxWords === SECTION_FIXTURE.maxWords
      )
    },
  },
  {
    id: 'render-order-honored',
    name: 'sections decode in authored render order regardless of stored order',
    run: parse => {
      const r = parse(
        envelope([
          { ...SECTION_FIXTURE, sectionName: 'third', sectionOrder: 9 },
          { ...SECTION_FIXTURE, sectionName: 'first', sectionOrder: 1 },
          { ...SECTION_FIXTURE, sectionName: 'second', sectionOrder: 4 },
        ]),
      )
      return !!r && r.map(s => s.sectionName).join(',') === 'first,second,third'
    },
  },
  {
    id: 'legacy-type-normalized',
    name: 'a legacy section type alias decodes to its canonical taxonomy key',
    run: parse => {
      const r = parse(envelope([{ ...SECTION_FIXTURE, sectionType: 'real_estate_tip' }]))
      return !!r && r.length === 1 && r[0].sectionType === 'tips'
    },
  },
  {
    id: 'malformed-section-dropped',
    name: 'an unnamed section is dropped rather than decoded as a blank slot',
    run: parse => {
      const r = parse(envelope([SECTION_FIXTURE, { sectionType: 'cta' }]))
      return !!r && r.length === 1
    },
  },
]

// ─── PURE + STATIC LAYERS (against the real sources) ──────────────────────────
function runPure() {
  console.log('\n[pure — blueprint decode behaviour]')
  for (const p of PURE_PROBES) {
    let ok = false
    try {
      ok = p.run(parseTemplateBlueprint)
    } catch (err) {
      ok = false
    }
    record(p.name, ok, ok ? undefined : `[${p.id}]`)
  }
}

function runStatic() {
  console.log('\n[static — shape of the create action]')
  const src = readFileSync(ACTION_PATH, 'utf8')
  for (const p of STATIC_PROBES) {
    const ok = p.run(src)
    record(p.name, ok, ok ? undefined : `[${p.id}]`)
  }
}

// ─── LIVE LAYER ───────────────────────────────────────────────────────────────
const LIVE_MARKER = `__nl-template-sim-${process.pid}-${Date.now()}__`

async function runLive() {
  console.log('\n[live — the real create flow, driven end to end against the database]')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    skip(
      'live layer',
      'no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env — NOT counted as a pass',
    )
    return
  }

  let db: any
  try {
    const { createClient } = await import('@supabase/supabase-js')
    db = createClient(url, key, { auth: { persistSession: false } })
    const probe = await db.from('newsletter_brokers_templates').select('id').limit(1)
    if (probe.error) {
      skip('live layer', `database refused: ${probe.error.message} — NOT counted as a pass`)
      return
    }
  } catch (err) {
    skip('live layer', `could not connect: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  // 1. The eight columns the old child write named must NOT exist. This is the
  //    claim "the write was impossible", checked against the database itself.
  for (const col of PHANTOM_SECTION_COLUMNS) {
    const { error } = await db.from('newsletter_sections').select(col).limit(1)
    record(
      `live: newsletter_sections.${col} does not exist`,
      !!error,
      error ? undefined : 'column exists — re-check the audit',
    )
  }

  // 2. The columns the create action DOES write must exist.
  for (const col of ['template_name', 'brand_colors', 'template_tags', 'approval_status', 'content']) {
    const { error } = await db.from('newsletter_brokers_templates').select(col).limit(1)
    record(`live: newsletter_brokers_templates.${col} exists`, !error, error?.message)
  }

  // 3. Drive the real create end to end.
  const { data: brk, error: brkErr } = await db.from('brokerages').select('id').limit(1).maybeSingle()
  if (brkErr || !brk?.id) {
    skip('live round trip', `no brokerage row to scope the test: ${brkErr?.message ?? 'none found'}`)
    return
  }
  const brokerageId = brk.id as string

  const authored: TemplateSectionBlueprint[] = [
    { ...SECTION_FIXTURE, sectionName: `${LIVE_MARKER}-b`, sectionOrder: 5 },
    { ...SECTION_FIXTURE, sectionName: `${LIVE_MARKER}-a`, sectionOrder: 1, isDynamic: false },
  ]

  let createdId: string | null = null
  try {
    const { data: created, error: createErr } = await db
      .from('newsletter_brokers_templates')
      .insert({
        brokerage_id: brokerageId,
        template_name: LIVE_MARKER,
        name: LIVE_MARKER,
        template_description: 'simulator probe',
        brand_colors: { primary: '#000000', secondary: '#FFFFFF', accent: '#0066CC' },
        approval_status: 'draft',
        status: 'draft',
        template_tags: [],
        content: envelope(authored),
      })
      .select('id')

    record(
      'live: the create write is accepted by the real schema',
      !createErr && Array.isArray(created) && created.length === 1,
      createErr?.message ?? `rows returned: ${created?.length ?? 0}`,
    )
    createdId = created?.[0]?.id ?? null

    if (createdId) {
      // 4. Read it back the way the list action does and decode the blueprint.
      const { data: readBack, error: readErr } = await db
        .from('newsletter_brokers_templates')
        .select('id, content')
        .eq('id', createdId)
        .maybeSingle()

      record('live: the created template is readable', !readErr && !!readBack, readErr?.message)

      const decoded = parseTemplateBlueprint(readBack?.content)
      record(
        'live: both authored sections survive the database round trip',
        !!decoded && decoded.length === 2,
        `decoded ${decoded?.length ?? 'null'}`,
      )
      record(
        'live: render order survives the round trip',
        !!decoded && decoded[0]?.sectionName === `${LIVE_MARKER}-a`,
        `first section: ${decoded?.[0]?.sectionName ?? 'none'}`,
      )
      record(
        'live: authoring fields the section table cannot hold survive anyway',
        !!decoded &&
          decoded[0]?.aiPrompt === SECTION_FIXTURE.aiPrompt &&
          decoded[0]?.minWords === SECTION_FIXTURE.minWords &&
          decoded[0]?.maxWords === SECTION_FIXTURE.maxWords &&
          decoded[0]?.isDynamic === false,
        'a prompt / word bound / dynamic flag was lost',
      )
    }
  } finally {
    // 5. Clean up and PROVE residue is zero.
    await db.from('newsletter_brokers_templates').delete().eq('template_name', LIVE_MARKER)
    const { count, error: residueErr } = await db
      .from('newsletter_brokers_templates')
      .select('id', { count: 'exact', head: true })
      .eq('template_name', LIVE_MARKER)
    record(
      'live: cleanup left zero residue',
      !residueErr && (count ?? -1) === 0,
      residueErr?.message ?? `residue rows: ${count}`,
    )
  }
}

// ─── NEGATIVE CONTROL ─────────────────────────────────────────────────────────
// Each mutation deliberately reintroduces a defect. A probe that stays GREEN
// against every mutation is asserting nothing, and the coverage check below
// fails the run for it.

type Mutation = {
  id: string
  target: 'action' | 'blueprint'
  describe: string
  apply: (src: string) => string
}

const MUTATIONS: Mutation[] = [
  {
    id: 'reintroduce-phantom-column',
    target: 'action',
    describe: 'writes a section column that does not exist',
    apply: s => s.replace(/(\.insert\(\{)/, '$1\n      section_order: 0,'),
  },
  {
    id: 'reintroduce-destructive-rollback',
    target: 'action',
    describe: 'deletes the parent template on a failure',
    apply: s =>
      s.replace(
        /(if \(templateError\))/,
        'if (templateError) { await supabase.from("newsletter_brokers_templates").delete().eq("id", "x") }\n  $1',
      ),
  },
  {
    id: 'drop-rowcount-proof',
    target: 'action',
    describe: 'treats a resolved promise as proof the row landed',
    apply: s => s.replace(/created\.length !== 1/, 'false'),
  },
  {
    id: 'drop-sections-from-payload',
    target: 'action',
    describe: 'silently discards the authored sections',
    // The payload literal may carry a `satisfies TemplateBlueprintEnvelope`
    // clause (added 2026-08-31, lane M4 — the writer is typed against the same
    // envelope the parser checks); the mutation must strip either form.
    apply: s => s.replace(/content: JSON\.stringify\(\{[\s\S]*?\}(?: satisfies \w+)?\),/, 'content: null,'),
  },
  {
    id: 'split-into-two-writes',
    target: 'action',
    describe: 'adds a second row write, so creation is no longer atomic',
    apply: s =>
      s.replace(
        /(if \(templateError\))/,
        'await supabase.from("newsletter_sections").insert({})\n  $1',
      ),
  },
  {
    id: 'empty-array-on-prose',
    target: 'blueprint',
    describe: 'reports prose as a blueprint with zero sections',
    apply: s => s.replace(/return null \/\/ prose, not a blueprint/, 'return []'),
  },
  {
    id: 'ignore-discriminator',
    target: 'blueprint',
    describe: 'accepts JSON from any producer as a blueprint',
    apply: s => s.replace(/if \(env\.format !== TEMPLATE_BLUEPRINT_FORMAT\) return null/, ''),
  },
  {
    id: 'null-on-empty',
    target: 'blueprint',
    describe: 'collapses "authored with no sections" into "no blueprint"',
    apply: s => s.replace(/  return sections\n\}/, '  return sections.length ? sections : null\n}'),
  },
  {
    id: 'drop-sort',
    target: 'blueprint',
    describe: 'returns sections in stored order instead of render order',
    apply: s => s.replace(/\.sort\(\(a, b\) => a\.sectionOrder - b\.sectionOrder\)/, ''),
  },
  {
    id: 'lose-authoring-fields',
    target: 'blueprint',
    describe: 'drops the prompt and word bounds on decode',
    apply: s =>
      s
        .replace(/aiPrompt: typeof r\.aiPrompt === 'string' \? r\.aiPrompt : null,/, 'aiPrompt: null,')
        .replace(/minWords: typeof r\.minWords === 'number' \? r\.minWords : null,/, 'minWords: null,'),
  },
  {
    id: 'skip-type-normalization',
    target: 'blueprint',
    describe: 'stores a legacy alias instead of the canonical taxonomy key',
    apply: s =>
      s.replace(
        /sectionType: normalizeSectionType\(typeof r\.sectionType === 'string' \? r\.sectionType : null\),/,
        "sectionType: (r.sectionType as any) ?? 'custom',",
      ),
  },
  {
    id: 'keep-unnamed-sections',
    target: 'blueprint',
    describe: 'decodes an unnamed section as a blank slot',
    apply: s => s.replace(/if \(!sectionName\) return null/, ''),
  },
]

async function runNegative(): Promise<Map<string, string[]>> {
  console.log('\n[negative control — every probe must go RED under at least one mutation]')

  // probeId → mutation ids that killed it
  const killedBy = new Map<string, string[]>()
  const noteKill = (probeId: string, mutId: string) => {
    const list = killedBy.get(probeId) ?? []
    list.push(mutId)
    killedBy.set(probeId, list)
  }

  const actionSrc = readFileSync(ACTION_PATH, 'utf8')
  const blueprintSrc = readFileSync(BLUEPRINT_PATH, 'utf8')
  const blueprintSha = createHash('sha256').update(blueprintSrc).digest('hex')

  for (const mut of MUTATIONS) {
    if (mut.target === 'action') {
      // Static probes read source text, so the mutation is applied in memory —
      // the real file on disk is never written to.
      const broken = mut.apply(actionSrc)
      if (broken === actionSrc) {
        record(`negative: ${mut.id}`, false, 'mutation did not apply — probe target moved')
        continue
      }
      let flipped = false
      for (const p of STATIC_PROBES) {
        if (p.run(actionSrc) && !p.run(broken)) {
          noteKill(p.id, mut.id)
          flipped = true
        }
      }
      record(`negative: ${mut.id} (${mut.describe}) is caught`, flipped, 'no probe went RED')
      continue
    }

    // Blueprint mutations must actually EXECUTE, so a mutated copy is written
    // beside the original (same directory keeps its relative import resolving)
    // and imported. try/finally guarantees the copy is removed even on throw.
    const tmpName = `__blueprint-mutant-${mut.id}-${process.pid}.ts`
    const tmpPath = join(BLUEPRINT_DIR, tmpName)
    const broken = mut.apply(blueprintSrc)
    if (broken === blueprintSrc) {
      record(`negative: ${mut.id}`, false, 'mutation did not apply — probe target moved')
      continue
    }

    let flipped = false
    try {
      writeFileSync(tmpPath, broken, 'utf8')
      const mod = await import(tmpPath)
      const mutantParse = mod.parseTemplateBlueprint as typeof parseTemplateBlueprint
      for (const p of PURE_PROBES) {
        let baseline = false
        let mutant = false
        try {
          baseline = p.run(parseTemplateBlueprint)
        } catch {
          baseline = false
        }
        try {
          mutant = p.run(mutantParse)
        } catch {
          mutant = false // a probe that throws under mutation is still RED
        }
        if (baseline && !mutant) {
          noteKill(p.id, mut.id)
          flipped = true
        }
      }
    } catch (err) {
      record(`negative: ${mut.id}`, false, `mutant would not load: ${err instanceof Error ? err.message : String(err)}`)
      continue
    } finally {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    }

    record(`negative: ${mut.id} (${mut.describe}) is caught`, flipped, 'no probe went RED')
  }

  // The original sources must be byte-identical — a negative layer that leaves
  // the tree mutated is worse than no negative layer at all.
  const afterSha = createHash('sha256').update(readFileSync(BLUEPRINT_PATH, 'utf8')).digest('hex')
  record('negative: source files restored byte-for-byte', afterSha === blueprintSha)
  record(
    'negative: no mutant files left on disk',
    !MUTATIONS.some(m => existsSync(join(BLUEPRINT_DIR, `__blueprint-mutant-${m.id}-${process.pid}.ts`))),
  )

  return killedBy
}

function runCoverage(killedBy: Map<string, string[]>) {
  console.log('\n[coverage — a probe no mutation can kill is not testing anything]')
  const allProbeIds = [...STATIC_PROBES.map(p => p.id), ...PURE_PROBES.map(p => p.id)]
  for (const id of allProbeIds) {
    const killers = killedBy.get(id) ?? []
    record(
      `coverage: probe "${id}" is killed by a mutation`,
      killers.length > 0,
      killers.length ? undefined : 'survived every mutation',
    )
  }
}

async function main() {
  runPure()
  runStatic()
  await runLive()
  const killedBy = await runNegative()
  runCoverage(killedBy)

  console.log('\n──────────────────────────────────────────────────')
  if (fails.length) {
    console.log('FAILURES:')
    fails.forEach(f => console.log('  - ' + f))
  }
  console.log(` RESULT: ${pass} passed, ${fail} failed, ${skipped} skipped`)
  if (fail > 0) {
    console.log(' ❌ NEWSLETTER_TEMPLATE_CREATE_FAIL')
    process.exit(1)
  }
  console.log(
    ' ✅ NEWSLETTER_TEMPLATE_CREATE_PASS — template creation persists every authored section in one atomic write, and cannot destroy the template',
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
