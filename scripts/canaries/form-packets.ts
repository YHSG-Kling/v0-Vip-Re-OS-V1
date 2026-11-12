/**
 * scripts/canaries/form-packets.ts — FORMS canary (wave 144, lane 144J; owner ruling 3 "form packets are NOT platform-owned"):
 *   the brokerage or team uploads its approved form packets (logos / branding, legal-form licensing, field templates,
 *   jurisdiction forms) into ITS OWN tenant / team bucket and shares them with its agents as templates · agents see only the
 *   packets their actual memberships reach · no cross-tenant / cross-team leakage · ownership never moves to the platform
 *   because packets render inside VIPAgents · FormWizard keeps its Media-vs-provider choice and AI coaching — one source, the
 *   other, or a form from both · the tenant-selected legal-forms provider stays a separate capability.
 * Through the survivors at 967a4866: lib/forms/form-path-scope.ts checkFormPathsInScope (THE ownership predicate of the
 * `brokerage-forms` bucket: brokerage/… teams/… agents/… filled/… platform/…), lib/forms/platform-form-packets.ts
 * (listPlatformPacketsForTenant — the m807 registry read, driven in memory), lib/forms/form-wizard-sequence.ts
 * (offerFormSourceFor, AI_COACH_RULES). Nothing is uploaded or signed.
 *
 * MEASURED AT 967a4866: wave 143 made packets PLATFORM-owned (m807 platform_form_packets: no brokerage / team owner column;
 * listPlatformPacketsForTenant takes NO tenant and lists every approved packet to every subscriber) — 144C.
 */
import { CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, landedModule, setSvc, uuid } from "./_harness"
import { findLanded, strippedRepo } from "./_registry"
import { SCHEMA_SNAPSHOT } from "../schema-snapshot"

