/**
 * scripts/canaries/wave146-managers-ui.ts — MANAGERS / UI canary (wave 146, lane 146J; owner rulings 14, 15, 16, 18 — lanes 146G,
 * 146H, 146I):
 *   RULING 14 — "Managers should be allowed to change policies if they align with the business process and can heal the playbook
 *     edit code": SAFE operational adaptation may be applied by a manager within its authority with evidence; CONSEQUENTIAL change
 *     (financial calculations, legal/compliance, RLS/security, tenant authority, production source edits, credentials, destructive
 *     schema, money movement) is a proposal for a human; a broken workflow is an incident DETECT → DIAGNOSE → OWNER → SAFE REPAIR /
 *     PROPOSAL → VERIFY → NOTIFY / ESCALATE; no manager mutates production code (preserve).
 *   RULING 15 — "Duplicate actions that don't have a provable survivor shouldn't be retired until there is proof they aren't
 *     beneficial": every name of the wave-145 duplicate census is retired only with its survivor named (file:line) and every caller
 *     migrated, or kept with its dependency recorded.
 *   RULING 16 — "one consistent high-contrast palette": the design tokens' text pairs meet WCAG AA (4.5:1) in light AND dark.
 *   RULING 18 — every role's journeys audited on their real surfaces (BUILT / PARTIAL / UNWIRED / MISSING).
 *   The wave-146 canaries themselves have a registered owning manager (lane 146I owns the registry).
 *
 * Through the survivors at bf67aa63: lib/kernel/improvement-proposals.ts, lib/kernel/self-healing.ts, app/globals.css (the HSL design
 * tokens), lib/kernel/manager-registry.ts, the census fixture (fixtures/wave146-duplicate-census.json, from lane 145I's dups.txt).
 *
 * MEASURED AT bf67aa63: the light theme's destructive pair (0 84.2% 60.2% on 210 40% 98%) is ~3.6:1 — below AA; no manager-governance
 * classifier, incident chain, governance record or capability-surface audit exists; test:wave146-canaries has no owner.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, listFiles, readRepo, strippedRepo } from "./_registry"
import { stripComments } from "../strip-comments"
import { quiet } from "./wave145-harness"
import { canary146, jsonOf, errText } from "./wave146-harness"
import { landedModule } from "./_harness"

// ── WAVE146 BIND (lanes 146G / 146H / 146I notes, "## Canary requirements") ── not published at the time of writing.

// ── WCAG contrast over the HSL tokens (pure) ──
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255)) as [number, number, number]
}
export function luminance([r, g, b]: [number, number, number]): number {
  const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}
export function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
/** The `--token: H S% L%;` values of one CSS block (the first `selector {` … `}`). */
export function tokensOf(css: string, selector: RegExp): Record<string, [number, number, number]> {
  const at = css.search(selector)
  if (at < 0) return {}
  const block = css.slice(at, css.indexOf("}", at))
  const out: Record<string, [number, number, number]> = {}
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/g)) out[m[1]] = hslToRgb(Number(m[2]), Number(m[3]), Number(m[4]))
  return out
}
const existsSyncRel = (rel: string): boolean => existsSync(join(ROOT, rel))
const TEXT_PAIRS: Array<[string, string]> = [
  ["background", "foreground"], ["card", "card-foreground"], ["popover", "popover-foreground"], ["primary", "primary-foreground"],
  ["secondary", "secondary-foreground"], ["accent", "accent-foreground"], ["destructive", "destructive-foreground"], ["background", "muted-foreground"],
]

