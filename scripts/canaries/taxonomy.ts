/**
 * scripts/canaries/taxonomy.ts — ADAPTIVE VOCABULARY canary (wave 144, lane 144J; owner rulings 1 + 17):
 *   a missing / obsolete / state-specific label → the existing manager/exception path evaluates → proposal (add / rename /
 *   deactivate / alias) scoped to jurisdiction + brokerage → dependency validation → human/compliance approval → canonical
 *   configuration → readers / UI / form mappings synchronized → verified. Stable canonical ids + aliases; historical values
 *   resolve forever; a new financing label breaks nothing; state regulatory document rules need compliance approval and an
 *   official source; probate / divorce / military relocation are service TOPICS (never Fair Housing exemptions) and 55+ keeps
 *   its lawful older-persons exception.
 * Through the survivors at 967a4866: lib/compliance/checklist-dimensions.ts (FINANCING_KINDS / CONTRACT_SUBTYPES /
 * REPRESENTATIONS + rowApplicability — the ONE rule), lib/data-steward/value-normalizer.ts (normalizeEnumValue — the synonym
 * table the import side uses), scripts/check-vocabularies.ts (GENERATED live CHECKs), lib/forms/form-wizard-sequence.ts (the
 * offer intake), lib/kernel/marketing/public-copy-rewrite.ts scanPublicCopy + lib/compliance/fair-housing-older-persons.ts.
 *
 * MEASURED AT 967a4866: the vocabularies are closed code constants mirrored by live CHECKs (m806); a checklist row naming a
 * label the code does not know is read as "ANY" — it silently applies to every deal; no alias resolves an old spelling of a
 * contract subtype; no vocabulary table / proposal path exists; the offer intake's financing options are a literal list; a
 * state-scoped document rule carries no approval or source — 144A.
 */
import { LIVE, canary, landedModule } from "./_harness"
import { findLanded, listFiles, readRepo, strippedRepo } from "./_registry"
import { CHECK_VOCABULARIES } from "../check-vocabularies"
import { memSupabase } from "../in-memory-supabase"

