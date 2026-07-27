// scripts/crm-pull-simulator.ts   (npm run test:crm-pull)
// ─────────────────────────────────────────────────────────────────────────────
// CRM PULL IMPORT + OPEN-HOUSE FOLLOW-UP — proves the migration path keeps the
// owner's gate: pure vendor→row mappers emit ONLY CSV-alias keys (so the field
// steward, not the mapper, decides what lands), consent is never fabricated,
// the pull feeds the ONE pipeline, and the post-event cron closes the
// open-house loop.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fubToRow, hubspotToRow, loftyToRow, ghlToRow, CRM_IMPORT_PROVIDERS } from "../lib/crm/import-pull"
import { planTokenAction, RENEWAL_WINDOW_DAYS } from "../lib/social/token-refresh"
import { detectPortal, parsePortalLeadEmail } from "../lib/lead-pipeline/portal-lead-intake"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── PURE: vendor → CSV-shaped rows (the gate decides, not the mapper) ──")
{
  const fub = fubToRow({
    firstName: "Dana", lastName: "K", emails: [{ value: "d@x.com" }], phones: [{ value: "+15551234567" }],
    addresses: [{ street: "1 Main", city: "Austin", state: "TX", code: "78701" }],
    stage: "Buyer", source: "Zillow", tags: ["hot", "sphere"],
  })
  check("FUB: identity/address land under CSV-alias keys",
    fub["First Name"] === "Dana" && fub.Email === "d@x.com" && fub.Phone === "+15551234567" && fub.City === "Austin")
  check("FUB: vendor context keeps VENDOR keys (→ notes via the steward, never contact columns)",
    "FUB Source" in fub && "FUB Tags" in fub && fub["FUB Tags"] === "hot, sphere")
  check("FUB: stage maps to the gated enum key 'Type' (Data-Steward-normalized, not trusted)", fub.Type === "Buyer")

  const hs = hubspotToRow({ properties: { firstname: "A", lastname: "B", email: "a@b.com", phone: null, mobilephone: "+15550000000", zip: "78702", lifecyclestage: "lead" } })
  check("HubSpot: mobile fallback + zip + lifecycle→Type", hs.Phone === "+15550000000" && hs.Zip === "78702" && hs.Type === "lead")

  const lofty = loftyToRow({ first_name: "C", last_name: "D", emails: ["c@d.com"], phones: ["+15551111111"], zipCode: "78703", stage: "Nurture", tags: ["past client"] })
  check("Lofty: snake/array fallbacks + stage stays vendor-keyed", lofty.Email === "c@d.com" && lofty.Zip === "78703" && lofty["Lofty Stage"] === "Nurture")

  const ghl = ghlToRow({ firstName: "E", lastName: "F", email: "e@f.com", phone: "+15552222222", postalCode: "78704", tags: ["seller"] })
  check("GHL: postalCode→Zip + tags vendor-keyed", ghl.Zip === "78704" && ghl["GHL Tags"] === "seller")

  const allRows = [fub, hs, lofty, ghl]
  check("NO mapper ever emits a consent field (consent is earned on OUR rail, never imported)",
    allRows.every((r) => !Object.keys(r).some((k) => /consent|tcpa|opt[_ ]?in/i.test(k))))
  check("four providers registered", CRM_IMPORT_PROVIDERS.length === 4)
}

console.log("\n── PURE: social token lifecycle (the audit's worst gap) ──")
{
  const now = new Date("2026-07-07T12:00:00Z")
  const base = { id: "1", brokerage_id: "b", user_id: "u", account_name: "x", access_token: "tok", refresh_token: null, is_active: true }
  const soon = new Date(now.getTime() + (RENEWAL_WINDOW_DAYS - 1) * 86_400_000).toISOString()
  const far = new Date(now.getTime() + 40 * 86_400_000).toISOString()
  check("meta token in the renewal window → exchange", planTokenAction({ ...base, platform: "facebook", token_expires_at: soon }, now) === "exchange_meta")
  check("linkedin WITH refresh token → refresh; WITHOUT → honest reconnect nudge",
    planTokenAction({ ...base, platform: "linkedin", refresh_token: "r", token_expires_at: soon }, now) === "refresh_linkedin" &&
    planTokenAction({ ...base, platform: "linkedin", token_expires_at: soon }, now) === "notify_reconnect")
  check("far-out expiry → healthy; inactive/no-token → skip",
    planTokenAction({ ...base, platform: "facebook", token_expires_at: far }, now) === "healthy" &&
    planTokenAction({ ...base, platform: "facebook", token_expires_at: soon, is_active: false }, now) === "skip")
  check("no expiry recorded (page tokens) → healthy, never a false alarm",
    planTokenAction({ ...base, platform: "facebook", token_expires_at: null }, now) === "healthy")
}