export async function run() {
  const c = canary146("Managers/UI: no manager mutates production code · safe adaptation applied within authority, consequential change proposed to a human · incidents run DETECT→…→ESCALATE · duplicates retired only with proof · one high-contrast palette · every role's journeys audited · the wave-146 canaries owned")

  // ── 1 · PRESERVE: no manager mutates production code (wave 145 lane 145I item 3; ruling 14 'no unrestricted code-edit/deploy rights') ──
  const ip = await quiet(async () => import("../../lib/kernel/improvement-proposals")) as unknown as Record<string, any>
  const sh = await quiet(async () => import("../../lib/kernel/self-healing")) as unknown as Record<string, any>
  const CODE_ACTION = /code|deploy|migration|schema|sql|release|commit/i
  const codeKinds = (ip.PROPOSAL_SUBJECT_KINDS as readonly string[]).filter((k) => CODE_ACTION.test(k))
  const codePlaybooks = Object.entries(sh.SELF_HEAL_PLAYBOOKS as Record<string, { label: string }>).filter(([k, v]) => CODE_ACTION.test(k) || /\b(deploy|migration|commit|release|code change)\b/i.test(v.label)).map(([k]) => k)
  const deployRefused = !sh.validatePlaybookSelection("provider", { playbook: "deploy_fix" }, new Set(["deploy_fix"])).ok
  const retryOk = sh.validatePlaybookSelection("provider", { playbook: "retry" }, new Set(["retry"])).ok
  c.rule("146G", "NO MANAGER MUTATES PRODUCTION CODE ON ITS OWN (ruling 14: 'production source edits … require human approval, versioned change control, tests and deployment authorization … no unrestricted code-edit/deploy rights'; green, preserve): no improvement-proposal subject kind and no self-healing playbook is a code / deploy / migration / schema / SQL / release action; an invented 'deploy_fix' playbook is REFUSED even with an executor offered (positive control: a declared 'retry' with its executor is accepted)",
    codeKinds.length === 0 && codePlaybooks.length === 0 && deployRefused && retryOk, `code-like proposal kinds ${codeKinds.join(",") || "none"}; code-like playbooks ${codePlaybooks.join(",") || "none"}; deploy_fix refused ${deployRefused}; retry accepted ${retryOk}`)

  // ── 2 · RULING 14: safe adaptation vs consequential change — one classifier on the existing rails, driven on specimens ──
  // WAVE146 BIND (lane 146G patch, 18:22Z): lib/kernel/improvement-proposals.ts SAFE_ADAPTATION_CLASSES · CONSEQUENTIAL_CHANGE_CLASSES ·
  // governedChangeVerdict (the ONE verdict constructor) · classifyGovernedChange (derived from the change, never the stored rung).
  // Asserted by MEANING: each RULED concept is on the right list, and the verdict for it lets a manager apply (safe) or only propose
  // with human approval + versioning + tests + deployment authorization (consequential); an unlisted change fails closed.
  await c.check("146G", "SAFE ADAPTATION IS A MANAGER'S TO APPLY; CONSEQUENTIAL CHANGE IS A HUMAN'S TO APPROVE (ruling 14: 'SAFE operational adaptation (approved playbook parameters, provider failover, retry, notification routing, content/channel selection, approved self-healing repair) may be proposed AND applied by a manager within its authority with evidence; CONSEQUENTIAL changes (financial calculations, legal/compliance, RLS/security, tenant authority, production source edits, credentials, destructive schema, money movement) require human approval, versioned change control, tests and deployment authorization'): every ruled safe concept is a class a manager may APPLY within its authority; every ruled consequential concept is a class a manager may only PROPOSE, needing a human approval, a versioned change, tests and a deployment authorization; a change on neither list is consequential (fail closed); a proposed law-rule change classifies consequential and a measured variant safe", async () => {
    const ipm = ip as Record<string, any>
    if (typeof ipm.governedChangeVerdict !== "function" || !Array.isArray(ipm.SAFE_ADAPTATION_CLASSES) || !Array.isArray(ipm.CONSEQUENTIAL_CHANGE_CLASSES)) return { ok: false, evidence: "lib/kernel/improvement-proposals.ts carries no governedChangeVerdict / SAFE_ADAPTATION_CLASSES / CONSEQUENTIAL_CHANGE_CLASSES (lane 146G: ruling 14 on the existing proposal rail)" }
    const SAFE_CONCEPTS: Array<[string, RegExp]> = [["playbook parameters", /playbook/], ["provider failover", /failover/], ["retry", /retry/], ["notification routing", /notif/], ["content/channel selection", /channel|content/], ["self-healing repair", /heal|repair/]]
    const CONSEQ_CONCEPTS: Array<[string, RegExp]> = [["financial calculations", /financ/], ["legal/compliance", /legal|complian/], ["RLS/security", /rls|security/], ["tenant authority", /authority/], ["production source edits", /source|code/], ["credentials", /credential/], ["destructive schema", /schema|destructive/], ["money movement", /money/]]
    const safe = ipm.SAFE_ADAPTATION_CLASSES as string[], conseq = ipm.CONSEQUENTIAL_CHANGE_CLASSES as string[]
    const safeMissing = SAFE_CONCEPTS.filter(([, re]) => !safe.some((k) => re.test(k))).map(([k]) => k)
    const conseqMissing = CONSEQ_CONCEPTS.filter(([, re]) => !conseq.some((k) => re.test(k))).map(([k]) => k)
    const v = (cls: string) => jsonOf(ipm.governedChangeVerdict(cls, "canary"))
    const APPLY = /apply_within_authority|"verdict"\s*:\s*"safe"/, HUMAN_ALL = (j: string) => /human/.test(j) && /version/.test(j) && /test/.test(j) && /deploy/.test(j) && !/apply_within_authority/.test(j)
    const safeBad = safe.filter((k) => !APPLY.test(v(k)) || /human_approval/.test(v(k)))
    const conseqBad = conseq.filter((k) => !HUMAN_ALL(v(k)))
    const unlisted = v("unlisted"), unlistedOk = HUMAN_ALL(unlisted)
    // THE GATE ITSELF (lane 146G canary requirement 1): promotionDecision refuses a MANAGER promoting a consequential class whatever
    // the rung; a safe class promotes under the same input (control); a tenant-admin HUMAN may promote a consequential one (control).
    let gateOk = false, gateEv = "promotionDecision does not take a governed change yet"
    if (typeof ipm.promotionDecision === "function") {
      const base = { status: "APPROVED", verdict: "pass", authorityRequired: 4, gate: { actorAuthority: 6, autonomy: { allow: true } } }
      const manager = { type: "manager", managerKey: "campaign_orchestrator" }, admin = { type: "user", isTenantAdmin: true, userId: "u-admin" }
      const pd = (actor: unknown, cls: string) => ipm.promotionDecision({ ...base, actor, governedChange: ipm.governedChangeVerdict(cls, "canary") }) as { allow: boolean; reason: string }
      const mgrConseq = conseq.map((k) => ({ k, d: pd(manager, k) })), mgrSafe = safe.map((k) => ({ k, d: pd(manager, k) })), human = conseq.map((k) => ({ k, d: pd(admin, k) }))
      const leaked = mgrConseq.filter((x) => x.d.allow).map((x) => x.k), safeRefused = mgrSafe.filter((x) => !x.d.allow).map((x) => x.k), humanRefused = human.filter((x) => !x.d.allow).map((x) => x.k)
      gateOk = leaked.length === 0 && safeRefused.length === 0 && humanRefused.length === 0
      gateEv = `promotionDecision: manager promotes consequential ${leaked.join(",") || "none"}; manager refused a safe class ${safeRefused.join(",") || "none"}; tenant admin refused ${humanRefused.join(",") || "none"}`
    }
    let derived = "classifyGovernedChange not exported", derivedOk = false
    if (typeof ipm.classifyGovernedChange === "function") {
      const law = jsonOf(ipm.classifyGovernedChange({ subject_kind: "law_rule", subject_key: "fl:disclosure", proposed_change: {} }))
      const variant = jsonOf(ipm.classifyGovernedChange({ subject_kind: "variant", subject_key: "sequence:welcome", proposed_change: {} }))
      derivedOk = HUMAN_ALL(law) && APPLY.test(variant)
      derived = `law_rule → ${HUMAN_ALL(law) ? "consequential" : "NOT held"}; variant → ${APPLY.test(variant) ? "safe" : "NOT safe"}`
    }
    return { ok: safeMissing.length === 0 && conseqMissing.length === 0 && safeBad.length === 0 && conseqBad.length === 0 && unlistedOk && derivedOk && gateOk, evidence: `safe classes ${safe.join(",")} (ruled concepts missing ${safeMissing.join(",") || "none"}; not applicable within authority ${safeBad.join(",") || "none"}); consequential ${conseq.join(",")} (missing ${conseqMissing.join(",") || "none"}; not fully change-controlled ${conseqBad.join(",") || "none"}); unlisted → ${unlistedOk ? "consequential" : "NOT held"}; ${derived}; ${gateEv}` }
  })

  // ── 3 · RULING 14: a broken workflow is an INCIDENT that runs the ruled chain ──
  // WAVE146 BIND (lane 146G patch): lib/kernel/self-healing.ts incidentLifecycle (the six stages as the incident's evidence record) ·
  // governedChangeForDiagnosis (a code-defect fix is a production source edit → consequential; a declared repair is safe) · incidentOwner.
  const STAGES: Array<[string, RegExp]> = [["DETECT", /detect/i], ["DIAGNOSE", /diagnos/i], ["OWNER", /owner/i], ["SAFE REPAIR / PROPOSAL", /repair|proposal|remedy/i], ["VERIFY", /verif/i], ["NOTIFY / ESCALATE", /notif|escalat/i]]
  await c.check("146G", "A BROKEN WORKFLOW IS AN INCIDENT THAT RUNS DETECT → DIAGNOSE → OWNER → SAFE REPAIR / PROPOSAL → VERIFY → NOTIFY / ESCALATE (ruling 14): the incident's lifecycle record on the existing self-healing rail carries all six stages, its OWNER is a registered manager (never nobody), and a diagnosis whose fix is a production source edit is a CONSEQUENTIAL proposal while an ordinary root cause is a SAFE declared repair", async () => {
    const shm = sh as Record<string, any>
    if (typeof shm.incidentLifecycle !== "function" || typeof shm.governedChangeForDiagnosis !== "function") return { ok: false, evidence: "lib/kernel/self-healing.ts carries no incidentLifecycle / governedChangeForDiagnosis (lane 146G: the incident chain on the existing healing rail)" }
    // A specimen HealthIncident (lib/kernel/os-health.ts, the existing incident vocabulary): a transient, idempotent provider failure.
    const incident = { detector: "provider_failures", class: "transient", brokerageId: "b-146g", subjectKey: "provider:sendgrid", subjectId: null, subjectType: "provider", summary: "sendgrid 503s", idempotent: true, failoverAvailable: true }
    const rec = shm.incidentLifecycle(incident, { diagnosis: { rootCause: "provider_outage", confidence: 0.8 }, remedy: { kind: "playbook", ref: "retry", change: { class: "self_healing_repair", verdict: "safe" } }, verify: { verified: true, detail: "probe ok" }, notify: "recovered" }) as Record<string, unknown>
    const keys = Object.keys(rec ?? {})
    const missing = STAGES.filter(([, re]) => !keys.some((k) => re.test(k))).map(([k]) => k)
    const { MANAGERS } = await quiet(async () => import("../../lib/kernel/manager-registry")) as unknown as { MANAGERS?: Record<string, unknown> }
    const owner = String(rec?.owner ?? "")
    const ownerRegistered = !!owner && (!MANAGERS || owner in MANAGERS)
    const code = jsonOf(shm.governedChangeForDiagnosis({ rootCause: "code_defect" })), ordinary = jsonOf(shm.governedChangeForDiagnosis({ rootCause: "provider_outage" }))
    const codeHeld = /propose_only|consequential/.test(code) && /human/.test(code), ordinarySafe = /apply_within_authority|"verdict"\s*:\s*"safe"/.test(ordinary)
    // Lane 146G requirement 5: EVERY detector's incident has a registered owner (never nobody), for every incident class.
    const { HEALTH_DETECTORS } = await quiet(async () => import("../../lib/kernel/os-health")) as unknown as { HEALTH_DETECTORS: readonly string[] }
    const ownerless: string[] = []
    if (typeof shm.incidentOwner === "function") for (const d of HEALTH_DETECTORS) for (const cls of ["transient", "unknown", "compliance", "data_conflict"]) {
      try { const o = String(shm.incidentOwner({ ...incident, detector: d, class: cls })); if (!o || (MANAGERS && !(o in MANAGERS))) ownerless.push(`${d}/${cls}→${o || "∅"}`) } catch (e) { ownerless.push(`${d}/${cls} threw ${errText(e)}`) }
    } else ownerless.push("incidentOwner not exported")
    return { ok: missing.length === 0 && ownerRegistered && codeHeld && ordinarySafe && ownerless.length === 0, evidence: `lifecycle stages ${keys.join(",")} (missing ${missing.join(",") || "none"}); owner ${owner || "∅"} registered ${ownerRegistered}; ${HEALTH_DETECTORS.length} detectors × 4 classes without a registered owner: ${ownerless.slice(0, 4).join(", ") || "none"}; code defect → ${codeHeld ? "consequential proposal" : "NOT held"}; provider outage → ${ordinarySafe ? "safe repair" : "NOT safe"}` }
  })
  // Lane 146G requirement 4: the engine's proposal kinds are never on the auto-applier's SAFE list (read from stripped source; planted control).
  const applier = strippedRepo("lib/agentic-os/connector-auto-applier.ts") ?? ""
  // SAFE_KINDS is an object literal keyed by kind (or a list) — the block is read either way; a kind is ON it as a key or a string.
  const safeBlockOf = (src: string) => { const m = /SAFE_KINDS[^=\n]*=\s*(?:(?:new\s+Set\s*\(\s*)?\[([^\]]*)\]|\{([\s\S]*?)\n\})/.exec(src); return m?.[1] ?? m?.[2] ?? "" }
  const onBlock = (block: string, k: string) => new RegExp(`["']${k}["']|(^|[\\s,{])${k}\\s*:`).test(block)
  const safeKindsBlock = safeBlockOf(applier)
  const engineKinds = ((sh as Record<string, unknown>).ENGINE_PROPOSAL_KINDS ?? []) as readonly string[]
  const onSafe = engineKinds.filter((k) => onBlock(safeKindsBlock, k))
  const plantedCaught = onBlock(safeBlockOf("const SAFE_KINDS: Record<string, X> = {\n  retry_other_actor: { minConfidence: 0.5 },\n  change_request: { minConfidence: 1 },\n}\n"), "change_request") && !onBlock(safeBlockOf("const SAFE_KINDS = {\n  retry_other_actor: { minConfidence: 0.5 },\n}\n"), "change_request")
  c.rule("146G", "A MANAGER'S PROPOSAL FOR A HUMAN IS NEVER AUTO-APPLIED (ruling 14: 'production source edits … require human approval'; lane 146G requirement 4): the self-healing engine's proposal kinds (ENGINE_PROPOSAL_KINDS — exhausted playbooks, change requests) are absent from the connector auto-applier's SAFE_KINDS (stripped source; positive control: a planted change_request on the safe list is caught)",
    engineKinds.length > 0 && safeKindsBlock.length > 0 && onSafe.length === 0 && plantedCaught, `engine kinds ${engineKinds.join(",") || "∅ (not exported yet)"}; SAFE_KINDS ${safeKindsBlock.replace(/\s+/g, " ").slice(0, 120) || "∅"}; on the safe list ${onSafe.join(",") || "none"}; planted control ${plantedCaught}`)

  // ── 4 · RULING 15: a duplicate is retired ONLY with proof (survivor named file:line, every caller migrated) ──
  const census = JSON.parse(readFileSync(join(ROOT, "scripts/canaries/fixtures/wave146-duplicate-census.json"), "utf8")) as { names: Record<string, string[]> }
  const allCode = [...listFiles("app", (f) => /\.tsx?$/.test(f)), ...listFiles("lib", (f) => /\.tsx?$/.test(f))]
  const exportsName = (src: string, n: string) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${n}\\b|export\\s*\\{[^}]*\\b${n}\\b`).test(src)
  // A tombstone = a comment block (up to four consecutive comment lines) naming the retired name AND a survivor `file.ts:NN`.
  const TOMBSTONE = (n: string) => ({
    test: (raw: string): boolean => {
      const lines = raw.split("\n"), isC = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l)
      for (let i = 0; i < lines.length; i++) {
        if (!isC(lines[i])) continue
        const block = lines.slice(i, i + 4).filter(isC).join(" ")
        if (new RegExp(`\\b${n}\\b`).test(block) && /\b[\w./[\]-]+\.tsx?:\d+/.test(block)) return true
      }
      return false
    },
  })
  const retired: string[] = [], unproven: string[] = []
  const importersOf = (name: string, mod: string): string[] => {
    const spec = mod.replace(/\.tsx?$/, "")
    const re = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*["'](?:@\\/)?${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`, "g")
    return allCode.filter((f) => [...(strippedRepo(f) ?? "").matchAll(re)].some((m) => new RegExp(`\\b${name}\\b`).test(m[1])))
  }
  for (const [name, mods] of Object.entries(census.names)) {
    const survivors = mods.filter((x) => exportsName(stripComments(readRepo(x) ?? ""), name))
    for (const m of mods) {
      if (survivors.includes(m)) continue // kept — no proof needed
      retired.push(`${name}@${m}`)
      const raw = readRepo(m)
      const tomb = raw !== null && TOMBSTONE(name).test(raw)
      const stillImported = importersOf(name, m)
      const why: string[] = []
      if (raw !== null && !tomb) why.push("no tombstone naming a survivor file:line")
      if (stillImported.length) why.push(`still imported by ${stillImported[0]}`)
      if (survivors.length === 0 && !tomb) why.push("no copy survives and no tombstone names where it went")
      if (why.length) unproven.push(`${name}@${m} (${why.join("; ")})`)
    }
  }
  const tombControl = TOMBSTONE("addContactNote").test("// RETIRED: addContactNote → survivor app/actions/contacts.ts:212") && TOMBSTONE("doIt").test("// TOMBSTONE: doIt DELETED → survivor\n// app/actions/y.ts:3 doIt\nexport async function other() {}") && !TOMBSTONE("addContactNote").test("// addContactNote is a duplicate\nconst x = 'app/actions/contacts.ts:212'")
  c.rule("146G", `A DUPLICATE IS RETIRED ONLY WITH PROOF (ruling 15: 'exact file/function → intended behaviour → candidate survivor → proof the survivor covers it → proof every caller migrated → unique behaviour preserved → retire with evidence'): of the ${Object.keys(census.names).length} names in the wave-145 duplicate census, every copy no longer exported carries a tombstone naming its survivor file:line, no caller still imports it from the retired module, and at least one copy of every name survives (positive control on the tombstone finder)`,
    unproven.length === 0 && tombControl, `${retired.length} cop${retired.length === 1 ? "y" : "ies"} retired (${retired.slice(0, 6).join(", ") || "none"}); without proof: ${unproven.slice(0, 4).join("; ") || "none"}; tombstone control ${tombControl}`)
  // The record may live in the governance doc or in lane 146G's proof ledger (strings are code there; comments are not records).
  const RECORD_SOURCES = ["docs/architecture/MANAGER-GOVERNANCE.md", ...listFiles("scripts", (f) => /\/manager-duplicate[^/]*\.ts$/.test(f))]
  const recordText = RECORD_SOURCES.map((f) => (f.endsWith(".md") ? readRepo(f) : strippedRepo(f)) ?? "").join("\n")
  const recordFor = (n: string) => { const at = recordText.search(new RegExp(`\\b${n}\\b`)); return at < 0 ? "" : recordText.slice(at, at + 600) }
  const recorded = Object.keys(census.names).filter((n) => /\b(kept|retired)\b/i.test(recordFor(n)))
  const keptNoDependency = Object.keys(census.names).filter((n) => /\bkept\b/i.test(recordFor(n)) && !/dependency|depends|owner decision|homonym|wired|domain/i.test(recordFor(n)))
  c.rule("146G", `EVERY CENSUS NAME HAS ITS PROOF OR ITS 'KEPT — DEPENDENCY' RECORD (ruling 15; lane 146G item 2: 'for each produce the eight-step proof or a \"kept — dependency\" record'): all ${Object.keys(census.names).length} census names carry a kept / retired verdict in lane 146G's governance record (docs/architecture/MANAGER-GOVERNANCE.md or its duplicate-proof ledger), and every KEPT one names its dependency`,
    recorded.length === Object.keys(census.names).length && keptNoDependency.length === 0, recordText.trim() ? `${recorded.length}/${Object.keys(census.names).length} names with a verdict (sources ${RECORD_SOURCES.filter((f) => readRepo(f) !== null).join(", ")}); kept without a dependency: ${keptNoDependency.join(", ") || "none"}; unrecorded: ${Object.keys(census.names).filter((n) => !recorded.includes(n)).slice(0, 5).join(", ") || "none"}` : "no governance record yet — awaiting lane 146G")

  // ── 5 · RULING 16: one high-contrast palette — every text pair of the design tokens meets WCAG AA (4.5:1) in light and dark ──
  const css = readRepo("app/globals.css") ?? ""
  const light = tokensOf(css, /:root\s*\{/), dark = tokensOf(css, /\.dark\s*\{/)
  const fails: string[] = []
  let measured = 0
  // RE-ASSERTED (wave 146, lane 146Z): the step measured the dark DESTRUCTIVE FILL at full opacity, which no primitive
  // renders — Button / Badge / Toast composite it at `dark:bg-destructive/60` over the background. Measuring the raw pair is a
  // SHAPE: no single dark red can pass both it AND red error text on the dark background (white-on-red needs L ≤ 0.173,
  // red-on-#020817 needs L ≥ 0.186). The RULE is "every pair meets AA as RENDERED": the dark fill is composited the way the
  // primitives draw it, and that model is itself checked — every app/components/ui primitive filling bg-destructive must
  // carry dark:bg-destructive/60, or the step goes red (positive control below: the raw pair still reads below AA).
  const over = (fg: [number, number, number], bg: [number, number, number], a: number): [number, number, number] => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a))) as [number, number, number]
  for (const [theme, t] of [["light", light], ["dark", dark]] as const) for (const [bg, fg] of TEXT_PAIRS) {
    if (!t[bg] || !t[fg]) continue
    measured++
    const fill = theme === "dark" && bg === "destructive" && t.background ? over(t[bg], t.background, 0.6) : t[bg]
    const r = contrast(fill, t[fg])
    if (r < 4.5) fails.push(`${theme} ${fg} on ${bg}${fill !== t[bg] ? " (/60 composite)" : ""} ${r.toFixed(2)}:1`)
  }
  const destructivePrimitives = listFiles("app/components/ui", (p) => p.endsWith(".tsx")).filter((f) => /\bbg-destructive\s/.test(readRepo(f) ?? ""))
  const uncomposited = destructivePrimitives.filter((f) => !/dark:bg-destructive\/60/.test(readRepo(f) ?? ""))
  if (uncomposited.length) fails.push(`primitives filling bg-destructive without dark:bg-destructive/60: ${uncomposited.join(", ")}`)
  // Published beside the verdict: the raw (never rendered) dark pair, and the controls of the composite model.
  const rawDark = dark.destructive && dark["destructive-foreground"] ? contrast(dark.destructive, dark["destructive-foreground"]) : null
  const compositeCtl = over([255, 255, 255], [0, 0, 0], 0.6).join(",") === "153,153,153" && /\bbg-destructive\s/.test("bg-destructive text-white ") && !/dark:bg-destructive\/60/.test("bg-destructive text-white ")
  const ctl = Math.abs(contrast([0, 0, 0], [255, 255, 255]) - 21) < 0.01 && contrast([119, 119, 119], [255, 255, 255]) < 4.5 && contrast(hslToRgb(0, 0, 100), hslToRgb(222.2, 84, 4.9)) > 17
  c.rule("146H", "ONE HIGH-CONTRAST PALETTE (ruling 16: 'one consistent high-contrast palette … coherent action/status styling … accessible interactions (focus, labels, contrast ratios)'): every text pair of the design tokens in app/globals.css (background / card / popover / primary / secondary / accent / destructive with their foregrounds, and muted text on the background) meets WCAG AA 4.5:1 in BOTH the light and the dark theme (positive control: black on white is 21:1, #777 on white is below AA)",
    ctl && compositeCtl && measured >= 10 && destructivePrimitives.length > 0 && fails.length === 0, `${measured} pair(s) measured (dark destructive fill as the primitives composite it, /60 — ${destructivePrimitives.length} primitives checked to carry it); below AA: ${fails.join("; ") || "none"}; raw dark token pair ${rawDark === null ? "∅" : rawDark.toFixed(2)}:1 (never rendered); control ${ctl && compositeCtl}`)

  // ── 6 · RULING 18: every role's journeys audited on their real surfaces ──
  const audit = readRepo("docs/architecture/CAPABILITY-SURFACE-AUDIT.md") ?? ""
  const ROLES: Array<[string, RegExp]> = [["platform staff", /platform staff|platform admin/i], ["platform prospects", /prospect/i], ["tenant admins", /tenant admin|broker(age)? admin|broker_owner/i], ["teams", /team/i], ["agents", /\bagent/i], ["contacts (buyers/sellers/lifetime)", /buyer|seller|lifetime|contact/i], ["vendors / partners", /vendor|partner/i], ["marketplace", /marketplace/i]]
  const rolesMissing = ROLES.filter(([, re]) => !re.test(audit)).map(([k]) => k)
  const verdicts = ["BUILT", "PARTIAL", "UNWIRED", "MISSING"].filter((v) => new RegExp(`\\b${v}\\b`).test(audit))
  // WAVE146 BIND (lane 146H notes, "## Canary requirements", 18:24Z): scripts/ui-capability-surface-audit.ts derive · resolveHref · EXPECTED —
  // the audit is DERIVED from the route tree (no row without a page, none UNWIRED, every expected role × domain pair reachable).
  await c.check("146H", "EVERY ROLE'S JOURNEYS ARE AUDITED ON THEIR REAL SURFACES (ruling 18: 'All capabilities at all levels … Validate each on its real surface'; lane 146H item 1: 'record BUILT / PARTIAL / UNWIRED / MISSING per journey with the screen and the action behind it'): docs/architecture/CAPABILITY-SURFACE-AUDIT.md covers every ruled role in the verdict vocabulary, and the DERIVED audit (scripts/ui-capability-surface-audit.ts derive) has no journey row without a real page, none UNWIRED, and every expected role × domain pair present and not MISSING (positive control: an invented dashboard path resolves to no page)", async () => {
    const docOk = !!audit && rolesMissing.length === 0 && verdicts.length >= 2
    const mod = await quiet(async () => landedModule<Record<string, any>>("../ui-capability-surface-audit.ts")) as Record<string, any> | null
    if (!mod || typeof mod.derive !== "function") return { ok: false, evidence: `${audit ? `doc roles missing ${rolesMissing.join(", ") || "none"}, verdicts ${verdicts.join(",")}` : "docs/architecture/CAPABILITY-SURFACE-AUDIT.md not written"}; scripts/ui-capability-surface-audit.ts derive not landed — awaiting lane 146H` }
    const d = await quiet(async () => mod.derive()) as { rows: Array<Record<string, unknown>> }
    const rows = d?.rows ?? []
    const pageless = rows.filter((r) => r.page === null).length, unwired = rows.filter((r) => r.verdict === "UNWIRED").length
    // EXPECTED is role → the domains that role must reach (lane 146H's map); every pair needs a reachable, non-MISSING row.
    const expectedMap = (mod.EXPECTED ?? {}) as Record<string, readonly string[]>
    const expected = Object.entries(expectedMap).flatMap(([role, domains]) => [...domains].map((domain) => ({ role, domain })))
    const unreached = expected.filter((e) => !rows.some((r) => r.role === e.role && r.domain === e.domain && r.verdict !== "MISSING"))
    const missingExpected = unreached.length
    const control = typeof mod.resolveHref === "function" && (mod.resolveHref("/dashboard/__none__") as { page: unknown }).page === null
    return { ok: docOk && rows.length > 0 && pageless === 0 && unwired === 0 && missingExpected === 0 && control, evidence: `doc roles missing ${rolesMissing.join(", ") || "none"}, verdicts ${verdicts.join(",")}; derived rows ${rows.length}, pageless ${pageless}, UNWIRED ${unwired}, expected role × domain pairs not reachable ${missingExpected}/${expected.length}${unreached.length ? ` (${unreached.slice(0, 3).map((u) => `${u.role} / ${u.domain}`).join("; ")})` : ""}; control ${control}` }
  })

  // ── 6b · RULING 16 honesty at the screens lane 146H fixed (its published requirements): no dead control, no misleading status ──
  const deadPages = ["app/vendor/portfolio/upload/page.tsx", "app/title/closing/new/page.tsx"].map((f) => ({ f, s: strippedRepo(f) }))
  // RE-ASSERTED ON THE RULE (wave 147, lane 147H built both writers — ruling 9): "no bare <form>" was the waypoint while
  // nothing existed to submit TO. The rule is no FAKE submit: no setTimeout anywhere on the screen, and any <form> on it
  // (the page or the form component it mounts) is bound to a server action imported from app/actions — never a timer.
  const formFiles: Record<string, string> = { "app/vendor/portfolio/upload/page.tsx": "app/vendor/portfolio/upload/portfolio-upload-form.tsx", "app/title/closing/new/page.tsx": "app/title/closing/new/closing-appointment-form.tsx" }
  const fakeSubmit = (src: string) => /\bsetTimeout\s*\(/.test(src) || (/<form\b/.test(src) && !(/<form\b[^>]*\baction=\{/.test(src) && /from\s+["']@\/app\/actions\//.test(src)))
  const dead = deadPages.filter((p) => p.s !== null && (fakeSubmit(p.s) || fakeSubmit(strippedRepo(formFiles[p.f]) ?? ""))).map((p) => p.f)
  const policies = strippedRepo("app/compliance/policies/page.tsx")
  const fakeActive = policies !== null && /["'>]\s*Active\s*["'<]/.test(policies)
  const approvals = strippedRepo("app/dashboard/content/approvals/page.tsx")
  const hardBroker = approvals !== null && /approver_role\s*:\s*["']broker["']/.test(approvals)
  const deadControl = /\bsetTimeout\s*\(/.test(stripComments("onClick={() => setTimeout(() => setDone(true), 800)}")) && !/\bsetTimeout\s*\(/.test(stripComments("// setTimeout( was the fake submit"))
    && fakeSubmit(`<form onSubmit={(e) => { e.preventDefault(); go() }}>`) && !fakeSubmit(`import { act } from "@/app/actions/x"\n<form action={act}>`)
  c.rule("146H", "NO DEAD CONTROL, NO MISLEADING STATUS ON THE SCREENS THE AUDIT FOUND (ruling 16: 'no dead controls or misleading statuses'; ruling 9: the approver is never a hard-coded brokerage): the vendor portfolio upload and the title closing intake no longer fake a submit (no setTimeout / bare <form>), the compliance policies page renders no unbacked 'Active' badge, and the content approvals page hard-codes no approver_role 'broker' (stripped source; positive control: a timed fake submit is caught, a comment naming it is not)",
    dead.length === 0 && !fakeActive && !hardBroker && deadControl && deadPages.some((p) => p.s !== null), `fake submits ${dead.join(", ") || "none"}; 'Active' badge ${fakeActive}; hard-coded broker approver ${hardBroker}; control ${deadControl}`)

  // ── 6c · RULING 9 AT THE SCREEN (lane 146H's published requirement): the social screen asks C5 and says who approves, honestly ──
  const socialPage = strippedRepo("app/dashboard/social/page.tsx") ?? ""
  const asksC5 = /\bapproverFor\s*\(\s*\{[^}]*assetKind\s*:\s*["']social_post["']/.test(socialPage)
  const lineMod = existsSyncRel("app/dashboard/social/approver-line.ts") ? await quiet(async () => landedModule<Record<string, any>>("../../app/dashboard/social/approver-line.ts")) : null
  let lineOk = false, lineEv = "app/dashboard/social/approver-line.ts describeApprover not landed"
  if (lineMod && typeof lineMod.describeApprover === "function") {
    const unknown = String(lineMod.describeApprover({ ok: false, reason: "x" }, "u"))
    const own = String(lineMod.describeApprover({ ok: true, assetKind: "social_post", tier: "owner_agent", primaryUserIds: ["u"], permittedUserIds: ["u", "u-owner"], brokerageApprovalRequired: false, basis: "owner", policyRef: null, reason: "own" }, "u"))
    lineOk = /could not be determined/i.test(unknown) && /approve your own posts/i.test(own)
    lineEv = `unreadable → "${unknown.slice(0, 70)}"; own post → "${own.slice(0, 70)}"`
  }
  c.rule("146H", "THE SOCIAL SCREEN NAMES THE REAL APPROVER (ruling 9: 'the tenants approve their own ads/posts … Every publish door picks the approver from the real authority hierarchy'; lane 146H requirement 'Ruling 9 / C5 at the screen'): app/dashboard/social/page.tsx asks approverFor for a social_post, and the approver line says 'could not be determined' when the authority read fails (never a guessed broker) and tells an agent 'You approve your own posts' when they are the owner",
    asksC5 && lineOk, `social page asks C5 ${asksC5}; ${lineEv}`)
  // ── 6d · A PUBLIC LISTING PAGE IS PUBLIC (ruling 18 'validate each on its real surface'; lane 146H Outside-lane 1 → the proxy) ──
  const authMod = await quiet(async () => import("../../app/constants/auth")) as unknown as { classifyProxyPath?: (p: string) => string }
  const pub = authMod.classifyProxyPath ? authMod.classifyProxyPath("/listings/7b1f6a52-1c1e-4d4e-9f55-0a1b2c3d4e5f") : "∅"
  const newStaysProtected = authMod.classifyProxyPath ? authMod.classifyProxyPath("/listings/new") : "∅"
  c.rule("integrator", "A PUBLIC LISTING PAGE IS REACHABLE WITHOUT SIGNING IN, AND CREATING ONE IS NOT (ruling 18; lane 146H Outside-lane 1 — app/constants/auth.ts is no lane's domain this wave): classifyProxyPath('/listings/<uuid>') is 'public' while '/listings/new' stays 'protected' (control)",
    pub === "public" && newStaysProtected === "protected", `/listings/<uuid> → ${pub}; /listings/new → ${newStaysProtected}`)

  // ── 7 · the wave-146 canaries have an owning manager (lane 146I owns the registry; lane 146J lists the entry) ──
  const reg = strippedRepo("lib/kernel/manager-registry.ts") ?? ""
  const owned = /["']test:wave146-canaries["']/.test(reg)
  c.rule("146I", "THE WAVE-146 CANARIES ARE OWNED (lane 146I item 3: 'Registry entries for every lane'): lib/kernel/manager-registry.ts names test:wave146-canaries as a proof with an owning manager (the entry lane 146J lists under '## Registry entries needed')",
    owned, owned ? "test:wave146-canaries registered" : "test:wave146-canaries not in the registry yet")

  c.blind("Ruling 14's classifier is found by a NAME pattern on the governance files and driven on ruled kind specimens read by MEANING (a 'safe' class vs consequential / human approval); a classifier under another name reads as absent until lane 146G's published name is bound. The incident chain is read as stage literals in stripped code, not driven. Ruling 15's retirement proof is the code-checkable half (tombstone naming a survivor file:line + no remaining import from the retired module); the behavioural half (the survivor COVERS it, unique behaviour kept) is lane 146G's eight-step record. The palette check covers the HSL design tokens only — a hard-coded Tailwind colour class in a component (bg-red-500 text-white) is lane 146H's test:accessibility-* / test:ui-* census.")
  return c.report([], 0)
}
