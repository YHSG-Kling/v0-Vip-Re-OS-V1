#!/usr/bin/env tsx
/**
 * scripts/send-recovery-guard.ts   (npm run test:send-recovery) — in memory, no DB, no network, no live provider.
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 153, LANE 153S — owner ruling B10: "crash mid-send is marked 'outcome unknown' and need to be re-sent automatically"
 * — reconcile FIRST, never a blind duplicate.
 *
 * DRIVES THE REAL CODE over scripts/in-memory-supabase.ts (agent_action_ledger with its UNIQUE idempotency_key → 23505):
 *   · lib/providers/dispatch.ts intentLedgerContext — the persisted send intent every email / SMS / mail send now writes
 *     (key precedence, replay envelope, digest) — and ledgerKeyFromCycle against the ledger's own derivation;
 *   · lib/kernel/action-ledger.ts withActionLedger / settleDispatchResult / replayDispatchResult — the real claim, the real
 *     23505 → re-read → guarded re-claim that makes ONE business intent at most one provider call;
 *   · lib/outcomes/reconciliation-ledger.ts recoverOutcomeUnknownSends (dead claim → unknown → lease → ladder),
 *     settleUnknownActions (never abandons a send intent), ingestProviderTruth (monotonic, wrong tenant refused),
 *     acceptIntentFromProviderEvent (Lob echoes the intent) and the LIVE relevance + escalation (they read / write `svc`);
 *   · lib/outcomes/reconciliation.ts decideSendRecovery / SEND_RECOVERY_CAPABILITIES and the pure Twilio / Lob verdicts.
 * INJECTED (SIMULATED, never live): the provider itself (a fake Twilio message log, a fake Lob that honours Idempotency-Key
 * the way Lob documents it), the probe that asks it, and the re-dispatch's gate chain (the redispatch seam re-enters the REAL
 * intent context + REAL ledger with the same key; dispatch.ts's consent / suppression / DNC gates are not run here — they
 * need a database — see BLIND SPOTS).
 *
 * SCENARIOS (the brief's list): crash before the request · accepted before the DB write · DB write before the webhook · two
 * concurrent workers · provider 429 · repeated webhook · wrong-tenant webhook · provider outage · Contact replied before the
 * retry · cancelled campaign · a provider with no safe retry → exception, no duplicate · Lob idempotent create (inside / past
 * its window). Every absence assertion carries a positive control (CLAUDE.md §2).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const code = (p: string) => { try { return stripComments(readFileSync(join(ROOT, p), "utf8")) } catch { return "" } }
const tick = () => new Promise((r) => setTimeout(r, 15))

const B = randomUUID(), B2 = randomUUID(), CONTACT = randomUUID(), CONTACT2 = randomUUID(), LEAD = randomUUID(), ENR = randomUUID(), STEP = randomUUID()
const MIN = 60_000, HOUR = 3_600_000

async function main() {
  const dispatch = await import("../lib/providers/dispatch")
  const ledger = await import("../lib/kernel/action-ledger")
  const rl = await import("../lib/outcomes/reconciliation-ledger")
  const rc = await import("../lib/outcomes/reconciliation")
  const scope = await import("../lib/outcomes/send-intent-scope")

  // ── the in-memory world ───────────────────────────────────────────────────────────────────────────────────────────
  const freshDb = (extra: Record<string, Row[]> = {}): MemClient => memSupabase({
    agent_action_ledger: [], outcome_reconciliations: [], messages: [], lead_conversation_history: [], self_heal_events: [],
    sequence_enrollments: [{ id: ENR, brokerage_id: B, status: "active" }], campaign_bundle_dispatches: [], campaign_bundles: [],
    ...extra,
  }, { stampCreatedAt: true, uuidIds: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
  /** The live column DEFAULTs (m687: updated_at DEFAULT now(), attempts NOT NULL DEFAULT 1) — the in-memory insert carries none. */
  const defaults = (d: MemClient) => { for (const r of d.tables.agent_action_ledger) { if (!r.updated_at) r.updated_at = r.created_at; if (r.attempts == null) r.attempts = 1 } }
  const rows = (d: MemClient) => d.tables.agent_action_ledger

  // ── fake providers (SIMULATED) ────────────────────────────────────────────────────────────────────────────────────
  const twilio = {
    log: [] as Array<{ sid: string; to: string; body: string; date_created: string }>,
    calls: 0, rateLimited: false, down: false,
    send(to: string, body: string) { this.calls++; const sid = `SM${randomUUID().replace(/-/g, "").slice(0, 32)}`; this.log.push({ sid, to, body, date_created: new Date().toUTCString() }); return sid },
    list(to: string) {
      if (this.down) throw new Error("connect ECONNREFUSED api.twilio.com")
      if (this.rateLimited) return { ok: false, status: 429, data: null, error: "Too Many Requests" }
      return { ok: true, status: 200, data: { messages: this.log.filter((m) => m.to === to).slice().reverse() }, error: null }
    },
    deliveredTo(to: string) { return this.log.filter((m) => m.to === to).length },
    reset() { this.log = []; this.calls = 0; this.rateLimited = false; this.down = false },
  }
  const lob = {
    byKey: new Map<string, string>(), created: 0, listLag: false,
    /** Lob documents: a create repeating an Idempotency-Key returns the ORIGINAL object, not a second piece. */
    create(key: string | null) { if (key && this.byKey.has(key)) return this.byKey.get(key)!; this.created++; const id = `ltr_${randomUUID().slice(0, 12)}`; if (key) this.byKey.set(key, id); return id },
    list(key: string) { const id = this.byKey.get(key); return { ok: true, status: 200, data: { data: id ? [{ id }] : [] }, error: null } },
    reset() { this.byKey.clear(); this.created = 0; this.listLag = false },
  }
  const sendgrid = { calls: 0, reset() { this.calls = 0 } }

  const hooks = { settle: (r: { success: boolean; providerKey: string; messageId?: string; error?: string }) => ledger.settleDispatchResult(r, 0.0079), replay: ledger.replayDispatchResult }
  const ACTION = { sms: "comms.sms.send", email: "comms.email.send", direct_mail: "comms.direct_mail.send" } as const
  const ctxFor = (kind: "sms" | "email" | "direct_mail", params: Record<string, any>) =>
    dispatch.intentLedgerContext(ACTION[kind], kind, params as never, kind === "direct_mail" ? `${params.mailingAddress}, ${params.zip}` : params.to, kind,
      kind === "sms" ? { to: params.to, message: params.message } : kind === "email" ? { to: params.to, subject: params.subject, html: params.html } : { to: params.mailingAddress, template: params.templateId })
  /** The provider half of a dispatcher (the gate chain is not run here — BLIND SPOT). */
  const providerCall = (kind: "sms" | "email" | "direct_mail", params: Record<string, any>, key: string | null) => {
    if (kind === "sms") return { success: true, providerKey: "twilio", messageId: twilio.send(params.to, params.message) }
    if (kind === "direct_mail") return { success: true, providerKey: "lob", messageId: lob.create(key ? dispatch.lobIntentKey(key) : null) }
    sendgrid.calls++
    return { success: true, providerKey: "sendgrid", messageId: `sg-${randomUUID().slice(0, 8)}` }
  }
  /** A dispatch: the REAL persisted intent + the REAL ledger, around the provider call. */
  const send = (d: MemClient, kind: "sms" | "email" | "direct_mail", params: Record<string, any>) => {
    const ctx = ctxFor(kind, params)
    return ledger.withActionLedger(ctx, async () => providerCall(kind, params, ctx.idempotencyKey ?? null), hooks, { client: d as never })
  }
  /** A dispatch whose PROCESS DIES: `providerFirst` = the provider took it before the death (accepted before the DB write). */
  const sendAndDie = async (d: MemClient, kind: "sms" | "email" | "direct_mail", params: Record<string, any>, providerFirst: boolean) => {
    const ctx = ctxFor(kind, params)
    void ledger.withActionLedger(ctx, async () => { if (providerFirst) providerCall(kind, params, ctx.idempotencyKey ?? null); return new Promise<never>(() => {}) }, hooks, { client: d as never })
    await tick(); defaults(d)
    return ctx
  }
  const smsParams = (over: Record<string, any> = {}): Record<string, any> => ({ brokerageId: B, systemSource: "proof_153s", contactId: CONTACT, to: "+18505550101", message: `Hi Dana — the Pace open house moved to Saturday 1pm (${randomUUID().slice(0, 6)})`, ...over })
  const mailParams = (over: Record<string, any> = {}) => ({ brokerageId: B, systemSource: "proof_153s", contactId: CONTACT, recipientName: "Dana Rivera", mailingAddress: "12 Gulf Breeze Pkwy", city: "Pace", state: "FL", zip: "32571", templateId: "tmpl_front_1", pieceType: "letter", ...over })
  const emailParams = (over: Record<string, any> = {}) => ({ brokerageId: B, systemSource: "proof_153s", contactId: CONTACT, to: "dana.rivera@example.test", subject: "Your Pace market update", html: "<p>Three homes sold near you.</p>", ...over })

  const deps = (d: MemClient, now: Date, extra: Partial<Parameters<typeof rl.recoverOutcomeUnknownSends>[2]> = {}) => ({
    now,
    probe: async (row: any) => {
      const replay = row.detail?.send_intent?.replay
      if (row.channel === "sms") return { capKey: "twilio_sms", probe: rl.twilioListVerdict(twilio.list(replay.params.to), row.created_at, replay.params.message) }
      if (row.channel === "direct_mail") return { capKey: "lob_direct_mail", probe: lob.listLag ? { kind: "indeterminate" as const, why: "Lob list lag (simulated)" } : rl.lobListVerdict(lob.list(dispatch.lobIntentKey(row.idempotency_key))) }
      if (row.channel === "email") return { capKey: "sendgrid_email", probe: { kind: "indeterminate" as const, why: "no provider status query proves an email was or was not accepted" } }
      return { capKey: "unknown", probe: { kind: "indeterminate" as const, why: "no query" } }
    },
    // The re-send door, exactly as redispatchSendIntent builds it: the replay params + ledger, the SAME key, the REAL intent
    // context and the REAL ledger (re-claim) — only the gate chain is skipped (it needs a database).
    redispatch: async (replay: any, key: string) => {
      const params = { ...replay.params, ledger: { ...replay.ledger, idempotencyKey: key } }
      return send(d, replay.kind, params)
    },
    ...extra,
  })
  const recover = (d: MemClient, now: Date, extra: Partial<Parameters<typeof rl.recoverOutcomeUnknownSends>[2]> = {}) => rl.recoverOutcomeUnknownSends(B, d as never, deps(d, now, extra) as never)
  const later = (ms: number) => new Date(Date.now() + ms)
  const resetAll = () => { twilio.reset(); lob.reset(); sendgrid.reset() }

  // ══ 0 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("0 · the persisted intent — every send is keyed BEFORE the provider call")
  {
    const d = freshDb()
    const cyc = ledger.withActionLedger({ brokerageId: B, action: "comms.sms.send", channel: "sms", actor: { type: "system" }, subject: { type: "contact", id: CONTACT }, cycle: `enrollment:${ENR}:step:${STEP}`, riskClass: "COMMUNICATION" } as never,
      async () => ({ success: true, providerKey: "twilio", messageId: "SMx" }), hooks, { client: d as never })
    await cyc
    const derived = rows(d)[0]?.idempotency_key
    check("the dispatcher's cycle key is BYTE-IDENTICAL to the ledger's own derivation (ledgerKeyFromCycle mirror)", derived === dispatch.ledgerKeyFromCycle({ brokerageId: B, subjectType: "contact", subjectId: CONTACT, action: "comms.sms.send", cycle: `enrollment:${ENR}:step:${STEP}` }), `${derived}`)
    const p = smsParams({ ledger: { cycle: `enrollment:${ENR}:step:${STEP}` } })
    const before = JSON.stringify(p)
    const c1 = ctxFor("sms", p)
    check("cycle → the intent key IS the ledger's cycle key (key_source cycle)", c1.idempotencyKey === derived && (c1.detail as any).send_intent.key_source === "cycle")
    check("the caller's params are never mutated", JSON.stringify(p) === before)
    const c2 = ctxFor("sms", smsParams({ ledger: { idempotencyKey: "caller-key-1", cycle: "x" } }))
    check("an explicit caller key wins over the cycle (key_source caller)", c2.idempotencyKey === "caller-key-1" && (c2.detail as any).send_intent.key_source === "caller")
    const c3 = await scope.withSendIntent("bundle_follow_on:D:I", async () => ctxFor("sms", smsParams()))
    check("inside withSendIntent the AMBIENT key is used, suffixed with the action (key_source ambient)", c3.idempotencyKey === "bundle_follow_on:D:I:comms.sms.send" && (c3.detail as any).send_intent.key_source === "ambient")
    check("POSITIVE CONTROL: outside any scope there is no ambient key", scope.ambientSendIntentKey("comms.sms.send") === null)
    const c4 = ctxFor("sms", smsParams()), c5 = ctxFor("sms", smsParams())
    check("no caller key, no cycle, no scope → a FRESH generated intent per call (never unkeyed, never shared)", /^intent:comms\.sms\.send:/.test(c4.idempotencyKey ?? "") && c4.idempotencyKey !== c5.idempotencyKey && (c4.detail as any).send_intent.key_source === "generated")
    const si = (c1.detail as any).send_intent
    check("the intent names tenant + provider scope, channel, cycle, a 64-hex content digest and the REPLAY envelope (params minus ledger, ledger minus key)",
      si.provider_scope.brokerage_id === B && si.channel === "sms" && /^[0-9a-f]{64}$/.test(si.content_digest) && si.replay?.kind === "sms" && si.replay.params.to === p.to && !("ledger" in si.replay.params) && !("idempotencyKey" in (si.replay.ledger ?? {})) && si.replay.ledger.cycle === p.ledger.cycle)
    check("the same content → the same digest; different content → a different digest", !!ctxFor("sms", { ...p }).detail && (ctxFor("sms", { ...p }).detail as any).send_intent.content_digest === si.content_digest && (ctxFor("sms", smsParams({ message: "other" })).detail as any).send_intent.content_digest !== si.content_digest)
    const big = ctxFor("email", emailParams({ html: "x".repeat(dispatch.SEND_INTENT_REPLAY_MAX_BYTES + 10) }))
    check("an envelope over the cap is WITHHELD and says so (reconcile-only, never a partial replay)", (big.detail as any).send_intent.replay === null && /bytes >/.test((big.detail as any).send_intent.replay_withheld ?? ""))
    check("Lob's header/metadata value: the key itself up to 256 chars, else its sha256 (stable)", dispatch.lobIntentKey("k") === "k" && dispatch.lobIntentKey("k".repeat(300)).length === 64 && dispatch.lobIntentKey("k".repeat(300)) === dispatch.lobIntentKey("k".repeat(300)))
    const unk = ledger.replayDispatchResult({ kind: "unknown", entry: { id: "x", status: "unknown" } as never })
    const inf = ledger.replayDispatchResult({ kind: "in_flight", entry: { id: "x", status: "proposed" } as never })
    const rep = ledger.replayDispatchResult({ kind: "replay", entry: { id: "x", status: "executed", provider: "twilio", provider_ref: "SM1" } as never })
    const ref = ledger.replayDispatchResult({ kind: "refused", error: "Action ledger refused the claim" })
    check("isOutcomePendingRecovery reads the LEDGER'S OWN words: unknown + in-flight → pending; replay / refused → not (positive + negative controls)",
      dispatch.isOutcomePendingRecovery(unk) && dispatch.isOutcomePendingRecovery(inf) && !dispatch.isOutcomePendingRecovery(rep) && !dispatch.isOutcomePendingRecovery(ref) && scope.isOutcomePendingRecoveryError(unk.error))
  }

  // ══ 1 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("1 · crash BEFORE the request — Twilio proves it never accepted → re-sent ONCE with the same key")
  {
    resetAll(); const d = freshDb()
    const p = smsParams()
    const ctx = await sendAndDie(d, "sms", p, false)
    const row = rows(d)[0]
    check("the claim was written BEFORE the provider call and is left 'proposed' by the dead process", row?.status === "proposed" && row.idempotency_key === ctx.idempotencyKey && twilio.calls === 0)
    const early = await recover(d, later(5 * MIN))
    check("POSITIVE CONTROL: inside the lease (5 min) the claim is NOT touched — a slow live send is never re-claimed", early.promoted === 0 && row.status === "proposed")
    const r = await recover(d, later(20 * MIN))
    check("past the lease: promoted to 'unknown' (outcome_unknown) — never failed, never delivered — then reconciled", r.promoted === 1 && r.retried === 1, JSON.stringify(r))
    check("…Twilio's log for the number is empty → the SAME key re-sent: exactly ONE provider delivery", twilio.deliveredTo(p.to) === 1 && twilio.calls === 1)
    check("…the SAME ledger row carried it (re-claimed attempts 2 → executed, the provider's sid on it) — no second row", rows(d).length === 1 && row.status === "executed" && row.attempts === 2 && /^SM/.test(row.provider_ref ?? ""), `${row.status} attempts=${row.attempts}`)
    const again = await recover(d, later(60 * MIN))
    await send(d, "sms", { ...p, ledger: { idempotencyKey: row.idempotency_key } })
    check("a later recovery pass AND a caller re-run of the same intent send nothing more (replay)", again.retried === 0 && twilio.calls === 1)
  }

  // ══ 2 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("2 · ACCEPTED before the DB write — Twilio confirms → recorded, NEVER resent")
  {
    resetAll(); const d = freshDb()
    const p = smsParams()
    await sendAndDie(d, "sms", p, true)
    const row = rows(d)[0]
    check("the provider took it, the process died before the settle (row 'proposed', one delivery)", row.status === "proposed" && twilio.deliveredTo(p.to) === 1)
    const r = await recover(d, later(20 * MIN))
    check("recovery finds OUR message (number + body in the attempt's window) → executed with Twilio's sid", r.reconciled === 1 && r.retried === 0 && row.status === "executed" && row.outcome === "reconciled_provider_accepted" && row.provider_ref === twilio.log[0].sid, JSON.stringify(r))
    check("…and still exactly ONE provider delivery", twilio.deliveredTo(p.to) === 1 && twilio.calls === 1)
    // a message to the number in the window whose body is NOT ours cannot prove either way
    const v = rl.twilioListVerdict({ ok: true, status: 200, data: { messages: [{ sid: "SMother", body: "unrelated", date_created: new Date().toUTCString() }] }, error: null }, new Date().toISOString(), "our body")
    check("a foreign message in the window → indeterminate (not proof of absence, not proof of presence)", v.kind === "indeterminate")
    const full = Array.from({ length: 50 }, (_, i) => ({ sid: `SM${i}`, body: "x", date_created: new Date(Date.now() + HOUR + i * MIN).toUTCString() }))
    check("a FULL page that does not reach back past the attempt → indeterminate (absence not proven)", rl.twilioListVerdict({ ok: true, status: 200, data: { messages: full }, error: null }, new Date().toISOString(), "our body").kind === "indeterminate")
  }

  // ══ 3 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("3 · DB write before the webhook · repeated webhook · late webhook · wrong-tenant webhook")
  {
    resetAll(); const d = freshDb()
    const res = await send(d, "sms", smsParams())
    const row = rows(d)[0]
    check("a normal send settles executed with the sid (the DB write precedes any webhook)", res.success && row.status === "executed" && row.provider_ref === res.messageId)
    d.tables.outcome_reconciliations.push({ id: randomUUID(), brokerage_id: B, channel: "sms", provider_ref: res.messageId, claimed_status: "queued", claimed_at: new Date().toISOString(), verdict: "pending", escalated_at: null, claimed_by_manager: "campaign_orchestrator", entity_type: "sms", entity_id: null, contact_id: CONTACT, lead_id: null, provider_reported_at: null })
    const recon = d.tables.outcome_reconciliations[0]
    const ledgerRowsBefore = rows(d).length, callsBefore = twilio.calls
    const wrong = await rl.ingestProviderTruth({ channel: "sms", providerRef: res.messageId!, truth: { status: "delivered", at: new Date().toISOString() }, expectedBrokerageId: B2, client: d as never })
    check("WRONG-TENANT webhook: refused, nothing recorded", wrong.ok === false && /wrong tenant/.test(wrong.reason ?? "") && recon.verdict === "pending" && recon.provider_status === undefined)
    const t1 = new Date().toISOString()
    const ok1 = await rl.ingestProviderTruth({ channel: "sms", providerRef: res.messageId!, truth: { status: "delivered", at: t1 }, expectedBrokerageId: B, client: d as never })
    check("POSITIVE CONTROL: the RIGHT tenant's webhook lands (confirmed)", ok1.ok && recon.verdict === "confirmed" && recon.provider_status === "delivered")
    const ok2 = await rl.ingestProviderTruth({ channel: "sms", providerRef: res.messageId!, truth: { status: "delivered", at: t1 }, client: d as never })
    check("REPEATED webhook: converges (still confirmed, same stamp)", ok2.ok && recon.verdict === "confirmed" && recon.provider_reported_at === t1)
    const late = await rl.ingestProviderTruth({ channel: "sms", providerRef: res.messageId!, truth: { status: "sent", at: new Date(Date.parse(t1) - MIN).toISOString() }, client: d as never })
    check("LATE webhook (an earlier 'sent' after 'delivered'): never walks the truth back", late.ok && recon.verdict === "confirmed" && recon.provider_status === "delivered")
    check("no webhook triggered a send or wrote a ledger row", twilio.calls === callsBefore && rows(d).length === ledgerRowsBefore)
  }

  // ══ 4 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("4 · TWO concurrent workers — one lease, one re-send")
  {
    resetAll(); const d = freshDb()
    const p = smsParams()
    await sendAndDie(d, "sms", p, false)
    const [a, b] = await Promise.all([recover(d, later(20 * MIN)), recover(d, later(20 * MIN))])
    check("two recovery workers on one dead intent: exactly ONE re-dispatch, ONE delivery", a.retried + b.retried === 1 && twilio.deliveredTo(p.to) === 1 && rows(d).length === 1, `${JSON.stringify(a)} ${JSON.stringify(b)}`)
    // two ORIGINAL callers of one intent at once (a replayed tick) — the ledger's own claim
    resetAll(); const d2 = freshDb()
    const k = { ledger: { idempotencyKey: `dup-${randomUUID()}` } }
    const [x, y] = await Promise.all([send(d2, "sms", smsParams(k)), send(d2, "sms", smsParams(k))])
    check("two concurrent sends of ONE intent: one provider call, the other declined or replayed", twilio.calls === 1 && [x.success, y.success].filter(Boolean).length >= 1)
    check("POSITIVE CONTROL: the fake provider DOES count a second call when nothing guards it", (() => { const before = twilio.calls; twilio.send("+1", "a"); twilio.send("+1", "a"); return twilio.calls === before + 2 })())
  }

  // ══ 5 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("5 · provider 429 and provider OUTAGE — bounded backoff, then a visible exception; never a blind send")
  {
    resetAll(); const d = freshDb()
    const p = smsParams()
    await sendAndDie(d, "sms", p, false)
    twilio.rateLimited = true
    const r1 = await recover(d, later(20 * MIN))
    const row = rows(d)[0]
    check("429: backed off (next_at set), nothing sent, still 'unknown'", r1.deferred === 1 && twilio.calls === 0 && row.status === "unknown" && !!row.detail.send_recovery?.next_at, JSON.stringify(r1))
    const r1b = await recover(d, later(21 * MIN))
    check("…a pass before next_at does not touch it (the bounded backoff holds)", r1b.scanned === 0)
    let t = 20 * MIN, last: any = null
    for (let i = 0; i < rc.MAX_RECOVERY_ATTEMPTS + 1; i++) { t += 7 * HOUR; last = await recover(d, later(t)) }
    check("after MAX_RECOVERY_ATTEMPTS still rate-limited → a VISIBLE exception (self_heal_events escalated), still 'unknown', zero sends",
      row.status === "unknown" && !!row.detail.send_recovery?.exception && twilio.calls === 0 && d.tables.self_heal_events.some((e) => e.outcome === "escalated" && e.detail?.ledger_id === row.id), JSON.stringify(last))
    resetAll(); const d2 = freshDb()
    await sendAndDie(d2, "sms", smsParams(), false)
    twilio.down = true
    const r2 = await recover(d2, later(20 * MIN))
    check("OUTAGE (the status query throws): backoff, nothing sent", r2.deferred === 1 && r2.retried === 0 && twilio.calls === 0 && rows(d2)[0].status === "unknown")
  }

  // ══ 6 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("6 · relevance — the Contact REPLIED before the retry · the campaign was CANCELLED → no send")
  {
    resetAll(); const d = freshDb()
    await sendAndDie(d, "sms", smsParams(), false)
    d.tables.messages.push({ id: randomUUID(), brokerage_id: B, contact_id: CONTACT, direction: "inbound", body: "Saturday works, thanks!", created_at: new Date(Date.now() + MIN).toISOString() })
    const r = await recover(d, later(20 * MIN))
    const row = rows(d)[0]
    check("the Contact replied after the attempt → cancelled (skipped / recovery_cancelled), ZERO sends", r.cancelled === 1 && row.status === "skipped" && row.outcome === "recovery_cancelled" && /replied/.test(row.error ?? "") && twilio.calls === 0, JSON.stringify(r))
    resetAll(); const dOther = freshDb()
    await sendAndDie(dOther, "sms", smsParams(), false)
    dOther.tables.messages.push({ id: randomUUID(), brokerage_id: B2, contact_id: CONTACT, direction: "inbound", body: "other tenant", created_at: new Date(Date.now() + MIN).toISOString() })
    dOther.tables.messages.push({ id: randomUUID(), brokerage_id: B, contact_id: CONTACT2, direction: "inbound", body: "another contact", created_at: new Date(Date.now() + MIN).toISOString() })
    const ro = await recover(dOther, later(20 * MIN))
    check("POSITIVE CONTROL: another tenant's / another contact's inbound does NOT cancel — the intent is re-sent once", ro.cancelled === 0 && ro.retried === 1 && twilio.calls === 1)
    resetAll(); const d2 = freshDb()
    await sendAndDie(d2, "sms", smsParams({ ledger: { cycle: `enrollment:${ENR}:step:${STEP}` } }), false)
    d2.tables.sequence_enrollments[0].status = "cancelled"
    const r2 = await recover(d2, later(20 * MIN))
    check("the campaign enrollment was CANCELLED → the step is not re-sent", r2.cancelled === 1 && /enrollment is cancelled/.test(rows(d2)[0].error ?? "") && twilio.calls === 0, JSON.stringify(r2))
  }

  // ══ 7 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("7 · a provider with NO safe retry (SendGrid email) → exception, no duplicate; never abandoned to 'failed'")
  {
    resetAll(); const d = freshDb()
    await sendAndDie(d, "email", emailParams(), true)
    const r = await recover(d, later(20 * MIN))
    const row = rows(d)[0]
    check("SendGrid: no idempotency key, no status query → a VISIBLE exception, still 'unknown', ONE send", r.exceptions === 1 && r.retried === 0 && row.status === "unknown" && sendgrid.calls === 1 && /not re-sent/.test(row.detail.send_recovery?.exception?.why ?? ""), JSON.stringify(r))
    check("…the exception reaches the Exception Center's reader (self_heal_events escalated, naming the ledger row)", d.tables.self_heal_events.some((e) => e.outcome === "escalated" && e.subject === "send_recovery:email" && e.detail?.ledger_id === row.id))
    const r2 = await recover(d, later(5 * HOUR))
    check("…a later pass leaves an exception alone (a person owns it now)", r2.scanned === 0 && sendgrid.calls === 1)
    const settled = await rl.settleUnknownActions(B, d as never, { now: later(80 * HOUR) })
    check("…and the 72h settler does NOT abandon it to 'failed' (outcome unknown stays unknown)", row.status === "unknown" && settled.reaped === 0)
    rows(d).push({ id: randomUUID(), brokerage_id: B, status: "unknown", channel: "email", subject_type: "contact", subject_id: CONTACT, provider_ref: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), detail: {}, risk_class: "OTHER" })
    const ctl = await rl.settleUnknownActions(B, d as never, { now: later(80 * HOUR) })
    check("POSITIVE CONTROL: a row with no send intent IS still abandoned at 72h by the settler (the rule is scoped, not disabled)", ctl.reaped === 1 && rows(d).at(-1)?.status === "failed")
    const ev = rc.settleUnknownAction({ id: "x", channel: "email", subject_type: "contact", subject_id: CONTACT, provider_ref: "sg-1", created_at: new Date().toISOString(), detail: { send_intent: { v: 1 } } }, [{ id: "c", channel: "email", provider_ref: "sg-1", contact_id: CONTACT, lead_id: null, claimed_at: new Date().toISOString(), verdict: "confirmed" }], new Date())
    check("webhook evidence still settles a send intent (the evidence path is not blocked by the hold)", ev?.status === "executed" && ev.outcome === "reconciled_confirmed")
  }

  // ══ 8 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("8 · Lob — idempotent create inside its window; proof by metadata; past the window → exception")
  {
    resetAll(); const d = freshDb()
    await sendAndDie(d, "direct_mail", mailParams(), true)
    lob.listLag = true
    const r = await recover(d, later(20 * MIN))
    const row = rows(d)[0]
    check("piece created, process died, the list cannot see it yet → idempotent retry with the SAME key returns the ORIGINAL piece: ONE piece printed",
      r.retried === 1 && lob.created === 1 && row.status === "executed" && row.provider_ref === [...lob.byKey.values()][0], `${JSON.stringify(r)} created=${lob.created}`)
    resetAll(); const d2 = freshDb()
    await sendAndDie(d2, "direct_mail", mailParams(), true)
    const r2 = await recover(d2, later(20 * MIN))
    check("Lob's metadata-filtered list finds the intent's piece → recorded, no retry", r2.reconciled === 1 && r2.retried === 0 && lob.created === 1 && rows(d2)[0].outcome === "reconciled_provider_accepted")
    resetAll(); const d3 = freshDb()
    await sendAndDie(d3, "direct_mail", mailParams(), false)
    const r3 = await recover(d3, later(20 * MIN))
    check("Lob proves it never took it (empty list) → re-sent once", r3.retried === 1 && lob.created === 1 && rows(d3)[0].status === "executed")
    resetAll(); const d4 = freshDb()
    await sendAndDie(d4, "direct_mail", mailParams(), true)
    lob.listLag = true
    const r4 = await recover(d4, later(25 * HOUR))
    check("PAST Lob's 24h idempotency window and no proof → exception, nothing printed twice", r4.exceptions === 1 && r4.retried === 0 && lob.created === 1 && rows(d4)[0].status === "unknown", JSON.stringify(r4))
    // the provider's EVENT names the intent (crash after acceptance, before the claim was written)
    resetAll(); const d5 = freshDb()
    const ctx5 = await sendAndDie(d5, "direct_mail", mailParams(), true)
    const acc = await rl.acceptIntentFromProviderEvent({ intentKey: ctx5.idempotencyKey!, channel: "direct_mail", providerRef: "ltr_evt", client: d5 as never })
    check("a Lob event echoing the intent key settles the dead intent (executed, the piece id) — no recovery re-send needed", acc.moved && rows(d5)[0].status === "executed" && rows(d5)[0].provider_ref === "ltr_evt" && acc.brokerageId === B)
    const acc2 = await rl.acceptIntentFromProviderEvent({ intentKey: ctx5.idempotencyKey!, channel: "direct_mail", providerRef: "ltr_other", client: d5 as never })
    check("…a duplicate / late event never overwrites the later truth (monotonic)", !acc2.moved && rows(d5)[0].provider_ref === "ltr_evt")
  }

  // ══ 9 ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("9 · the pure ladder (decideSendRecovery) and the capability table")
  {
    const cap = rc.SEND_RECOVERY_CAPABILITIES
    const base = { relevance: { cancel: null, unreadable: null }, attempts: 1, ageHours: 1, hasReplay: true }
    check("accepted → settle, even if the person replied since (never resend a message that went)", rc.decideSendRecovery({ ...base, capability: cap.twilio_sms, probe: { kind: "accepted", providerRef: "SM1" }, relevance: { cancel: "replied", unreadable: null } }).action === "settle_accepted")
    check("proven never-accepted but NO replay envelope → exception (never a reconstructed message)", rc.decideSendRecovery({ ...base, capability: cap.twilio_sms, probe: { kind: "not_accepted" }, hasReplay: false }).action === "exception")
    check("a documented-but-UNWIRED query (Bandwidth) cannot prove anything → exception", rc.decideSendRecovery({ ...base, capability: cap.bandwidth_sms, probe: { kind: "not_accepted" } }).action === "exception")
    check("relevance unreadable → backoff, never a send (fail closed)", rc.decideSendRecovery({ ...base, capability: cap.twilio_sms, probe: { kind: "not_accepted" }, relevance: { cancel: null, unreadable: "refused" } }).action === "backoff")
    const docless = Object.entries(cap).filter(([k, v]) => k !== "unknown" && !/^https:\/\/|^lib\//.test(v.doc))
    check("every provider capability cites its documentation (no guessed capability)", docless.length === 0, docless.map(([k]) => k).join(","))
    const autoRetry = Object.entries(cap).filter(([, v]) => (v.wired && v.provesNonAcceptance) || v.idempotentCreate).map(([k]) => k).sort()
    check("ONLY Twilio SMS (proof of absence) and Lob (proof + idempotent create) may re-send automatically today", JSON.stringify(autoRetry) === JSON.stringify(["lob_direct_mail", "twilio_sms"]), autoRetry.join(","))
  }

  // ══ 10 ════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("10 · wiring — stripped source (a tombstone is not a call site)")
  {
    const disp = code("lib/providers/dispatch.ts")
    // Each dispatcher's ledger-context call, from `ledgerContextFor("comms.<c>.send"` to its `async () =>` — it must pass the intent.
    const ctxCall = (src: string, c: string) => { const at = src.indexOf(`ledgerContextFor("comms.${c}.send"`); return at < 0 ? "" : src.slice(at, src.indexOf("async () =>", at)) }
    const BUILDER: Record<string, string> = { email: "emailIntent", sms: "smsIntent", direct_mail: "mailIntent" }
    const missing = Object.entries(BUILDER).filter(([c, fn]) => !new RegExp(`\\b${fn}\\(\\s*params`).test(ctxCall(disp, c)) || !new RegExp(`function ${fn}\\([\\s\\S]{0,200}kind:\\s*"${c}"`).test(disp)).map(([c]) => c)
    check("all three dispatchers (comms.email / sms / direct_mail) persist the send intent in their ledger context", missing.length === 0, missing.join(","))
    const specimen = `return withActionLedger(ledgerContextFor("comms.sms.send", "sms", params, params.to), async () => {`
    check("POSITIVE CONTROL: the finder flags the pre-153S spelling (no intent passed)", !/\bsmsIntent\(\s*params/.test(ctxCall(specimen, "sms")) && ctxCall(specimen, "sms").length > 0)
    check("Lob: every create carries the intent key as Idempotency-Key AND in metadata (3 piece types)", /"Idempotency-Key":\s*lobKey/.test(disp) && (disp.match(/metadata:\s*lobMetadata/g) ?? []).length === 3)
    const reaper = code("lib/intelligence/reaper-net.ts")
    const ri = reaper.indexOf("recoverOutcomeUnknownSends(b"), si = reaper.indexOf("settleUnknownActions(b")
    check("mounted on the EXISTING reaper net: recovery runs before the unknown settler on the same domain run", ri > 0 && si > ri)
    const step = code("lib/campaign-sequences/step-executor.ts")
    check("step executor: an outcome-unknown dispatch is held (not advanced, not recorded failed) BEFORE the execution status is computed",
      step.indexOf("isOutcomePendingRecovery(") > 0 && step.indexOf("isOutcomePendingRecovery(") < step.indexOf("const executionStatus"))
    const bundle = code("lib/direct-mail/orchestrate-bundle-send.ts")
    check("bundle follow-ons send under their own intent (withSendIntent) and re-queue keyed stale claims", /withSendIntent\(\s*intentKey/.test(bundle) && /recovery_requeues:\s*requeues \+ 1/.test(bundle))
    const wa = code("app/api/webhooks/whatsapp/route.ts")
    const early = wa.indexOf("if (!brokerageId) {"), firstMatch = wa.indexOf('.from("contacts")')
    check("whatsapp: an unmapped business number returns BEFORE any contact match / insert (146B-SO-07)", early > 0 && early < firstMatch)
    const conditional = /if\s*\(\s*brokerageId\s*\)\s*\w+Query\s*=\s*\w+Query\.eq\(\s*"brokerage_id"/
    check("whatsapp: no CONDITIONAL tenant predicate remains", !conditional.test(wa))
    check("POSITIVE CONTROL: that pattern recognises the pre-153S conditional predicate", conditional.test(`if (brokerageId) metaQuery = metaQuery.eq("brokerage_id", brokerageId)`))
    const inbound = code("app/api/providers/inbound/route.ts")
    const authIdx = inbound.indexOf('senderAuth === "fail"'), matchIdx = inbound.indexOf('.from("contacts")')
    check("providers/inbound: a sender-auth verdict exists and an explicit FAIL is refused before any contact match (146B-SO-06)", authIdx > 0 && authIdx < matchIdx && /inboundMetaFrom\(/.test(inbound))
    const lobRoute = code("app/api/webhooks/lob-events/route.ts")
    check("lob-events: the intent echoed in metadata is settled and its tenant is the expected tenant", /acceptIntentFromProviderEvent\(/.test(lobRoute) && /expectedBrokerageId:\s*intentTenant/.test(lobRoute))
  }

  // ══ 11 ════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("11 · sender authentication fold used by providers/inbound (real lib/inbound-mail/message-meta.ts)")
  {
    const { inboundMetaFrom } = await import("../lib/inbound-mail/message-meta")
    const pass1 = inboundMetaFrom("Authentication-Results: mx.example; dmarc=pass header.from=tenant-client.test\r\n", "dana@tenant-client.test")
    const fail1 = inboundMetaFrom("Authentication-Results: mx.example; dmarc=fail header.from=tenant-client.test\r\n", "dana@tenant-client.test")
    const sg = inboundMetaFrom({}, "dana@tenant-client.test", { dkim: "{@tenant-client.test : fail}", spf: "pass" })
    const none = inboundMetaFrom({}, "dana@tenant-client.test")
    check("SendGrid-shaped headers block: dmarc=pass → pass, dmarc=fail → fail; SendGrid verdict words dkim fail → fail; no evidence → unknown",
      pass1.senderAuth === "pass" && fail1.senderAuth === "fail" && sg.senderAuth === "fail" && none.senderAuth === "unknown")
  }

  console.log(`\n[blind spots]`)
  console.log("  · the redispatch seam re-enters the REAL intent context and REAL ledger but not dispatch.ts's gate chain (consent, suppression, DNC, quiet hours, de-confliction, content safety, budget need a database); redispatchSendIntent calls the real dispatchers, which run them")
  console.log("  · providers are SIMULATED (a Twilio message log, a Lob that honours Idempotency-Key as documented) — no live provider call; the live probes' HTTP shapes are the documented ones, never exercised here")
  console.log("  · email (SendGrid / agent mailbox), Telnyx, Bandwidth, push, social, voice and voicedrop have no wired proof of non-acceptance: they reconcile by webhook evidence or become exceptions — never an automatic re-send")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(fails.map((f) => `   ✗ ${f}`).join("\n")); process.exit(1) }
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