export async function run() {
  const c = canary("Adaptive vocabulary: canonical ids + aliases · approved config adds labels without breaking dependents · state rules need compliance approval + source · housing topics ≠ exemptions")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")
  const dims = await import("../../lib/compliance/checklist-dimensions")

  // ── 1 · the canonical vocabularies mirror the database's enforcement (green — preserve) ──
  // RE-ASSERTED (lane 144Z): this step pinned a SHAPE ("every dimension is a live CHECK"). m847 (lane 144A, applied live) moved
  // contract_subtype and representation off m806's CHECKs onto a trigger (brd_vocabulary_admission → adaptive_vocabulary_admits)
  // that admits the PLATFORM array or a brokerage-approved term — so the generated cache rightly no longer carries those two. The
  // RULE is unchanged: the database's platform list for every dimension equals the code. Each dimension is judged where the
  // database actually enforces it — its live CHECK (generated cache) if one exists, else the platform ARRAY in the latest
  // migration defining adaptive_vocabulary_admits (stripped of `--` lines, either line-1 stamp accepted). A dimension enforced by
  // NEITHER is red (nothing holds it), and a trigger-backed dimension must also have its CHECK dropped by that migration.
  const live = CHECK_VOCABULARIES.brokerage_required_documents as Record<string, readonly string[] | undefined>
  const same = (a: readonly string[], b: readonly string[] | undefined) => !!b && [...a].sort().join() === [...b].sort().join()
  const admitsFile = listFiles("supabase/migrations", (f) => f.endsWith(".sql")).sort()
    .filter((f) => /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.adaptive_vocabulary_admits\b/i.test((readRepo(f) ?? "").split("\n").filter((l) => !/^\s*--/.test(l)).join("\n"))).pop() ?? null
  const admitsSql = admitsFile ? (readRepo(admitsFile) ?? "").split("\n").filter((l) => !/^\s*--/.test(l)).join("\n") : ""
  const admitsArray = (dim: string): string[] | null => {
    const m = new RegExp(`WHEN\\s+'${dim}'\\s+THEN\\s+ARRAY\\[([^\\]]*)\\]`, "i").exec(admitsSql)
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null
  }
  const vocabDims: Array<[string, readonly string[]]> = [["contract_subtype", dims.CONTRACT_SUBTYPES], ["financing_kind", dims.FINANCING_KINDS], ["representation", dims.REPRESENTATIONS], ["required_stage", dims.CHECKLIST_STAGES]]
  const mirror = vocabDims.map(([dim, code]) => {
    if (live[dim]) return { dim, via: "live CHECK", ok: same(code, live[dim]) }
    const arr = admitsArray(dim)
    const dropped = new RegExp(`DROP\\s+CONSTRAINT\\s+(IF\\s+EXISTS\\s+)?\\w*${dim}\\w*_check`, "i").test(admitsSql)
    return { dim, via: arr ? `trigger (${admitsFile})` : "NOTHING", ok: !!arr && dropped && same(code, arr) }
  })
  // Positive control: the comparison refuses a list that differs by one value, and the array reader recognises the shape it was
  // written for (a broken regex would read every trigger-backed dimension as "NOTHING" — red, never a blind green).
  const controlOk = same(["a", "b"], ["b", "a"]) && !same(["a", "b"], ["a", "c"]) && (/WHEN\s+'x'\s+THEN\s+ARRAY\[/.test("WHEN 'x' THEN ARRAY['y']"))
  c.rule("144A", "ONE CANONICAL VOCABULARY per dimension, mirrored by the database's enforcement: contract subtype, financing kind, representation and stage in lib/compliance/checklist-dimensions.ts equal what the database admits — a live CHECK (generated cache) where one pins the column, else the platform array of the vocabulary-admission trigger (m847) — no second spelling, and no dimension left unenforced", controlOk && mirror.every((m) => m.ok), mirror.map((m) => `${m.dim} ${m.ok ? "=" : "≠"} ${m.via}`).join("; "))

  // ── 2 · an UNKNOWN label is never a silent wildcard ──
  const unknownRow = dims.rowApplicability({ contract_subtype: "auction" }, { stage: "contract", contractSubtype: "standard" })
  c.rule("144A", "AN UNKNOWN LABEL IS NEVER A SILENT WILDCARD: a checklist row stored with a contract subtype the canonical vocabulary does not (yet) know — a state's 'auction' — must not apply to a STANDARD resale as if it said 'any'; it either resolves through the approved vocabulary (and then does not match 'standard') or applies only as an unresolved WARNING naming the dimension", !unknownRow.applies || unknownRow.unresolved.includes("contract_subtype"), `HEAD: rowApplicability → ${JSON.stringify(unknownRow)} (asContractSubtype("auction") is null, read as "row says ANY")`)

  // ── 3/4/6 · the ADAPTIVE PATH, driven through lane 144A's LANDED door when its files exist (red at 967a4866: they do not) ──
  // lib/compliance/adaptive-vocabulary.ts (resolve / evaluate / validate / picker) + lib/compliance/vocabulary-healing.ts (report →
  // ONE improvement_proposals row → approval → promotion through the proposal kernel → attestation → verify), on a PRIVATE
  // in-memory client: two brokerages, nothing shared with the harness's tagged rows. One open proposal at a time (the door's rule),
  // so each report is decided before the next.
  const av = await landedModule("../../lib/compliance/adaptive-vocabulary.ts")
  const vh = await landedModule("../../lib/compliance/vocabulary-healing.ts")
  const door = av && vh ? await (async () => {
    const B = "11111111-1111-4111-8111-1111111aa144", B2 = "22222222-2222-4222-8222-2222222aa144"
    const AGENT = { userId: "aaaaaaaa-0000-4000-8000-0000000a144a", userType: "agent", isTenantAdmin: false }
    const BROKER = { userId: "aaaaaaaa-0000-4000-8000-0000000a144b", userType: "broker", isTenantAdmin: true }
    const LEAD = { userId: "aaaaaaaa-0000-4000-8000-0000000a144c", userType: "team_lead", isTenantAdmin: true }
    const CO = { userId: "aaaaaaaa-0000-4000-8000-0000000a144d", userType: "compliance_officer", isTenantAdmin: true }
    const stamp = "2026-10-01T00:00:00.000Z"
    const mem = memSupabase({
      improvement_proposals: [], tenant_policy_versions: [], agent_action_ledger: [], brokerage_required_documents: [],
      brokerage_settings: [{ id: "bs-144j-a", brokerage_id: B, settings: {}, updated_at: stamp }, { id: "bs-144j-b", brokerage_id: B2, settings: {}, updated_at: stamp }],
    }, { stampCreatedAt: true, uuidIds: true }) as any
    const vocab = async (b: string) => { const x = await av.loadTenantVocabulary(mem, b); return x.ok ? x.vocabulary : null }
    const report = (r: Record<string, unknown>, by = AGENT.userId) => vh.reportVocabularyGap(mem, { brokerageId: B, reporterUserId: by, report: r })
    const approve = (pid: string, who: Record<string, unknown>) => vh.approveVocabularyProposal(mem, { brokerageId: B, proposalId: pid, approver: who })
    const pidOf = (r: any): string => (r?.ok && r.outcome === "proposed" ? r.proposalId : "")

    // 4 — a brokerage reports its state's AUCTION contract: proposed (nothing applied) → an agent cannot approve → the broker does.
    const r1 = await report({ dimension: "contract_subtype", label: "Auction", kind: "missing", rollsUpTo: "standard", note: "our market writes auction contracts" })
    const pending = (await vocab(B)) ? av.resolveVocabularyValue("contract_subtype", "auction", await vocab(B)) : "unreadable"
    const byAgent = await approve(pidOf(r1), AGENT)
    const byBroker = await approve(pidOf(r1), BROKER)
    const vB = await vocab(B), vB2 = await vocab(B2)
    const auctionRow = { contract_subtype: "auction" }, auctionDeal = { stage: "contract" as const, contractSubtype: "auction" }
    // 144A widens rowApplicability with a third (vocabulary) parameter; typed loosely so this file compiles at 967a4866 too.
    const rowApplies = dims.rowApplicability as unknown as (row: object, ctx: object, vocabulary?: unknown) => { applies: boolean; unresolved: string[] }
    const inB = vB ? rowApplies(auctionRow, auctionDeal, av.checklistVocabularyFor(vB)) : null
    const inB2 = vB2 ? rowApplies(auctionRow, auctionDeal, av.checklistVocabularyFor(vB2)) : null
    const add = {
      proposed: pidOf(r1) !== "" && r1.status === "EVALUATED" && pending === null, agentRefused: !byAgent.ok, approved: !!byBroker.ok && !!byBroker.verified,
      checklistB: !!inB && inB.applies && inB.unresolved.length === 0, checklistB2Unresolved: !!inB2 && inB2.unresolved.includes("contract_subtype"),
      pickerB: !!vB && av.vocabularyOptions("contract_subtype", vB).some((o: any) => o.value === "auction"), pickerB2Hidden: !!vB2 && !av.vocabularyOptions("contract_subtype", vB2).some((o: any) => o.value === "auction"),
      versions: mem.tables.tenant_policy_versions.length,
    }

    // 3 — an OLD SPELLING becomes an approved alias of the stable id; retiring the id for new work keeps history reading.
    // RE-ASSERTED (wave 145, lane 145Z): the fixture was "bank owned", and wave 145 lane H made that spelling a PLATFORM alias of
    // reo_bank_owned (lib/compliance/checklist-dimensions.ts) — so the report was answered "already resolves", nothing was proposed and
    // the step read red for a reason that is not the rule. The RULE is unchanged (a spelling the platform does NOT know becomes THIS
    // brokerage's approved alias); the fixture is now one the platform does not know, and `platformUnknown` proves it stays so.
    const OLD_SPELLING = "bank repo"
    const r2 = await report({ dimension: "contract_subtype", label: OLD_SPELLING, kind: "missing", sameAs: "reo_bank_owned" })
    const a2 = await approve(pidOf(r2), BROKER)
    const r3 = await report({ dimension: "contract_subtype", label: "reo_bank_owned", kind: "obsolete", note: "retired for new listings" })
    const a3 = await approve(pidOf(r3), BROKER)
    const vAfter = await vocab(B)
    const viaAlias = vAfter ? av.resolveVocabularyValue("contract_subtype", OLD_SPELLING, vAfter) : null
    const viaId = vAfter ? av.resolveVocabularyValue("contract_subtype", "reo_bank_owned", vAfter) : null
    const otherTenant = vB2 ? av.resolveVocabularyValue("contract_subtype", OLD_SPELLING, await vocab(B2)) : "unreadable"
    const alias = {
      platformUnknown: av.resolveVocabularyValue("contract_subtype", OLD_SPELLING, av.EMPTY_TENANT_VOCABULARY) === null,
      aliasApproved: !!a2.ok && !!a2.verified, retired: !!a3.ok && !!a3.verified,
      aliasStillReads: viaAlias?.key === "reo_bank_owned" && viaAlias.usable === false, idStillReads: viaId?.key === "reo_bank_owned",
      hiddenForNewWork: !!vAfter && !av.vocabularyOptions("contract_subtype", vAfter).some((o: any) => o.value === "reo_bank_owned"), otherTenant: otherTenant === null,
    }

    // 6 — a STATE-scoped term: no official source → not proposed; a team lead cannot enable it; a compliance approver attests it.
    const TREC = "https://www.trec.texas.gov/forms/information-about-brokerage-services"
    const tx = { dimension: "representation", label: "Intermediary", kind: "different_in_state", rollsUpTo: "dual_agency", stateCode: "TX" }
    const r4 = await report(tx, LEAD.userId)
    const r5 = await report({ ...tx, sourceUrl: TREC, sourceTitle: "TREC — Information About Brokerage Services" }, LEAD.userId)
    const byLead = await approve(pidOf(r5), LEAD)
    const afterLead = await vocab(B)
    const byCo = await approve(pidOf(r5), CO)
    const vTx = await vocab(B)
    const state = {
      unsourcedNotProposed: !!r4.ok && r4.outcome === "answered" && r4.evaluation?.verdict === "needs_detail",
      proposedForCompliance: pidOf(r5) !== "" && !!r5.validation?.requiresCompliance,
      leadRefused: !byLead.ok && !!afterLead && av.resolveVocabularyValue("representation", "intermediary", afterLead) === null,
      attested: !!byCo.ok && !!byCo.attested && !!byCo.verified && !!vTx && !!av.resolveVocabularyValue("representation", "intermediary", vTx)?.usable,
      txOnly: !!vTx && av.vocabularyOptions("representation", vTx, { stateCode: "TX" }).some((o: any) => o.value === "intermediary") && !av.vocabularyOptions("representation", vTx, { stateCode: "FL" }).some((o: any) => o.value === "intermediary"),
    }
    const why = [r1, byBroker, r2, a2, r3, a3, r5, byCo].map((x: any) => (x && x.ok === false ? String(x.error ?? "").slice(0, 160) : null)).filter(Boolean)
    return { add, alias, state, why }
  })() : null
  const allTrue = (o: Record<string, unknown> | undefined) => !!o && Object.values(o).every((v) => v === true || (typeof v === "number" && v > 0))

  // ── 3 · aliases resolve historical values forever ──
  const { normalizeEnumValue } = await import("../../lib/data-steward/value-normalizer")
  const aliasHits = ["REO", "bank owned", "probate", "estate sale"].map((raw) => ({ raw, viaChecklist: dims.asContractSubtype(raw), viaNormalizer: normalizeEnumValue("contract_subtype", raw).value }))
  c.rule("144A", "ALIASES RESOLVE OLD STORED VALUES FOREVER (ruling 1: 'stable canonical IDs + aliases; never silently delete historical values'): an old spelling the platform does not know ('bank repo') becomes an APPROVED ALIAS of the stable id reo_bank_owned for that brokerage only; when reo_bank_owned is later retired for new work it leaves the picker, yet the alias AND the stored id still resolve (usable:false) — a historical contract or automation keyed on either keeps working, and nothing is deleted", allTrue(door?.alias), door ? `landed door: ${JSON.stringify(door.alias)}` : `HEAD: no alias mechanism — ${aliasHits.map((h) => `${h.raw}→${h.viaChecklist ?? h.viaNormalizer ?? "null"}`).join(", ")} (checklist narrowing + the data steward's synonym table)`)

  // ── 4 · a NEW label through APPROVED CONFIGURATION, scoped to jurisdiction + brokerage ──
  const path = findLanded(["lib/taxonomy", "lib/compliance", "lib/kernel/tenant-policy.ts", "lib/kernel/healing-policy.ts", "lib/kernel/self-healing.ts", "lib/kernel/exceptions-first.ts", "lib/data-steward", "app/actions/compliance", "supabase/migrations"], /\b(vocabulary_(terms|entries|aliases|proposals?|labels)|taxonomy_(terms|entries|aliases|labels)|canonical_vocabulary\w*|proposeVocabulary\w*|vocabularyProposal\w*|VOCABULARY_PROPOSAL\w*|resolveVocabulary\w*|adaptiveVocabulary\w*)\b/)
  c.rule("144A", "APPROVED CONFIGURATION ADDS A LABEL (ruling 1): a user reports that the brokerage's market writes an 'auction' contract → the registered manager's exception path records ONE proposal (nothing applied yet) → dependency validation → an agent cannot approve, a tenant admin does → promoted as a policy version → verified; the checklist reads the brokerage's 'auction' rule as CERTAIN for that brokerage and as an unresolved WARNING for another, and the picker offers it to that brokerage only", allTrue(door?.add), door ? `landed door: ${JSON.stringify(door.add)}` : path ? `landed at ${path}, but lib/compliance/adaptive-vocabulary.ts / vocabulary-healing.ts are absent` : "HEAD: no vocabulary table / proposal path under lib/taxonomy, lib/compliance, tenant-policy, healing-policy, self-healing, exceptions-first, lib/data-steward or a migration")
  const closedCheck = (live.contract_subtype ?? []).length > 0
  const enforcementMove = findLanded(["supabase/migrations"], /brokerage_required_documents[\s\S]{0,400}(DROP\s+CONSTRAINT[\s\S]{0,80}contract_subtype|contract_subtype[\s\S]{0,200}REFERENCES)/i)
  c.rule("144A", "A NEW LABEL IS STORABLE: an approved brokerage/state subtype can be written on a checklist row — the closed live CHECK (m806 brokerage_required_documents_contract_subtype_check) is a FINDING; the enforcement moves to the vocabulary table by a reviewed migration (never a silently widened CHECK)", !closedCheck || enforcementMove !== null, closedCheck ? `HEAD: live CHECK admits only ${(live.contract_subtype ?? []).join(", ")}; no migration moves the enforcement${enforcementMove ? ` (landed: ${enforcementMove})` : ""}` : "no closed CHECK")

  // ── 5 · a new FINANCING label breaks nothing downstream (green — preserve) ──
  const { intakeQuestionsFor } = await import("../../lib/forms/form-wizard-sequence")
  const keysFor = (fin: string) => intakeQuestionsFor("offer", { financing_type: fin }).map((q) => q.key)
  c.rule("144A", "A NEW FINANCING LABEL BREAKS NOTHING (ruling 1: 'must not break pre-approval, offer requirements, reporting or workflows'): 'seller_financing' and 'assumption' read as FINANCED for the checklist (proof-of-funds vs lender rules) and the offer intake still asks for the down payment and the financing contingency; cash stays cash; an empty value is UNKNOWN, never cash", dims.financingKindFor("seller_financing") === "financed" && dims.financingKindFor("assumption") === "financed" && dims.financingKindFor("cash") === "cash" && dims.financingKindFor("") === null && ["down_payment_amount", "financing_contingency_days"].every((k) => keysFor("assumption").includes(k)) && !keysFor("cash").includes("financing_contingency_days"), `assumption intake: ${keysFor("assumption").filter((k) => /down|financing/.test(k)).join(",")}`)
  const wizard = strippedRepo("lib/forms/form-wizard-sequence.ts") ?? ""
  const literalFinancing = /key:\s*["']financing_type["'][\s\S]{0,200}options:\s*\[\s*\{\s*value:\s*["']cash["']/.test(wizard)
  // Positive control (lane 144Z): the absence of a literal list is not enough — the picker the wizard actually renders must carry
  // exactly the canonical FINANCING_TYPES (a deleted options list would also be "no literal").
  const { OFFER_INTAKE } = await import("../../lib/forms/form-wizard-sequence")
  const pickerValues = (OFFER_INTAKE.find((q) => q.key === "financing_type")?.options ?? []).map((o) => o.value)
  // Owner 144C: lane 144A landed the ONE list (FINANCING_TYPES + vocabularyOptions) and routed this picker to 144C (144A Outside-lane 1).
  c.rule("144C", "NO HARD-CODED ALTERNATE LABELS IN A DROPDOWN (ruling 1): the offer intake's financing options are read from the canonical vocabulary (so an approved state/brokerage label appears without a code change) — at HEAD lib/forms/form-wizard-sequence.ts OFFER_INTAKE carries a literal cash/conventional/fha/va/usda/other list (file in lane 144C's domain; 144A Outside-lane 1 routes it there)", !literalFinancing && pickerValues.join() === dims.FINANCING_TYPES.join(), literalFinancing ? "HEAD: literal options list on financing_type (form-wizard-sequence.ts OFFER_INTAKE)" : `options derived from FINANCING_TYPES: ${pickerValues.join(",")}`)

  // ── 6 · state-specific REGULATORY document rules need compliance approval + an official source ──
  // The required-document half is the database's: a rule stored as a STATE REQUIREMENT must carry its state, official source and
  // approver (a CHECK in a migration — read on stripped SQL; the server action that writes it is session-bound and is lane 144A's
  // own guard's to drive). The vocabulary half is driven above.
  const citedCheck = findLanded(["supabase/migrations"], /ADD\s+CONSTRAINT\s+\w*state_requirement\w*\s+CHECK/i)
  c.rule("144A", "STATE REGULATORY DOCUMENT RULES NEED A HUMAN COMPLIANCE APPROVAL + A VERIFIED OFFICIAL SOURCE (ruling 1: 'AI never invents binding legal requirements'): a Texas-only representation term with no official source is NOT proposed (the platform never invents a legal requirement); with a .gov source it is proposed as needing compliance; a team lead (a tenant admin, not a compliance approver) cannot enable it; a compliance officer approves → ATTESTED → usable in TX and not in FL; and a required-document rule stored as a state requirement is held by a database CHECK to its state + source + approver", allTrue(door?.state) && citedCheck !== null, door ? `${door.why.length ? `refusals: ${door.why.join(" | ")}; ` : ""}landed door: ${JSON.stringify(door.state)}; state-requirement CHECK ${citedCheck ?? "ABSENT"}` : "HEAD: brokerage_required_documents carries state_code + policy_version but no approval or source column; no vocabulary door and no migration names one")

  // ── 7 · HOUSING TOPICS are not exemptions; 55+ keeps its exception (ruling 17) ──
  const { scanPublicCopy } = await import("../../lib/kernel/marketing/public-copy-rewrite")
  const topics = await scanPublicCopy("Selling a home during probate, a divorce or a military PCS relocation? Our team guides sellers through every step, on your timeline.", "landing_page")
  const masked = await scanPublicCopy("Military relocation special: adults only, no children.", "landing_page")
  const today = new Date().toISOString().slice(0, 10)
  const verified = { id: "v1", community_name: "Canary Palms", basis: "55_plus" as const, governing_rules: "CC&Rs art. 4", occupied_units: 100, qualifying_units: 90, survey_completed_on: today, policies_published: true, policies_reference: "Recorded declaration §4.2", age_verification_procedures: true, program_name: null, program_determination_ref: null, sworn_certification_on_file: true, certifying_representative: "HOA President", certification_date: today, state: "FL", state_law_reviewed: true, verified_by: "compliance", verified_at: today }
  const older = await scanPublicCopy("Canary Palms is a 55+ community with a clubhouse and pool.", "landing_page", { olderPersons: [verified] })
  const olderNone = await scanPublicCopy("Canary Palms is a 55+ community with a clubhouse and pool.", "landing_page", { olderPersons: [] })
  c.rule("144A", "PROBATE / DIVORCE / MILITARY RELOCATION ARE LEGITIMATE SERVICE TOPICS (ruling 17): public copy offering help to sellers in probate, a divorce or a PCS move passes the fair-housing scan — and a topic is NOT an exemption: 'military relocation special: adults only, no children' is still refused", topics.ok && !masked.ok, `topics ok=${topics.ok} ${topics.findings.map((f) => f.phrase).join("; ").slice(0, 120)} · masked ok=${masked.ok}`)
  // Lane 144A Outside-lane 6 (lib/compliance-rules/fair-housing-patterns.ts is in no lane's domain; its proposed patterns need a
  // compliance review): a topic word used as a PREFERENCE is not a service topic.
  const veteransOnly = await scanPublicCopy("Military relocation homes — veterans only. No divorced applicants.", "landing_page")
  // PENDING OWNER DECISION (lane 144Z): the two patterns are drafted (lane 144A Outside-lane 6) but a fair-housing pattern refuses
  // public copy, so it is added only after compliance review — no lane may add it, and the canary must not fake it. The DECIDABLE
  // half of ruling 17 stays hard above: the topics pass and 'adults only, no children' under a military topic is refused.
  c.pendingOwner("defect", "A SERVICE TOPIC USED AS A PREFERENCE IS REFUSED (ruling 17: 'not blanket Fair Housing exemptions'; lane 144A Outside-lane 6): 'veterans only' (military status — state-protected in several markets) and 'no divorced applicants' (marital / familial status) in public copy are refused by the scan — the probate / divorce / military TOPIC is offered to everyone, never a filter on who may buy", !veteransOnly.ok,
    "COMPLIANCE REVIEW: approve (or amend) the two drafted preference patterns for lib/compliance-rules/fair-housing-patterns.ts before they refuse public copy — /\\b(military|veterans?)\\s+only\\b/i (military status, state-protected in several markets) and /\\bno\\s+(divorced|single\\s+parents?)\\b/i (marital / familial status)",
    `HEAD: ok=${veteransOnly.ok}; findings ${veteransOnly.findings.map((f) => f.phrase).join("; ") || "none"} (fair-housing-patterns.ts has no military / marital preference pattern)`)
  c.rule("144A", "55+ KEEPS ITS LAWFUL OLDER-PERSONS EXCEPTION (ruling 17): '55+ community' passes for the named community with a recorded verification meeting every condition, and is held for review when no verification is recorded", older.ok && older.olderPersons?.status === "verified" && !olderNone.ok, `${older.olderPersons?.status} / ${olderNone.olderPersons?.status}`)

  c.blind("The adaptive door (steps 3, 4 and the state rule) is driven only once lane 144A's files exist (landedModule), on a PRIVATE in-memory client with no RLS — the brokerage_settings admin-only policy and m847's SECURITY DEFINER reader are not exercised; at 967a4866 those steps are red on absence alone. The live CHECK list is the GENERATED cache (scripts/check-vocabularies.ts) — a migration that is written but not applied does not change it, so step 'a new label is storable' reads the migration FILE as the lane's landing and the cache as the database. The fair-housing scan is the public-copy survivor; state fair-housing classes (lib/compliance-rules/state-fair-housing.ts) need a brokerage state read and are not exercised.")
  return c.report([], 0)
}