console.log("\n── PURE: portal lead intake (Zillow / realtor.com / Opcity) ──")
{
  check("portal detection: zillow/realtor/opcity senders recognized; others null",
    detectPortal("noreply@convo.zillow.com") === "zillow" &&
    detectPortal("leads@leads.realtor.com") === "realtor_com" &&
    detectPortal("referral@opcity.com") === "opcity" &&
    detectPortal("someone@gmail.com") === null && detectPortal(null) === null)
  const parsed = parsePortalLeadEmail({
    fromEmail: "notifications@convo.zillow.com",
    subject: "Dana Kling is requesting information about 12 Oak St, Austin, TX",
    bodyText: "Name: Dana Kling\nPhone: (512) 555-1234\nEmail: dana@example.com\nMessage: Is it still available? I'm pre-approved.",
  })
  check("full parse: name split + email/phone + property + message",
    parsed?.portal === "zillow" && parsed?.firstName === "Dana" && parsed?.lastName === "Kling" &&
    parsed?.email === "dana@example.com" && !!parsed?.phone && (parsed?.propertyAddress ?? "").includes("12 Oak St"))
  check("portal's own address never mistaken for the lead's email",
    parsePortalLeadEmail({ fromEmail: "n@zillow.com", subject: "Pat Doe is interested in 5 Elm Ave", bodyText: "Reply to notifications@convo.zillow.com\nPhone: 512-555-9999" })?.email === null)
  check("recognized sender with NO name and NO contact info → null (no fabricated leads)",
    parsePortalLeadEmail({ fromEmail: "digest@zillow.com", subject: "Your weekly market report", bodyText: "Homes in your area..." }) === null)
  check("non-portal sender → null regardless of content",
    parsePortalLeadEmail({ fromEmail: "friend@gmail.com", subject: "Dana Kling is requesting information", bodyText: "Phone: 512-555-1111" }) === null)
}

console.log("\n── SOURCE: tenant connections hub ──")
{
  const intake = src("lib/lead-pipeline/portal-lead-intake.ts")
  check("portal lead = a CONTACT for the RECEIVING AGENT via the gated captureContact (owner's rule — never a raw lead)",
    intake.includes("captureContact") && intake.includes("receivingAgentUserId") && !intake.includes("raw_scraped_leads"))
  check("TCPA provenance recorded, never silent (portal + property in consent source/text)",
    intake.includes("portal_inquiry:") && intake.includes("tcpa_consent_text"))
  check("the receiving agent gets a high-priority heads-up", intake.includes("portal_lead_received"))
  const webhook = src("app/api/webhooks/inbound-mail/route.ts")
  check("hooked into inbound-mail BEFORE the known-contact gate + assigns the MAILBOX OWNER as the agent",
    webhook.includes("parsePortalLeadEmail") &&
    webhook.indexOf("parsePortalLeadEmail") < webhook.indexOf("if (!contactId || !brokerageId)") &&
    webhook.includes("resolvedCredential?.agent_user_id"))
  const slots = src("lib/settings/tenant-connection-slots.ts")
  check("tenant slots: listhub + mls_direct + showingtime + honest ShowingTime note",
    slots.includes('"listhub"') && slots.includes('"mls_direct"') && slots.includes('"showingtime"') && slots.includes("verifies partner access"))
  check("connection save is brokerage-admin gated", src("app/actions/tenant-connections.ts").includes("requireAdmin"))
  const page = src("app/dashboard/settings/integrations/lead-sources/lead-sources-client.tsx")
  check("settings page: forwarding instructions + last-30d proof counts per portal",
    page.includes("auto-forward") && page.includes("last 30 days"))
  const matrix = src("lib/providers/tenancy-matrix.ts")
  check("strategy recorded: Twilio convergence (ConversationRelay/Conversations/Voice Intelligence/fraud) + Vapi RETIRED + zyte backup + sinch/plivo/plaid/buffer dropped",
    matrix.includes("ConversationRelay") && matrix.includes("RETIRED voice lane") && matrix.includes("BACKUP scraper lane") && matrix.includes("DROPPED by owner decision"))
  check("registry burn domain tenant_connections_hub", "tenant_connections_hub" in MAINTENANCE_DOMAINS)
}

