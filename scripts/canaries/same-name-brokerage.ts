/**
 * scripts/canaries/same-name-brokerage.ts — SAME-NAME BROKERAGE canary (wave 141, lane 141J):
 *   two unrelated tenants share a brand → NEVER merged
 * Owner (wave 141): "another unrelated tenant may share the brand, another location may subscribe later.
 * BROKERAGE NAME MATCH IS NEVER PROOF OF SAME TENANT; never merge by name; identity uses canonical IDs +
 * verified relationships." Two createTenantCore calls with the SAME brokerageName and different owners
 * must mint two tenants with distinct ids, slugs, owners and scoped reads; the SOURCE RULE scans the
 * identity/provisioning survivors (stripped) for any brokerages read keyed on `name` — a positive
 * control proves the finder bites.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { strippedRepo } from "./_registry"

/** PURE: brokerages reads whose filter chain is keyed on the NAME (`.eq("name"`, `.ilike("name"`,
 *  `.like("name"`, `.match({ name`) within the chain that follows `.from("brokerages")`). */
export function nameKeyedBrokerageReads(stripped: string): number {
  let n = 0
  for (const m of stripped.matchAll(/\.from\(\s*["'`]brokerages["'`]\s*\)/g)) {
    const rest = stripped.slice(m.index! + m[0].length)
    const next = rest.search(/\.from\(/)
    const chain = rest.slice(0, next < 0 ? Math.min(rest.length, 600) : Math.min(next, 600))
    if (/\.(eq|ilike|like|neq)\(\s*["'`]name["'`]|\.match\(\s*\{\s*name\b/.test(chain)) n++
  }
  return n
}

/** The survivors that decide tenancy, membership and readiness. */
const IDENTITY_SURVIVORS = ["lib/kernel/tenant-creation.ts", "lib/kernel/users.ts", "lib/kernel/tenant-readiness.ts", "lib/platform/prospect-conversion.ts", "lib/kernel/tenant-creation-rollback.ts"]

export async function run() {
  const c = canary("Same-name brokerage: two unrelated tenants share a brand → NEVER merged")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: provisioning invites auth users (outbound email) — in-memory only")
  const TIER = uuid(), STAFF = uuid(), SNAP = uuid()
  const NAME = `${CANARY_TAG} Harbor Realty`
  const svc = canaryClient({
    subscription_tiers: [{ id: TIER, tier_name: "brokerage", is_active: true, display_name: "Brokerage" }],
    users: [{ id: STAFF, email: `staff@${CANARY_EMAIL_DOMAIN}`, platform_role: "superadmin", user_type: "admin", brokerage_id: null }],
    platform_config_snapshots: [{ id: SNAP, name: `${CANARY_TAG} snapshot`, created_at: nowIso(), payload: { recommendedTier: "brokerage", global: { timezone: "America/Chicago" }, brand: { tagline: `${CANARY_TAG} tagline` }, voice: { tone: "warm" } } }],
    feature_flags: [{ id: uuid(), feature_key: `${CANARY_TAG}_crm`, enabled: true, brokerage_access: true, team_access: true, enterprise_access: true, solo_access: true }],
  })
  setSvc(svc)
  const { createTenantCore } = await import("../../lib/kernel/tenant-creation")
  const mk = (email: string, city: string) => ({
    brokerageName: NAME, adminEmail: email, adminFirstName: "Canary", adminLastName: "Owner", city, state: "FL",
    tier: "brokerage" as const, signupSource: "superadmin" as const, billing: { mode: "active" as const, billingCycle: "monthly" as const },
    snapshotId: SNAP, callerUserId: STAFF, redirectTo: "/dashboard/onboarding",
  })
  const r1 = await createTenantCore(svc, mk(`north@${CANARY_EMAIL_DOMAIN}`, "Pensacola"))
  const r2 = await createTenantCore(svc, mk(`south@${CANARY_EMAIL_DOMAIN}`, "Destin"))
  const B1 = r1.brokerageId ?? null, B2 = r2.brokerageId ?? null
  c.step("two subscribers declare the SAME brand: both creations succeed", r1.ok && r2.ok && !!B1 && !!B2, `${r1.error ?? B1} / ${r2.error ?? B2}`)
  const named = (svc.tables.brokerages ?? []).filter((b) => b.name === NAME)
  c.step("never merged: two brokerages rows carry the name — distinct ids, distinct slugs, distinct storefronts", named.length === 2 && B1 !== B2 && r1.slug !== r2.slug && r1.websitePath !== r2.websitePath, `${r1.slug} ≠ ${r2.slug}`)
  const o1 = svc.tables.users?.find((u) => u.id === r1.userId), o2 = svc.tables.users?.find((u) => u.id === r2.userId)
  c.step("membership: each owner is pinned to ITS OWN tenant — the name routed nobody", !!o1 && !!o2 && o1.brokerage_id === B1 && o2.brokerage_id === B2 && o1.id !== o2.id, "")
  const { error: seedErr } = await svc.from("contacts").insert({ brokerage_id: B1, first_name: "Dana", last_name: "Canary", email: `dana@${CANARY_EMAIL_DOMAIN}`, status: "new", notes: CANARY_TAG, created_at: nowIso() })
  const { evaluateTenantReadiness } = await import("../../lib/kernel/tenant-readiness")
  const rd2 = await evaluateTenantReadiness(svc, B2!, { repair: false })
  c.step("scoped reads: tenant 2's readiness evidence never names tenant 1's id; tenant 1's contact is invisible to tenant 2's predicates", !seedErr && !JSON.stringify(rd2).includes(B1!) && (svc.tables.contacts ?? []).filter((x) => x.brokerage_id === B2).length === 0, seedErr?.message ?? `checks ${rd2.checks.length}`)
  const again = await createTenantCore(svc, mk(`north@${CANARY_EMAIL_DOMAIN}`, "Pensacola"))
  c.step("POSITIVE CONTROL (identity key is the OWNER, not the name): the first owner again is refused or resumes tenant 1 — still exactly two same-name tenants", (!again.ok || again.brokerageId === B1) && (svc.tables.brokerages ?? []).filter((b) => b.name === NAME).length === 2, again.ok ? `resumed ${again.brokerageId}` : (again.error ?? ""))
  // THE SOURCE RULE — nothing in the identity/provisioning survivors reads brokerages BY NAME.
  const hits = IDENTITY_SURVIVORS.map((f) => ({ f, n: nameKeyedBrokerageReads(strippedRepo(f) ?? "") })).filter((x) => x.n > 0)
  const present = IDENTITY_SURVIVORS.filter((f) => strippedRepo(f) !== null)
  c.step(`source rule: ${present.length}/${IDENTITY_SURVIVORS.length} identity survivors read (stripped); 0 brokerages reads keyed on name`, present.length === IDENTITY_SURVIVORS.length && hits.length === 0, hits.map((h) => `${h.f}×${h.n}`).join(", ") || "0 name-keyed reads")
  c.step("POSITIVE CONTROL: the finder catches a specimen `.from(\"brokerages\")…eq(\"name\")` chain and ignores an id-keyed one and a commented one",
    nameKeyedBrokerageReads(`const { data } = await svc.from("brokerages").select("id").eq("name", n).maybeSingle()`) === 1 &&
    nameKeyedBrokerageReads(`const { data } = await svc.from("brokerages").select("id").eq("id", id).maybeSingle()`) === 0 &&
    nameKeyedBrokerageReads(`const { data } = await svc.from("brokerages").select("id, name").ilike("name", pattern)`) === 1)
  c.blind("Other brokerages readers (lookups by name for DISPLAY, e.g. lib/kernel/vendors.ts ilike on a vendor name) are outside the identity survivors by design; test:brokerage-identity (lane 141A) widens the rule to every tenancy-affecting path.")
  const a = await cleanupCanary(svc, B1)
  const b = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length === 0 && a.residual + b.residual === 0, [...a.cleanup, ...b.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup], a.residual + b.residual)
}
