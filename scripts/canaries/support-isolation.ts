/**
 * scripts/canaries/support-isolation.ts — SECURITY / SUPPORT canary (wave 142, lane 142J):
 *   a tenant reads only ITS tickets · platform staff read globally by platform_role · no superadmin fallback ·
 *   the two lanes notify the side that answers them · SLA breaches page the answering side once
 * through the survivors at HEAD: lib/support/ticket-constants.ts (ticketAnsweredBy — which organisation answers a
 * lane), lib/support/support-thread.ts (postTicketReply → the message, the first-response stamp and the bell for the
 * OTHER side; loadTicketThread), lib/support/support-sla.ts (evaluateTicketSla pure; runSupportSlaSweep — breach →
 * the answering side, deduped per ticket × kind) and lib/platform/platform-staff-roster.ts (resolvePlatformRoleIdentity
 * / platformStaffCan / isPlatformSuperadminIdentity — platform authority is platform_role and NOTHING else since the
 * owner's 2026-10-14 ruling + m780). Owner (wave 142, verbatim): "tenant should not read ticket queue across
 * brokerages, only their tenancy."
 *
 * THE LIVE FINDING THIS CANARY HELD (SURVIVORS142 §1, fec8b6a95): app/actions/support.ts:108 callerReadsAllBrokerages
 * admitted `ctx.userType === "support"` — a storable TENANT seat — to every brokerage's tickets. LANDED (lane 142A,
 * wired 142K): lib/support/ticket-scope.ts is the ONE scope decision (resolveTicketQueueScope / scopeTicketQuery /
 * ticketWithinScope), driven pure and COUNTED on the in-memory client below; the session doors need a request, so the
 * door rule is asserted on STRIPPED source. In-memory only: support_tickets holds 0 live rows (2026-10-19).
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, strippedRepo } from "./_registry"
import { exportedAsyncBodies } from "./crm-inbound"

/** PURE: the bodies of a "use server" module's exported async functions that touch support_tickets WITHOUT a
 *  tenant anchor — the shape this canary refuses. An anchor is one of: the SESSION tenant on the predicate
 *  (`.eq("brokerage_id", ctx.brokerageId)`) or on the insert (`brokerage_id: brokerageId` / `ctx.brokerageId`), the
 *  SUBMITTER ownership resolve (callerIsTicketSubmitter / `.eq("submitted_by_user_id", ctx.userId)` — a person reads
 *  the tickets they raised), or the admin / platform scope helpers (which pin or refuse inside).
 *  @proofSeam held with specimens below. */