console.log("\n── SOURCE: vendor-audit fixes ──")
{
  const sync = src("lib/platform-sync.ts")
  check("syndication NEVER fabricates success (all three placeholder-URL points removed)",
    !sync.includes("listing/pending-") && !sync.includes("listing/manual-") && !sync.includes("listing/queued-") &&
    sync.includes("no fake URL"))
  const oauth = src("app/api/integrations/oauth/[provider]/route.ts")
  check("DocuSign OAuth defaults to the PRODUCTION host (demo via env override)",
    oauth.includes('DOCUSIGN_OAUTH_HOST || "account.docusign.com"'))
  const sweepCron = src("app/api/cron/credential-refresh/route.ts")
  check("daily credential-refresh cron runs BOTH sweeps (the registry's flagged follow-up, closed)",
    sweepCron.includes("runCredentialRefresh") && sweepCron.includes("runSocialTokenSweep"))
  check("cron registered", src("lib/kernel/cron-dispatch.ts").includes("credential-refresh"))
  const tokenLib = src("lib/social/token-refresh.ts")
  check("meta exchange + linkedin refresh via the connector gateway; reconnect nudges deduped weekly",
    tokenLib.includes("fb_exchange_token") && tokenLib.includes('grant_type: "refresh_token"') && tokenLib.includes("7 * 86_400_000"))
  check("registry burn domain vendor_connection_audit", "vendor_connection_audit" in MAINTENANCE_DOMAINS)
}

console.log("\n── SOURCE: one pipeline, gated end to end ──")
{
  const pull = src("lib/crm/import-pull.ts")
  check("all vendor egress via the connector gateway (no bespoke fetch)", pull.includes("callConnector") && !/\bfetch\(/.test(pull))
  check("cursor-resumable pages (honest 'more remain')", pull.includes("nextCursor"))
  const actions = src("app/actions/lead-import/crm-pull-actions.ts")
  check("the pull feeds importParsedContacts — the SAME gated pipeline as the CSV white-glove import",
    actions.includes("parseContactRecords(page.rows)") && actions.includes("importParsedContacts({"))
  check("per-run cap with resumable cursor reported honestly", actions.includes("MAX_PAGES_PER_RUN") && actions.includes("nextCursor: cursor"))
  check("tenant-keyed credentials (platform_credentials, scoped to the TARGET brokerage)",
    actions.includes('.eq("brokerage_id", input.brokerageId)') && actions.includes("platform_credentials"))
  check("pulling is a PLATFORM-STAFF operation on an explicit target tenant (not a tenant self-serve button)",
    actions.includes('gateStaffAction("tenants")') && actions.includes("auditStaffAction") && actions.includes("brokerageId: string"))
  // An all-invalid page must NOT abort the run: those rows are already counted in
  // `failed`, and breaking here strands the cursor on the same page forever.
  check("an all-invalid page keeps paginating; only errors raised WITH importable rows are fatal",
    /if \(!r\.ok && r\.error && parsed\.rows\.length > 0\)/.test(actions))
  const panel = src("app/dashboard/superadmin/brokerages/[id]/tenant-crm-pull-panel.tsx")
  check("superadmin tenant panel hosts the pull with the gate explained to the operator",
    panel.includes("same safeguards") && panel.includes("consent is never imported as opted-in"))
  check("panel mounted on the superadmin brokerage page",
    src("app/dashboard/superadmin/brokerages/[id]/page.tsx").includes("<TenantCrmPullPanel brokerageId={brokerage.id} />"))

  const cron = src("app/api/cron/open-house-followup/route.ts")
  check("open-house post-event cron: 1–25h window + completed-flip idempotency", cron.includes("25 * 3_600_000") && cron.includes("processEventFollowups"))
  check("processEventFollowups gained the client seam (cron service-side, UI unchanged)",
    src("app/actions/open-house-automation.ts").includes("client ?? await createClient()"))
  check("cron registered", src("lib/kernel/cron-dispatch.ts").includes("open-house-followup"))

  for (const key of ["crm_pull_import", "open_house_followup"]) {
    check(`registry burn domain ${key}`, key in MAINTENANCE_DOMAINS)
  }
  check("matrix truth: AVM cascade VERIFIED LIVE (stale stub-claim header corrected after verification)",
    src("lib/providers/tenancy-matrix.ts").includes("VERIFIED LIVE") &&
    src("lib/avm/provider-chain.ts").includes("STATUS (verified): the adapters are LIVE"))
  check("AVM adapters call the REAL clients (rentcast/batchdata/zenrows via connector gateway)",
    src("lib/avm/provider-chain.ts").includes("getRentcastAVM") &&
    src("lib/property/rentcast.ts").includes('connector: "rentcast"') &&
    src("lib/external/zenrows-client.ts").includes('connector: "zenrows"'))
  check("package.json wires the proof", /"test:crm-pull":/.test(src("package.json")))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ CRM_PULL_FAIL"); process.exit(1) }
console.log(" ✅ CRM_PULL_PASS — migrate a competitor's database through OUR gate; open-house loop closes itself")
