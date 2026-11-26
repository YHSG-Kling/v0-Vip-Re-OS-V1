/**
 * scripts/open-loop-ledger-dispositions-154k.ts — wave 154, lane 154K (directive K2: "re-derive counts, categorize … investigate
 * each remaining launch-critical item using evidence").
 *
 * The 106 launch-critical rows the ledger carried at 055167e9 were re-read against that tree (+ this lane's patch) and, for the
 * RLS / storage rows, against a READ-ONLY live read of project hrvaqgvukzxfskkcrwbt (pg_policies; storage_bucket_policy_readiness()).
 * Categories (directive K2): VERIFIED EXISTING, LEDGER STALE (`STALE`) · FIXED IN THIS LANE (`FIXED`) · NOT LAUNCH-CRITICAL BY
 * CODE EVIDENCE (`NOT_LC`, still carried — never closed) . Every closure names evidence the generator re-derives on every run
 * (`path#anchor` in STRIPPED source, `mig:` with the APPLIED stamp, `key:`), so a closure that stops being true turns
 * test:open-loop-ledger red. No row was closed on a registry entry, a matrix or a green simulator alone.
 * Spread LAST into MANUAL_DISPOSITIONS (scripts/open-loop-ledger-dispositions.ts), after 153L, so this re-evaluation wins.
 */
import type { Disposition } from "./open-loop-ledger"

const K = "wave 154 lane 154K re-evaluation at 055167e9"
const cl = (e: string[], note: string): Disposition => ({ s: "closed", e, by: `${K} — ${note}`, lc: true })
const notLc = (k: Disposition["k"], o: Disposition["o"], e: string[], r: string): Disposition => ({ s: "carried", k, o, e, r: `NOT_LC (${K}): ${r}`, lc: false })

const ONE_DOOR = "STALE — lane 148B put every contact-creating door on captureContact / captureConsentedContact (C8) with the ONE consent component (C15); test:one-door-consent §A census + §B producer census prove it on stripped source, each with a positive control"
const EMBED = "STALE — owner ruling 22 decided it (the embed gets the C15 consent component) and lane 148B built it: the embed renders ConsentBoxes and posts its submission; the door re-renders the wording server-side"
const META_HOOK = "STALE — scripts/meta-webhook-fail-closed-guard.ts (lane 148Z) RUNS the WhatsApp door: secret unset → 503 with zero reads, bad signature → 401 with zero reads, a correctly signed body verifies (positive control)"
const M874 = "STALE (live read 2026-11-18): offers_tenant_select is now offer_staff_visible(id) OR offer_contact_party_visible(id) — a contact reads only an offer it is a party to"
const M888 = "STALE (live read 2026-11-18): transaction_documents carries transaction_documents_party_select / _party_insert (document_party_on_deal) and trx_broker_transaction_documents reads document_staff_on_transaction / is_brokerage_admin() — the roster, not a typed list"
const PAYOUT = "FIXED — both payout controls refused funds_not_received telling the finance admin to STATE A REASON and offered no field to state it; the field now appears on that refusal and advanceReason reaches the kernel gate (payoutFundsGate keeps the minimum and records the reason)"
const TZ = "FIXED — the CDA reaper half closed in wave 148; the milestone calendar bridge read additional_settings.primary_timezone, which the settings resolver DEFAULTS to 'UTC', so every milestone instant was UTC. It now resolves through resolveTenantTimeZone with the reaper's precedence (global_settings.timezone, explicit setting, brokerage state)"
const GRANTS = "FIXED — resolvePacketActor read users.user_type only while is_brokerage_admin() (m602) honours a brokerage-pinned grant; the ONE grant reader (withTenantRoleGrants) now answers too, narrowed by the same oversight class; an unreadable grant list leaves the seat alone deciding"
const SIGN_ON_READ = "FIXED — a stored master (storage_path) never renders its stored pdf_url: the form library's first paint drops it (the client reloads the per-view minted link from GET /api/admin/transaction-forms) and required-documents links to the library instead"