export function tenantUnpinnedTicketReaders(stripped: string): string[] {
  // WIRED 142K (lane 142A landed): the SESSION pin is now the ONE predicate lib/support/ticket-scope.ts scopeTicketQuery /
  // ticketWithinScope, decided by resolveQueueScope (requirePlatformCapability("support") → platform_role) — the arm
  // `callerReadsAllBrokerages(` is gone from the file; it stays in this list only so the POSITIVE CONTROL specimen below
  // still reads as "pinned by a helper", never as a live anchor.
  const ANCHOR = /\.eq\(\s*["']brokerage_id["']\s*,\s*ctx\.brokerageId\s*\)|brokerage_id:\s*(brokerageId|ctx\.brokerageId)\b|callerIsTicketSubmitter\(|\.eq\(\s*["']submitted_by_user_id["']\s*,\s*ctx\.userId\s*\)|callerReadsAllBrokerages\(|requirePlatformCapability\(|resolveAdminTicketScope\(|isPlatformSuperadminIdentity\(|scopeTicketQuery\(|resolveQueueScope\(|ticketWithinScope\(/
  return exportedAsyncBodies(stripped)
    .filter(({ body }) => /\.from\(\s*["']support_tickets["']\s*\)/.test(body))
    .filter(({ body }) => !ANCHOR.test(body))
    .map((f) => f.name)
}
/** PURE: does an authority helper admit a TENANT user_type to the cross-brokerage read? (`userType === "support"`,
 *  `userType === "superadmin"` — the two arms the rulings forbid.) */
export function tenantTypeCrossTenantArm(stripped: string): string[] {
  return [...stripped.matchAll(/userType\s*===\s*["'](support|superadmin|super_admin)["']/g)].map((m) => m[1])
}

export async function run() {
  const c = canary("Support isolation: a tenant reads only its tenancy · platform staff by platform_role · lanes notify their answering side · SLA pages once")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — support_tickets holds 0 live rows, a live run proves nothing and a reply is a bell to real staff")
  const B = uuid(), B2 = uuid(), P = uuid()
  const ADMIN = uuid(), SUPPORT_SEAT = uuid(), AG_U = uuid(), AG = uuid(), ADMIN2 = uuid(), AG2_U = uuid(), AG2 = uuid(), STAFF = uuid()
  const T1 = uuid(), T2 = uuid(), T3 = uuid(), T4 = uuid()
  const old = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  const svc = canaryClient({
    brokerages: [
      { id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-sup` },
      { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-sup2` },
      { id: P, name: `${CANARY_TAG} Platform`, plan_tier: "brokerage", slug: `${CANARY_TAG}-platform` },
    ],
    users: [
      { id: ADMIN, email: `admin@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: B, platform_role: null },
      // THE SEAT THE RULING NAMES: a tenant user typed 'support' — a brokerage's own help desk, not platform staff.
      { id: SUPPORT_SEAT, email: `helpdesk@${CANARY_EMAIL_DOMAIN}`, user_type: "support", brokerage_id: B, platform_role: null },
      { id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, platform_role: null, first_name: "Canary", last_name: "Agent" },
      { id: ADMIN2, email: `admin2@${CANARY_EMAIL_DOMAIN}`, user_type: "broker", brokerage_id: B2, platform_role: null },
      { id: AG2_U, email: `agent2@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B2, platform_role: null, first_name: "Canary", last_name: "Two" },
      // Platform staff: user_type admin + platform_role support (the measured live shape — never user_type superadmin).
      { id: STAFF, email: `staff@${CANARY_EMAIL_DOMAIN}`, user_type: "admin", brokerage_id: P, platform_role: "support" },
    ],
    agents: [
      { id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true },
      { id: AG2, user_id: AG2_U, brokerage_id: B2, first_name: "Canary", last_name: "Two", is_active: true },
    ],
    support_tickets: [
      // Lane 1: tenant B asks the PLATFORM.
      { id: T1, brokerage_id: B, lane: "tenant_to_platform", status: "open", priority: "medium", category: "technical", subject: `${CANARY_TAG} billing page blank`, description: "The billing page renders blank.", submitted_by_user_id: ADMIN, agent_id: null, first_response_at: null, resolved_at: null, created_at: nowIso(), updated_at: nowIso() },
      // Lane 2: an agent of B2 asks ITS OWN office.
      { id: T2, brokerage_id: B2, lane: "user_to_brokerage", status: "open", priority: "high", category: "general", subject: `${CANARY_TAG} need listing packet`, description: "Where is the listing packet?", submitted_by_user_id: AG2_U, agent_id: AG2, first_response_at: null, resolved_at: null, created_at: nowIso(), updated_at: nowIso() },
      // Breached: an URGENT lane-1 ticket 3 h old with no first response (target 1 h) → the platform is paged.
      { id: T3, brokerage_id: B, lane: "tenant_to_platform", status: "open", priority: "urgent", category: "technical", subject: `${CANARY_TAG} cannot log in`, description: "Nobody can log in.", submitted_by_user_id: ADMIN, agent_id: null, first_response_at: null, resolved_at: null, created_at: old(3), updated_at: old(3) },
      // Breached: a HIGH lane-2 ticket 6 h old (target 4 h) → B2's OWN office is paged, never the platform.
      { id: T4, brokerage_id: B2, lane: "user_to_brokerage", status: "open", priority: "high", category: "general", subject: `${CANARY_TAG} commission question`, description: "What is my split?", submitted_by_user_id: AG2_U, agent_id: AG2, first_response_at: null, resolved_at: null, created_at: old(6), updated_at: old(6) },
    ],
  })
  setSvc(svc)
  const notes = () => svc.tables.notifications ?? []

  // ── 1 · the lane vocabulary: which organisation answers (pure) ──
  const { ticketAnsweredBy, isTicketLane, TICKET_LANES } = await import("../../lib/support/ticket-constants")
  c.step("lane vocabulary (pure): tenant_to_platform is answered by platform_support, user_to_brokerage by the brokerage_office; an unknown lane answers null (never a default side); the two lanes are the whole vocabulary", ticketAnsweredBy("tenant_to_platform") === "platform_support" && ticketAnsweredBy("user_to_brokerage") === "brokerage_office" && ticketAnsweredBy("anything_else") === null && ticketAnsweredBy(null) === null && isTicketLane("user_to_brokerage") && !isTicketLane("global") && TICKET_LANES.length === 2, TICKET_LANES.join(","))

  // ── 2 · platform authority is platform_role, and ONLY platform_role (owner 2026-10-14; m780 live) ──
  const { resolvePlatformRoleIdentity, platformStaffCan, isPlatformSuperadminIdentity } = await import("../../lib/platform/platform-staff-roster")
  c.step("platform authority: a TENANT 'support' seat resolves to NO platform role; platform_role 'support' resolves and may read the support console; a null role may not; user_type 'superadmin' with no platform_role is NEVER the OS user (no fallback)", resolvePlatformRoleIdentity("support", null) === null && resolvePlatformRoleIdentity("admin", "support") === "support" && platformStaffCan("support", "support") && !platformStaffCan(null, "support") && !platformStaffCan("agent", "support") && !isPlatformSuperadminIdentity("superadmin", null) && isPlatformSuperadminIdentity("admin", "superadmin"), "")

  // ── 3 · the thread rail answers the OTHER side of each lane, pinned to the ticket's tenant ──
  const { postTicketReply, loadTicketThread, awaitingFirstResponse } = await import("../../lib/support/support-thread")
  const officeReply = await postTicketReply(svc as never, { ticketId: T2, authorUserId: ADMIN2, authorKind: "staff", body: "It is under Documents › Listing packets." })
  const t2 = (svc.tables.support_tickets ?? []).find((t) => t.id === T2)
  const bellsB2 = notes().filter((n) => n.brokerage_id === B2)
  c.step("lane 2, the OFFICE answers: the reply lands as a support_ticket_messages row, stamps first_response_at and moves open → in_progress, and the bell goes to the SUBMITTER (the agent) pinned to B2 — no row lands under any other tenant", officeReply.ok && (svc.tables.support_ticket_messages ?? []).some((m) => m.ticket_id === T2 && m.author_kind === "staff" && m.author_user_id === ADMIN2) && !!t2?.first_response_at && t2.status === "in_progress" && !awaitingFirstResponse(t2 as { status: string; first_response_at: string | null }) && bellsB2.length === 1 && bellsB2[0].user_id === AG2_U && bellsB2[0].type === "support_reply" && notes().every((n) => n.brokerage_id === B2), officeReply.error ?? JSON.stringify(bellsB2.map((n) => n.type)))
  const askingReply = await postTicketReply(svc as never, { ticketId: T2, authorUserId: AG2_U, authorKind: "tenant", body: "Found it, thanks — one more question." })
  const officeBells = notes().filter((n) => n.brokerage_id === B2 && n.type === "support_ticket_reply")
  c.step("lane 2, the ASKING side replies: the brokerage's OWN office admins are told (B2's broker), never platform staff — the platform is not a party to a brokerage's internal ticket", askingReply.ok && officeBells.length === 1 && officeBells[0].user_id === ADMIN2 && !notes().some((n) => n.user_id === STAFF), askingReply.error ?? `${officeBells.length} office bell(s)`)
  const tenantReply = await postTicketReply(svc as never, { ticketId: T1, authorUserId: ADMIN, authorKind: "tenant", body: "Still blank after a hard refresh." })
  const staffBells = notes().filter((n) => n.user_id === STAFF)
  c.step("lane 1, the tenant replies to the PLATFORM: platform staff are told under THEIR OWN tenant row (the bell is counted where they read it), and no bell lands under B for a staff user", tenantReply.ok && staffBells.length === 1 && staffBells[0].brokerage_id === P && staffBells[0].type === "support_ticket_reply" && !notes().some((n) => n.brokerage_id === B && n.user_id === STAFF), tenantReply.error ?? `${staffBells.length} staff bell(s)`)
  const thread = await loadTicketThread(svc as never, T2)
  c.step("the thread reads the ticket WITH its tenant identity and the full message list in order (the same rail the tenant help UI and the platform console share)", !!thread && thread.brokerageId === B2 && thread.lane === "user_to_brokerage" && thread.messages.length === 2 && thread.messages[0].authorKind === "staff" && thread.messages[1].authorKind === "tenant" && thread.brokerageName === `${CANARY_TAG} Other`, thread ? `${thread.messages.length} messages` : "null")
  const unknown = await postTicketReply(svc as never, { ticketId: uuid(), authorUserId: ADMIN, authorKind: "tenant", body: "hello?" })
  c.step("POSITIVE CONTROL: a reply to a ticket that does not exist is refused by name (no message row, no bell)", !unknown.ok && /not found/i.test(unknown.error ?? "") && (svc.tables.support_ticket_messages ?? []).length === 3, unknown.error ?? "accepted")

  // ── 4 · SLA: breaches page the ANSWERING side, exactly once ──
  const { evaluateTicketSla, SLA_TARGETS_HOURS, runSupportSlaSweep, canRateTicket } = await import("../../lib/support/support-sla")
  const urgent = evaluateTicketSla({ created_at: old(3), priority: "urgent", status: "open", first_response_at: null, resolved_at: null })
  const closed = evaluateTicketSla({ created_at: old(300), priority: "urgent", status: "closed", first_response_at: null, resolved_at: null })
  c.step(`SLA (pure): an urgent ticket 3 h old with no first response breaches first_response (target ${SLA_TARGETS_HOURS.urgent.firstResponse} h) and not resolution (${SLA_TARGETS_HOURS.urgent.resolution} h); a closed ticket never breaches; a resolved ticket can be rated once, 1–5`, urgent.breaches.join() === "first_response" && closed.breaches.length === 0 && canRateTicket({ status: "resolved", satisfaction_rating: null }, 5).ok && !canRateTicket({ status: "open", satisfaction_rating: null }, 5).ok && !canRateTicket({ status: "resolved", satisfaction_rating: 4 }, 5).ok && !canRateTicket({ status: "resolved", satisfaction_rating: null }, 6).ok, JSON.stringify(urgent.breaches))
  const before = notes().length
  const sweep = await runSupportSlaSweep(svc, new Date())
  const esc = notes().slice(before)
  const platformEsc = esc.filter((n) => n.entity_id === T3), officeEsc = esc.filter((n) => n.entity_id === T4)
  c.step("SLA sweep: the breached lane-1 ticket pages PLATFORM staff (under their row); the breached lane-2 ticket pages B2's OFFICE (under B2) and never the platform; the fresh tickets page nobody", sweep.open === 4 && sweep.breached === 2 && sweep.escalated === 2 && platformEsc.length === 1 && platformEsc[0].user_id === STAFF && platformEsc[0].brokerage_id === P && officeEsc.length === 1 && officeEsc[0].user_id === ADMIN2 && officeEsc[0].brokerage_id === B2 && !esc.some((n) => n.entity_id === T1 || n.entity_id === T2), JSON.stringify(sweep))
  const again = await runSupportSlaSweep(svc, new Date())
  c.step("SLA sweep is idempotent: the same breaches an hour later escalate NOBODY again (one escalation per ticket × kind, ever)", again.breached === 2 && again.escalated === 0 && notes().length === before + 2, JSON.stringify(again))

  // ── 5 · the session doors, on stripped source (they need a request) ──
  const support = strippedRepo("app/actions/support.ts") ?? ""
  const console_ = strippedRepo("app/actions/superadmin/support-console.ts") ?? ""
  const listBody = exportedAsyncBodies(support).find((f) => f.name === "listBrokerageTickets")?.body ?? "", flipBody = exportedAsyncBodies(support).find((f) => f.name === "updateTicketStatus")?.body ?? ""
  const gateFirst = (b: string) => b.search(/\bresolveQueueScope\s*\(/) >= 0 && b.search(/\bcreateServiceClient\s*\(/) >= 0 && b.search(/\bresolveQueueScope\s*\(/) < b.search(/\bcreateServiceClient\s*\(/)
  c.step("tenant doors pin the tenant (the RULE, landed 142A): every exported reader of support_tickets in app/actions/support.ts either pins brokerage_id from the SESSION (scopeTicketQuery / ticketWithinScope) or goes through the platform/admin scope helpers (0 unpinned readers); the list and the status-flip doors resolve the scope BEFORE the service client exists (gate first, §4) and pin the query through scopeTicketQuery", tenantUnpinnedTicketReaders(support).length === 0 && gateFirst(listBody) && gateFirst(flipBody) && /scopeTicketQuery\(/.test(listBody) && /scopeTicketQuery\(/.test(flipBody), tenantUnpinnedTicketReaders(support).join(",") || "0 unpinned; gate-first on both doors")
  c.step("the PLATFORM console is gated by the ONE capability gate (requirePlatformCapability(\"support\") — platform_role), lists ONLY the tenant_to_platform lane (a brokerage's internal queue is never the platform's), and audits staff mutations", /requirePlatformCapability\(\s*["']support["']\s*\)/.test(console_) && /CONSOLE_LANE\s*=\s*["']tenant_to_platform["']/.test(console_) && /superadmin_audit_log/.test(console_) && !/userType\s*===\s*["']superadmin["']/.test(console_), "")
  c.step("POSITIVE CONTROL: the finder catches an exported reader that selects support_tickets with no tenant predicate and no gate, and an authority arm that admits `userType === \"support\"`; a pinned reader and a platform_role read are not caught", tenantUnpinnedTicketReaders(`export async function listAll() { const svc = createServiceClient(); const { data } = await svc.from("support_tickets").select("id"); return data }\nexport async function listMine(ctx) { const { data } = await createServiceClient().from("support_tickets").select("id").eq("brokerage_id", ctx.brokerageId); return data }`).join() === "listAll" && tenantTypeCrossTenantArm(`if (ctx.userType === "support") return true\nreturn isPlatformSuperadminIdentity(row?.user_type, row?.platform_role)`).join() === "support" && tenantTypeCrossTenantArm(`return isPlatformSuperadminIdentity(row?.user_type, row?.platform_role)`).length === 0)

  // ── WAVE142 HOOK (integrator): 142A — the tenant 'support' arm removed; m781 ALTER POLICY set + m782 owner SQL. ──
  for (const h of hooksFor("support-isolation")) {
    const at = h.probe()
    if (!at) {
      c.hook(h.lane, h.contract, /SUPPORT ISOLATION/.test(h.contract) ? `at HEAD app/actions/support.ts callerReadsAllBrokerages admits userType === "${tenantTypeCrossTenantArm(support).join(",") || "?"}" to every brokerage (the arm the ruling removes)` : "at HEAD no m781 ALTER POLICY migration exists; the 37 live policies are listed in $S/live-superadmin-policies-2026-10-18.md")
      continue
    }
    if (/SUPPORT ISOLATION/.test(h.contract)) {
      // WAVE142 HOOK (integrator): 142A — wired 142K: the ONE scope decision driven pure, the predicate COUNTED on the
      // in-memory client, the doors asserted on stripped source (they need a request).
      const { SUPPORT_DESK_USER_TYPES, resolveTicketQueueScope, scopeTicketQuery, ticketWithinScope } = await import("../../lib/support/ticket-scope")
      const { TENANT_ADMIN_USER_TYPES } = await import("../../lib/auth/resolve-user-role")
      const roster = TENANT_ADMIN_USER_TYPES as ReadonlySet<string>
      const tenantSeat = resolveTicketQueueScope({ platformSupport: false, userType: "support", brokerageId: B })
      const noTenant = resolveTicketQueueScope({ platformSupport: false, userType: "support", brokerageId: null })
      const producer = resolveTicketQueueScope({ platformSupport: false, userType: "agent", brokerageId: B })
      const legacy = resolveTicketQueueScope({ platformSupport: false, userType: "superadmin", brokerageId: B })
      const platform = resolveTicketQueueScope({ platformSupport: true, userType: "support", brokerageId: null })
      c.step(`${h.lane} landed (${at}) — THE ONE SCOPE DECISION (lib/support/ticket-scope.ts resolveTicketQueueScope, pure): a tenant 'support' seat reads ITS OWN tenant only; no session tenant → refused; a producer (agent) → refused; the legacy 'superadmin' TYPE → refused (a user_type can only refuse, never widen); ONLY the platform verdict (platform_role through requirePlatformCapability) reads across; the desk roster is TENANT_ADMIN_USER_TYPES spread + 'support' (${roster.size} + 1), never a retyped list`, tenantSeat.kind === "tenant" && tenantSeat.brokerageId === B && noTenant.kind === "refused" && producer.kind === "refused" && legacy.kind === "refused" && platform.kind === "platform" && [...roster].every((t) => SUPPORT_DESK_USER_TYPES.has(t)) && SUPPORT_DESK_USER_TYPES.has("support") && SUPPORT_DESK_USER_TYPES.size === roster.size + 1 && !SUPPORT_DESK_USER_TYPES.has("agent") && !SUPPORT_DESK_USER_TYPES.has("superadmin"), [...SUPPORT_DESK_USER_TYPES].join(","))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the in-memory builder is the PostgREST shape the predicate pins
      const q = (): any => svc.from("support_tickets")
      const own = await (scopeTicketQuery(q().select("id, brokerage_id"), { kind: "tenant", brokerageId: B }) as Promise<{ data: Array<{ id: string; brokerage_id: string }> | null }>)
      const all = await (scopeTicketQuery(q().select("id, brokerage_id"), { kind: "platform" }) as Promise<{ data: Array<{ id: string }> | null }>)
      const flip = await (scopeTicketQuery(q().update({ status: "resolved" }), { kind: "tenant", brokerageId: B }).eq("id", T2).select("id") as Promise<{ data: Array<{ id: string }> | null; error: { message: string } | null }>)
      c.step(`${h.lane} the PREDICATE on the service client, COUNTED: the tenant scope sees B's 2 tickets and none of B2's; the platform scope sees all 4; a tenant-scoped status flip on B2's ticket matches ZERO rows (the §3 shape updateTicketStatus counts and refuses as 'Ticket not found') and B2's row is untouched; ticketWithinScope admits only the session tenant's ticket (and nothing with no tenant)`, (own.data ?? []).length === 2 && (own.data ?? []).every((t) => t.brokerage_id === B) && (all.data ?? []).length === 4 && !flip.error && (flip.data ?? []).length === 0 && (svc.tables.support_tickets ?? []).find((t) => t.id === T2)?.status === "in_progress" && ticketWithinScope({ brokerage_id: B }, { kind: "tenant", brokerageId: B }) && !ticketWithinScope({ brokerage_id: B2 }, { kind: "tenant", brokerageId: B }) && ticketWithinScope({ brokerage_id: B2 }, { kind: "platform" }) && !ticketWithinScope({ brokerage_id: null }, { kind: "tenant", brokerageId: B }), `own ${(own.data ?? []).length}, all ${(all.data ?? []).length}, cross-tenant flip matched ${(flip.data ?? []).length}`)
      const adminPage = strippedRepo("app/dashboard/admin/support-tickets/page.tsx") ?? ""
      c.step(`${h.lane} the DOORS (stripped source): NO tenant user_type is a cross-tenant authority arm in app/actions/support.ts (support / superadmin arms absent; callerReadsAllBrokerages deleted); the cross-brokerage read is decided by the ONE platform gate (requirePlatformCapability("support") → platform_role through the roster) feeding resolveTicketQueueScope; the admin page gates on SUPPORT_DESK_USER_TYPES (no six-string roster literal)`, tenantTypeCrossTenantArm(support).length === 0 && /requirePlatformCapability\(\s*["']support["']\s*\)/.test(support) && /resolveTicketQueueScope\(/.test(support) && !/callerReadsAllBrokerages/.test(support) && /SUPPORT_DESK_USER_TYPES\.has\(/.test(adminPage) && !/\[\s*["']broker["'],\s*["']broker_admin["']/.test(adminPage), tenantTypeCrossTenantArm(support).join(",") || "0 arms")
      continue
    }
    const sql = (await import("node:fs")).readFileSync((await import("node:path")).join(process.cwd(), at), "utf8")
    const statements = sql.split("\n").filter((l) => /^\s*ALTER\s+POLICY/i.test(l))
    c.step(`${h.lane} landed (${at}): the reviewed migration is ALTER POLICY statements only (no DROP POLICY / DROP CONSTRAINT — those are the owner's SQL-editor file m782), carries the lane stamp or the APPLIED LIVE stamp, admits by is_platform_admin() / is_platform_staff(), and names no inline user_type 'superadmin' arm`, statements.length > 0 && !/^\s*DROP\s+(POLICY|CONSTRAINT)/mi.test(sql) && /WRITTEN, NOT APPLIED|APPLIED LIVE/.test(sql) && /is_platform_(admin|staff)\(\)/.test(sql) && !/user_type\s*=\s*'superadmin'|'superadmin'\s*=\s*ANY|'super_admin'/i.test(sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")), `${statements.length} ALTER POLICY statement(s)`)
  }
  c.blind("RLS is not modelled in memory: the policies on support_tickets / support_ticket_messages are the integrator's live census ($S/live-superadmin-policies-2026-10-18.md) and lane 142A's m781; what runs here is the app-side tenant predicate + the lane rail. The session doors (getAgentContext) are asserted on stripped source. The platform console's requirePlatformCapability is exercised by test:support-console, not driven here.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(svc, B2), p = await cleanupCanary(svc, P)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length + p.mismatches.length === 0 && a.residual + b.residual + p.residual === 0, [...a.cleanup, ...b.cleanup, ...p.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup, ...p.cleanup], a.residual + b.residual + p.residual)
}
