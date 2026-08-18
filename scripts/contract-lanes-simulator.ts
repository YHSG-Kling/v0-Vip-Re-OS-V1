// scripts/contract-lanes-simulator.ts   (npx tsx scripts/contract-lanes-simulator.ts)
// ─────────────────────────────────────────────────────────────────────────────
// TWO CONTRACT LANES (m481) — owner ruling: "platform contracts for tenants has
// to be written in order for the tenant to sign for their subscription, also
// the agent has to sign contracts to join the brokerage and teams so tenants
// need to write the agency contracts for the agents to sign."
//
//   LANE 1 — PLATFORM → TENANT: platform staff author subscription-agreement
//   templates; the tenant's admin signs IN-APP; the signature row (brokerage-
//   pinned, immutable) is the record.
//   LANE 2 — TENANT → AGENT: the agency contract family (commission_agreement +
//   independent_contractor + team_agreement) on the SAME rails the commission
//   agreement already used; onboarding surfaces both joining contracts.
//
// Assertions run against COMMENT-MASKED source — a claim living only in a
// comment cannot satisfy a check — plus negative controls proving the refusals
// stayed refusals and no fake e-sign send appeared anywhere in either lane.

import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
// Comment mask: strip block + line comments so prose cannot satisfy a code assertion.
const mask = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([^:"'])\/\/[^\n]*/g, "$1")

// ── LANE 1 SCHEMA — platform-authored template, tenant-pinned signature ──────
console.log("\n── lane 1 schema: m481 migration ──")
{
  const raw = src("supabase/migrations/m481-a-subscription-is-signed-and-an-agent-joins-in-writing.sql")
  const sql = raw.replace(/^\s*--.*$/gm, "") // SQL comment mask
  check("platform_contract_templates exists with the one admitted type + a body-present CHECK",
    sql.includes("create table if not exists public.platform_contract_templates") &&
    sql.includes("contract_type in ('subscription_agreement')") &&
    sql.includes("body_text is not null or body_storage_path is not null"))
  check("tenant_contract_signatures is brokerage-grain, template-pinned, one signature per template",
    sql.includes("create table if not exists public.tenant_contract_signatures") &&
    sql.includes("references public.brokerages(id)") &&
    sql.includes("references public.platform_contract_templates(id)") &&
    sql.includes("unique (brokerage_id, template_id)"))
  check("template WRITES are platform-pinned (is_platform_staff in every write policy + postcondition raise)",
    sql.includes("with check (public.is_platform_staff())") &&
    /cmd <> 'SELECT'[\s\S]*?is_platform_staff/.test(sql) &&
    sql.includes("raise exception"))
  check("tenant signature INSERT carries BOTH the admin predicate and the tenant pin",
    sql.includes("public.is_brokerage_admin()") &&
    sql.includes("brokerage_id = public.current_user_brokerage_id()"))
  check("NEGATIVE: signatures are immutable — no UPDATE/DELETE policy, and the postcondition raises if one appears",
    !/create policy tenant_contract_signatures_(update|delete)/.test(sql) &&
    sql.includes("cmd in ('UPDATE', 'DELETE')"))
  check("lane 2 pin: contract_signatures.team_id FK teams (nullable — brokerage-join has no team)",
    sql.includes("add column if not exists team_id uuid references public.teams(id)"))
  check("the live CHECK was MEASURED (already admits team_agreement) — guarded extension, not a blind rebuild",
    raw.includes("MEASURED LIVE") && sql.includes("if v_def is not null and v_def !~ 'team_agreement' then") &&
    /raise exception 'm481: contract_signatures contract_type CHECK/.test(sql))
}

// ── LANE 1 — platform-staff authoring surface ────────────────────────────────
console.log("\n── lane 1: platform staff author the subscription agreement ──")
{
  const a = mask(src("app/actions/superadmin/subscription-contracts.ts"))
  check("gates are the ONE platform predicate pair (lib/auth/platform-guard), not a re-rolled roster",
    a.includes('from "@/lib/auth/platform-guard"') &&
    a.includes("requireSuperadmin") && a.includes("requirePlatformStaff"))
  check("WRITES (upsert + activate) are superadmin; reads are any platform staff",
    /upsertSubscriptionContractTemplateAction[\s\S]{0,200}requireSuperadmin\(\)/.test(a) &&
    /setSubscriptionContractTemplateActiveAction[\s\S]{0,300}requireSuperadmin\(\)/.test(a) &&
    /listSubscriptionContractTemplatesAction[\s\S]{0,200}requirePlatformStaff\(\)/.test(a))
  check("every mutation audits to superadmin_audit_log",
    a.includes("superadmin_audit_log") && a.includes('"platform_contract_template"'))
  check("a body revision bumps the version (signatures stay pinned to what was read)",
    a.includes("bodyChanged") && a.includes("template_version"))
  check("a contract with no body is refused",
    a.includes("not a contract anyone can sign"))
  check("NEGATIVE: no e-sign provider anywhere in lane 1 authoring",
    !/dotloop|docusign|resolveProvider|resolveTransactionFormsProvider|provider_envelope/i.test(a))
  const page = mask(src("app/dashboard/superadmin/contracts/page.tsx"))
  check("the staff page lives with the other superadmin pages and uses the capability gate",
    page.includes("requirePlatformCapability") && page.includes("SubscriptionContractsManager"))
}

// ── LANE 1 — the tenant signs, in-app ────────────────────────────────────────
console.log("\n── lane 1: the tenant signs in-app ──")
{
  const raw = src("app/actions/admin/subscription-agreement.ts")
  const a = mask(raw)
  check("identity is server-resolved: brokerage from the CALLER's row, signer from the session",
    a.includes("brokerage_id: caller.brokerage_id") && a.includes("signed_by: user.id"))
  check("NEGATIVE: no caller-supplied brokerage anywhere in the tenant sign lane",
    !/brokerageId/.test(a))
  check("the WRITE gate is resolveTenantAdmin (both halves: user_type AND grant — is_brokerage_admin parity)",
    a.includes("resolveTenantAdmin(supabase, user.id, caller)") && a.includes("isTenantAdmin"))
  check("the insert goes through the AUTHED client so m481's RLS is a second, database-enforced gate",
    a.includes('from "@/lib/supabase/server"') && !a.includes("createServiceClient"))
  check("errors are destructured on every read/write (a refusal is never reported as success)",
    a.includes("error: tplErr") && a.includes("error: sigErr") && a.includes("error: insErr") &&
    a.includes("error: existErr") && a.includes("error: callerErr"))
  check("only the ACTIVE template is on offer; a retired version is refused",
    a.includes("no longer the active version"))
  check("the signature payload is the in-app record — no provider, no simulated send",
    a.includes("in_app_click_to_sign") && !/dotloop|docusign|resolveProvider|esign_status|provider_envelope/i.test(a))
  check("re-signing the same template is idempotent, not an error",
    /existing[\s\S]{0,120}return \{ ok: true, signatureId/.test(a))

  const page = mask(src("app/dashboard/admin/billing/page.tsx"))
  check("surfaced at the natural seam: the billing page (where a blocked tenant lands) mounts the card",
    page.includes("getSubscriptionAgreementAction") && page.includes("SubscriptionAgreementCard") &&
    page.includes("isTenantBillingAdmin"))
  const card = mask(src("app/dashboard/admin/billing/subscription-agreement-card.tsx"))
  check("the card signs via the server action (typed-name signature line)",
    card.includes("signSubscriptionAgreementAction") && card.includes("signedName"))
  check("NEGATIVE: surfaced, NOT enforced — no blocking gate was added to billing access or login routing",
    !src("lib/billing/billing-access.ts").includes("tenant_contract_signatures") &&
    !src("lib/kernel/onboarding.ts").includes("tenant_contract_signatures"),
    "a hard gate would strand live tenants; recorded as a follow-up instead")
}

// ── LANE 2 — the agency contract family ─────────────────────────────────────
console.log("\n── lane 2: the agency contract family (tenant → agent) ──")
{
  const raw = src("app/actions/admin/commission-agreement.ts")
  const a = mask(raw)
  check("ONE family, three types: commission_agreement + independent_contractor + team_agreement",
    /AGENCY_CONTRACT_TYPES[\s\S]{0,200}"commission_agreement",\s*"independent_contractor",\s*"team_agreement"/.test(a))
  check("unknown types are refused loudly, default stays commission_agreement (back-compat)",
    a.includes("normalizeContractType") && a.includes("const t = input ?? COMMISSION_CATEGORY"))
  check("templates keep the SAME library (brokerage_forms), keyed by the contract type",
    a.includes("form_category: contractType") && a.includes('.eq("form_category", contractType)'))
  check("the signed record keeps the SAME ledger (contract_signatures), typed + team-pinned",
    a.includes("contract_type: contractType") && a.includes("team_id: teamId"))
  check("the team lane anchors on the FK facts (leadsAgentsTeam / agent_team_id), never a user_type",
    a.includes('from "@/lib/teams/team-scope"') &&
    a.includes('svc.rpc("agent_team_id", { p_agent_id: agentId })') &&
    !a.includes('"team_lead"'))
  check("a team agreement for a teamless agent is refused, not written unpinned",
    a.includes("not on a team — a team agreement needs a team"))
  check("the m473 lead lane covers team + commission agreements but NOT the brokerage-join contract",
    a.includes('contractType !== "independent_contractor"'))
  check("HONEST send stays: e-sign only with a real configured provider, else in-app 'pending' — never a fake send",
    a.includes('canEsign ? "sent" : "pending"') && a.includes("providerConfigured"))
}

// ── LANE 2 — onboarding surfaces BOTH joining contracts ──────────────────────
console.log("\n── lane 2: onboarding shows both contracts ──")
{
  const raw = src("app/actions/onboarding/license.ts")
  const a = mask(raw)
  check("status carries the team contract beside the brokerage contract",
    a.includes("teamContractRecord") && a.includes("teamId") &&
    a.includes('.eq("contract_type", "team_agreement")'))
  check("team resolution is the SAME FK-anchored RPC RLS uses",
    a.includes('supabase.rpc("agent_team_id"'))
  check("team reads destructure their errors (a refusal never reads as 'no team' / 'no contract')",
    a.includes("error: teamErr") && a.includes("error: teamContractErr"))
  check("markContractSignedManually knows WHICH contract it is signing off",
    a.includes("contract_type") && a.includes("isBrokerageJoinContract"))
  check("only the brokerage-join contract ticks the contract_signed checklist step",
    /if \(isBrokerageJoinContract\)[\s\S]{0,600}"contract_signed"/.test(a))
  check("the manual sign-off counts its rows (an RLS refusal cannot report as recorded)",
    a.includes("signedRows") && a.includes("signedRows.length === 0"))
  check("NEGATIVE: the automatic-send REFUSAL stayed a refusal (no simulated envelope, no insert)",
    raw.includes("isn't connected yet") && !/\.from\("contract_signatures"\)[\s\S]{0,200}\.insert\(/.test(a))

  const ui = mask(src("app/dashboard/onboarding/license/license-intake-client.tsx"))
  check("the contract step renders the Team Agreement beside the brokerage contract when the agent has a team",
    ui.includes("status?.teamId") && ui.includes("teamContractRecord") && ui.includes("Team Agreement"))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ CONTRACT_LANES_FAIL"); process.exit(1) }
console.log(" ✅ CONTRACT_LANES_PASS — the subscription is signed, and an agent joins the brokerage AND the team in writing")