export const WAVE154K_DISPOSITIONS: Record<string, Disposition> = {
  // ── C8 / C15 contact doors and consent (lane 148B) ─────────────────────────────────────────────────────────────────
  "147A-SO-01": cl(["key:test:one-door-consent", "lib/kernel/lead-magnets.ts#const c8 = await captureConsentedContact({", "lib/ads/ad-lead-intake.ts#const c8 = await captureConsentedContact({", "app/api/widget/intake/route.ts#const intake = await captureConsentedContact({"], ONE_DOOR),
  "147A-OL-03": cl(["key:test:one-door-consent", "app/actions/seller-open-house.ts#const resolved = await captureConsentedContact({", "lib/kernel/open-house.ts#captured = await captureContact({", "app/api/open-house/attend/route.ts#const intake = await captureConsentedContact({"], ONE_DOOR),
  "147F-OL-03": cl(["key:test:one-door-consent", "app/actions/seller-open-house.ts#const resolved = await captureConsentedContact({", "lib/kernel/open-house.ts#captured = await captureContact({"], ONE_DOOR),
  "147Z-SO-01": cl(["key:test:one-door-consent", "app/actions/seller-open-house.ts#captured = await captureContact({", "lib/kernel/open-house.ts#captured = await captureContact({", "app/actions/home-value.ts#import { captureContact, captureConsentedContact, consentGrantsFromComponent, resolveConsentBrand } from \"@/lib/contact-pipeline/contact-capture\"", "app/actions/agent-public-profile.ts#const captured = await captureConsentedContact({"], ONE_DOOR),
  "147A-SO-03": cl(["key:test:one-door-consent", "app/api/widget/intake/route.ts#consentGrantsFromComponent"], `${ONE_DOOR}; the stored words are re-rendered server-side by consentGrantsFromComponent, never supplied by a door constant`),
  "147A-SO-02": cl(["key:test:one-door-consent", "app/embed/[publicId]/embed-widget.tsx#consent: embedConsent.submission,"], EMBED),
  "147Z-OD-01": cl(["key:test:one-door-consent", "app/embed/[publicId]/embed-widget.tsx#consent: embedConsent.submission,"], EMBED),
  "147Z-OD-02": cl(["key:test:one-door-consent", "app/embed/[publicId]/embed-widget.tsx#consent: embedConsent.submission,"], EMBED),
  "147R-RP-04": cl(["key:test:one-door-consent", "app/embed/[publicId]/embed-widget.tsx#consent: embedConsent.submission,"], `${EMBED}; the other items on this line were decided by the same ruling (unknown texter kept, scraper terms kept, Mapbox first, DealMachine evaluated) and carry their own rows`),
  "147A-SO-04": cl(["lib/ads/ad-lead-intake.ts#const { fetchMetaLeadFormLegalContent } = await import(\"@/lib/ads/connectors/meta\")", "lib/ads/connectors/meta.ts#fields: \"legal_content{privacy_policy,custom_disclaimer}\""], "STALE — the ad intake now fetches the Meta lead form's legal_content and records consent only with the platform's own wording (SIMULATED: no Meta credential; the field path is marked unverified until a live read)"),
  "147A-SO-06": cl(["app/crm/contacts/[contactId]/components/persona-panel.tsx#const res = await readContactResearchAttributes({ contactId, purpose, purposeNote: justification || null })", "app/actions/contact-persona.ts#const { readProtectedAttributes } = await import(\"@/lib/enrichment/protected-research-store\")"], "STALE — lane 148C built the surface: the contact page's Persona panel reads research attributes through the purpose-gated reader (role × purpose decided in one place)"),
  // ── webhooks ─────────────────────────────────────────────────────────────────────────────────────────────────────
  "143J-SO-05": cl(["key:test:meta-webhook-fail-closed"], META_HOOK),
  "146I-OL-09": cl(["key:test:meta-webhook-fail-closed"], META_HOOK),
  // ── one arbiter ──────────────────────────────────────────────────────────────────────────────────────────────────
  "143E-SO-03": cl(
    ["app/actions/ai-isa/engage-contact.ts#const { plan, decision, recorded: rec } = await arbitrateAndRecordExperience(supabase, {", "app/api/cron/stale-contact-monitor/route.ts#import { initiateAIISAContactEngagement } from '@/app/actions/ai-isa/initiate-contact-engagement'", "lib/ai-isa/ghost-escalation.ts#const { arbitratePlannedTouch } = await import(\"./followup-arbiter\")", "lib/ai-isa/saved-home-nudge.ts#const r = await arbitratePlannedTouch(svc, {", "lib/ai-isa/lead-nurture.ts#const arb = await arbitratePlannedTouch(supabase as never, {"],
    "STALE — lane 149C (C29) put the planner entry points on the follow-up arbiter: engageContact (next-best-touch's caller, reached by the stale-contact cron) arbitrates and records; ghost-escalation, saved-home-nudge and lead-nurture call arbitratePlannedTouch; adaptive re-engagement offers its angles to the arbiter. Speed-to-lead stays time-critical by design",
  ),
  "146D-OL-06": cl(["lib/contact-promotion/conversion-welcome.ts#const { readAccessibilityPreferences, accessibilityAdaptations } = await import(\"@/lib/contacts/accessibility-preferences\")", "key:test:one-door-consent"], "STALE — a different survivor: the welcome reads the ONE C3 accessibility reader (the same field customer360For exposes), and its send is consent-gated at the sender (every sender reads checkSuppression — test:one-door-consent §E)"),
  // ── RLS (live read-back) ─────────────────────────────────────────────────────────────────────────────────────────
  "145A-SO-05": cl(["mig:m874"], M874),
  "146A-SO-03": cl(["mig:m888"], M888),
  "146A-OL-05": cl(["mig:m888"], M888),
  "146A-SO-04": cl(["mig:m888", "mig:m874"], M888),
  "146A-OL-06": cl(["mig:m888", "mig:m874"], M888),
  // ── fixed in this lane ───────────────────────────────────────────────────────────────────────────────────────────
  "143C-OL-04": cl(["app/components/features/financial/PayoutButton.tsx#advanceReason: advanceReason.trim() || null,", "app/components/features/financial/CommissionPaymentStateCell.tsx#advanceReason: advanceReason.trim() || null", "key:test:product-surface-audit"], PAYOUT),
  "143H-OL-02": cl(["lib/transactions/cda-delivery-reaper.ts#const tz = resolveTenantTimeZone({ state: b?.state, explicitZone:", "lib/kernel/milestone-calendar-bridge.ts#explicitZone: columnZone ?? jsonZone,", "key:test:product-surface-audit"], TZ),
  "145A-SO-06": cl(["lib/forms/tenant-form-packets.ts#const granted = await withTenantRoleGrants(svc,", "key:test:product-surface-audit"], GRANTS),
  "146I-OL-05": cl(["lib/forms/tenant-form-packets.ts#const granted = await withTenantRoleGrants(svc,", "key:test:product-surface-audit"], GRANTS),
  "145A-OL-05": cl(["app/dashboard/settings/required-documents/page.tsx#{form.storage_path ? (", "app/dashboard/admin/transaction-forms/page.tsx#(f.storage_path ? { ...f, pdf_url: null } : f)", "key:test:product-surface-audit"], SIGN_ON_READ),
  "146I-OL-06": cl(["app/dashboard/settings/required-documents/page.tsx#{form.storage_path ? (", "app/dashboard/admin/transaction-forms/page.tsx#(f.storage_path ? { ...f, pdf_url: null } : f)", "key:test:product-surface-audit"], SIGN_ON_READ),
  // ── still carried, re-classified NOT launch-critical on code evidence (the item stays OPEN) ──────────────────────
  "143D-SO-05": notLc("missing-code", "integrator", ["lib/kernel/lookalike-audience.ts#is_active: false"], "a re-staged keyword lands INACTIVE (is_active: false) and nothing scrapes until a human enables it — a nag, never a send or a pull. The suppression marker belongs in lib/kernel/lookalike-audience.ts (lane 154G1's file in wave 154) — Outside-lane request in lane 154K's notes."),
  "143D-SO-07": notLc("deferred", "integrator", ["app/api/cron/lookalike-audience/route.ts#agg.deferred_tenants = tenants.length - i"], "the weekly research cron stops at its time budget and records the deferred tenants instead of dying mid-tenant; per-tenant dispatch is a scale step, not a launch blocker."),
  "144C-SO-02": notLc("deferred", "integrator", ["lib/transactions/transaction-creation-gate.ts#import { governingOfferPacket, type GoverningOfferPacket } from \"@/lib/offers/governing-terms\"", "lib/offers/governing-terms.ts#const seq = acceptedOfferSequence(chain.rows, offerId)"], "the creation gate reads the WHOLE accepted sequence (root → each counter → head) at document level; a field-level walk on an ancestor would stamp flags no gate reads — the row's own text says so."),
  "144E-SO-04": notLc("owner-decision", "counsel", ["lib/enrichment/protected-research-store.ts#export async function readProtectedAttributes("], "a SELF-IDENTIFIED protected-class collection surface does not exist, so nothing is collected — the fail-safe direction. Consent text, retention and the collection surface wait on owner + counsel; research reads are already purpose-gated."),
}