export async function run() {
  const c = canary("Forms: brokerage / team packet in ITS OWN bucket → shared to its agents by membership · no cross-tenant / team leakage · Media-vs-provider (or both) kept")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")
  const A = uuid(), B = uuid(), T = uuid(), T2 = uuid(), U = uuid()
  const svc = canaryClient({ brokerages: [{ id: A, name: `${CANARY_TAG} Forms A` }, { id: B, name: `${CANARY_TAG} Forms B` }] })
  setSvc(svc)

  // ── 1 · the bucket's ownership predicate (green — preserve) ──
  const { checkFormPathsInScope } = await import("../../lib/forms/form-path-scope")
  const actor = { brokerageId: A, teamId: T, userId: U }
  const mine = await checkFormPathsInScope(svc, [`brokerage/${A}/listing-packet.pdf`, `teams/${T}/team-offer.pdf`, `agents/${U}/my-addendum.pdf`], actor)
  const theirs = await checkFormPathsInScope(svc, [`brokerage/${B}/listing-packet.pdf`, `teams/${T2}/team-offer.pdf`, `brokerage/${A}/../${B}/x.pdf`], actor)
  c.rule("144C", "MEMBERSHIP DECIDES WHAT AN AGENT REACHES (green — preserve): the agent's OWN brokerage library, its OWN team's library and its own uploads are in scope; another brokerage's library, another team's library and a traversal path are refused — tenant and team from the session actor, never the request", mine.ok && mine.refused.length === 0 && !theirs.ok && theirs.refused.length === 3, `mine refused ${mine.refused.length}; theirs refused ${theirs.refused.length}/3`)

  // ── 2/3 · packets are BROKERAGE / TEAM owned and reach agents by membership — driven through lane 144C's LANDED tenant library
  // (lib/forms/tenant-form-packets.ts over brokerage_form_library, m853) when its file exists; absent at 967a4866 → red, with the
  // m807 evidence. Folded in from lane 144C's notes (Verdict 3): the platform registry is a labelled CATALOGUE a brokerage copies
  // from; agents never fill a platform/… master. Actors are constructed (the session → actor resolution is 144C's own guard's).
  const cols = (SCHEMA_SNAPSHOT as unknown as Record<string, string[]>).platform_form_packets ?? []
  const owner = findLanded(["lib/forms", "app/actions/superadmin", "app/dashboard/superadmin/form-packets", "supabase/migrations"], /platform_form_packets[\s\S]{0,600}\b(brokerage_id|team_id|owner_scope|owner_brokerage_id|owner_team_id)\b|\b(brokerageFormPacket\w*|teamFormPacket\w*|BROKERAGE_FORM_PACKET\w*|registerBrokeragePacket\w*|registerTenantPacket\w*|registerTenantFormPacket)\b/)
  const tp = await landedModule("../../lib/forms/tenant-form-packets.ts")
  const actorOf = (o: { brokerageId: string; userType: string; teamId?: string | null; ledTeamId?: string | null; oversight?: boolean }) => ({ userId: uuid(), userType: o.userType, brokerageId: o.brokerageId, teamId: o.teamId ?? null, ledTeamId: o.ledTeamId ?? null, oversight: !!o.oversight })
  ;(svc.tables.teams ??= []).push({ id: T, brokerage_id: A, name: `${CANARY_TAG} Team 1`, deleted_at: null }, { id: T2, brokerage_id: A, name: `${CANARY_TAG} Team 2`, deleted_at: null })
  svc.tables.brokerage_form_library ??= []
  const owned = tp ? await (async () => {
    const broker = actorOf({ brokerageId: A, userType: "broker_owner", oversight: true })
    const lead = actorOf({ brokerageId: A, userType: "team_lead", teamId: T, ledTeamId: T })
    const agent = actorOf({ brokerageId: A, userType: "agent", teamId: T })
    const base = { state: "FL", packetType: "listing", fileName: null, bytes: null, fieldSchema: ["seller_name", "list_price"] }
    const byBroker = await tp.registerTenantFormPacket(svc, broker, { ...base, name: `${CANARY_TAG} A listing packet`, licenseNote: "Licensed to Forms A by the state REALTOR association, member agreement 2026" })
    const byLead = await tp.registerTenantFormPacket(svc, lead, { ...base, teamId: T, name: `${CANARY_TAG} Team 1 listing packet`, licenseNote: "Team 1's own form" })
    const leadWide = await tp.registerTenantFormPacket(svc, lead, { ...base, name: `${CANARY_TAG} lead brokerage-wide`, licenseNote: "x" })
    const byAgent = await tp.registerTenantFormPacket(svc, agent, { ...base, name: `${CANARY_TAG} agent packet`, licenseNote: "x" })
    const m853 = findLanded(["supabase/migrations"], /\bbrokerage_form_library\b[\s\S]{0,400}\bsource_platform_packet_id\b/)
    const m853Drops = m853 ? /\bdrop\s+table\b[^;]*platform_form_packets|\bdelete\s+from\s+(public\.)?platform_form_packets\b/i.test((strippedRepo(m853) ?? "").split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")) : true
    return {
      brokerageOwned: !!byBroker.ok && byBroker.packet.brokerage_id === A && byBroker.packet.team_id === null && /REALTOR association/.test(String(byBroker.packet.license_note)),
      teamOwned: !!byLead.ok && byLead.packet.brokerage_id === A && byLead.packet.team_id === T,
      leadCannotShareBrokerageWide: !leadWide.ok, agentCannotUpload: !byAgent.ok,
      ownerInThePath: tp.parseTenantPacketPath(`teams/${T}/packets/${uuid()}/x.pdf`)?.kind === "team" && tp.parseTenantPacketPath(`brokerage/${A}/packets/${uuid()}/x.pdf`)?.kind === "brokerage" && tp.parseTenantPacketPath(`brokerage/${A}/../${B}/packets/x/y.pdf`) === null,
      catalogueKeptNotDropped: !!m853 && !m853Drops,
    }
  })() : null
  const allTrue = (o: Record<string, boolean> | null) => !!o && Object.values(o).every(Boolean)
  c.rule("144C", "A PACKET BELONGS TO THE BROKERAGE OR TEAM THAT UPLOADED IT (ruling 3: 'into THEIR OWN tenant/team bucket … Do not move ownership to the platform because packets render inside VIPAgents'): a brokerage admin registers a brokerage-wide packet with its licensing note; a team lead registers one for THEIR team (and cannot share brokerage-wide); an agent cannot upload; the stored path names its owner (brokerage/{id}/… | teams/{id}/…, traversal refused); the platform's m807 rows are kept as a catalogue, never dropped", allTrue(owned), owned ? `landed library: ${JSON.stringify(owned)}` : `HEAD: platform_form_packets columns = ${cols.length ? cols.filter((x) => /brokerage|team|owner|approved_by|license/.test(x)).join(", ") : "(table not in the snapshot)"} — no brokerage / team owner; the writer is superadmin-only (registerPlatformPacket)${owner ? `; landed at ${owner}` : ""}`)

  // ── 3 · no cross-tenant / cross-team leakage ──
  const leak = tp ? await (async () => {
    const path = (ownerPrefix: string, id: string) => `${ownerPrefix}/packets/${id}/packet.pdf`
    const PA = uuid(), PT = uuid(), PT2 = uuid(), PB = uuid()
    const row = (id: string, b: string, team: string | null, p: string) => ({ id, brokerage_id: b, team_id: team, name: `${CANARY_TAG} packet`, state: "FL", packet_type: "listing", form_code: null, description: CANARY_TAG, storage_path: p, field_count: 3, version: 1, is_active: true, license_note: "own form", license_expires_at: null, source_platform_packet_id: null, uploaded_by: null })
    const pA = path(`brokerage/${A}`, PA), pT = path(`teams/${T}`, PT), pT2 = path(`teams/${T2}`, PT2), pB = path(`brokerage/${B}`, PB)
    svc.tables.brokerage_form_library.push(row(PA, A, null, pA), row(PT, A, T, pT), row(PT2, A, T2, pT2), row(PB, B, null, pB))
    const agentA = actorOf({ brokerageId: A, userType: "agent", teamId: T })
    const agentB = actorOf({ brokerageId: B, userType: "agent" })
    const ua = await tp.usableTenantPacketPaths(svc, agentA, [pA, pT, pT2, pB])
    const ub = await tp.usableTenantPacketPaths(svc, agentB, [pA, pT, pT2, pB])
    return {
      ownBrokerageAndTeam: ua.ok && ua.usable.has(pA) && ua.usable.has(pT),
      notAnotherTeam: ua.ok && !ua.usable.has(pT2),
      notAnotherBrokerage: ua.ok && !ua.usable.has(pB) && ub.ok && ![pA, pT, pT2].some((p) => ub.usable.has(p)) && ub.usable.has(pB),
      catalogueMasterRefused: !(await checkFormPathsInScope(svc, [`platform/${uuid()}/contract.pdf`], { brokerageId: A, teamId: T, userId: U })).ok,
    }
  })() : null
  c.rule("144C", "NO CROSS-TENANT LEAKAGE (ruling 3: 'Agents only see packets reachable through their actual memberships/permissions'): an agent of brokerage A on team 1 may fill A's brokerage packet and team 1's packet — never team 2's, never brokerage B's; B's agent reaches B's only; and no tenant fills a platform catalogue master directly — at HEAD the platform listing takes no tenant and offers every approved packet to every subscriber", allTrue(leak), leak ? `landed library: ${JSON.stringify(leak)}` : "HEAD: listPlatformPacketsForTenant takes no tenant (wave 143 m807) — every approved packet is listed to every subscriber")

  // ── 4 · FormWizard keeps Media-vs-provider (or both) and AI coaching (green — preserve) ──
  const seq = await import("../../lib/forms/form-wizard-sequence")
  const both = seq.offerFormSourceFor([{ source: "my_forms" }, { source: "legal_forms_provider", providerName: "SkySlope" }])
  const providerOnly = seq.offerFormSourceFor([{ source: "legal_forms_provider", providerName: "SkySlope" }])
  const coach = (seq as unknown as { AI_COACH_RULES: readonly string[] }).AI_COACH_RULES ?? []
  c.rule("144C", "MEDIA-vs-PROVIDER, OR A FORM FROM BOTH (green — preserve): the wizard's source vocabulary is my_forms (the brokerage / team library) | legal_forms_provider (the tenant-selected provider, its own capability); a packet mixing both is accepted (recorded in_app), a provider-only packet records the provider; the AI coach's rules stay (it coaches — it never invents legal terms, signatures or material facts)", both === "in_app" && providerOnly === "skyslope" && coach.length > 0 && coach.some((r) => /never|not/i.test(r)), `both → ${both}; provider-only → ${providerOnly}; coach rules ${coach.length}`)

  c.blind("The bucket itself is not touched (the harness refuses storage); ownership is proved on the path predicate and the registry read. A GENUINELY platform-provided packet may stay platform-sourced as a separate, clearly labelled source if the lane's convergence keeps one — step 3 seeds a BROKERAGE-owned packet, so it asserts only that a tenant's packet never leaks.")
  const cl = await cleanupCanary(svc, A)
  const cl2 = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length + cl2.mismatches.length === 0 && cl.residual + cl2.residual === 0, [...cl.cleanup, ...cl2.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...cl.cleanup, ...cl2.cleanup], cl.residual + cl2.residual)
}
