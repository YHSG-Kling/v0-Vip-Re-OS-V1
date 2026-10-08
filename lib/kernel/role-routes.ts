// lib/kernel/role-routes.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE canonical role → dashboard route map. Consolidates three drifted copies
// (lib/kernel/users.ts, lib/kernel/onboarding.ts, root-role-resolver.tsx) that had
// diverged (only one carried title/title_agent; NONE routed platform 'support').
// Plain module → safe to import from server + client. Icons stay in the client
// resolver (pure UI); routes + labels live here so they can never drift again.

export const ROLE_DASHBOARD_ROUTES: Record<string, string> = {
  superadmin:         "/dashboard/superadmin/home", // platform staff land on the command home
  marketing:          "/dashboard/superadmin/home", // platform marketing staff — same command home
  support:            "/dashboard/support",
  admin:              "/dashboard/admin",
  broker:             "/dashboard/brokerage",
  tc:                 "/dashboard/coordinator",
  compliance_officer: "/dashboard/compliance",
  isa:                "/dashboard/isa",
  team_lead:          "/dashboard/agent",
  agent:              "/dashboard/agent",
  contact:            "/portal",
  vendor:             "/vendor/dashboard",
  lender:             "/lender/dashboard", // legacy: lenders are vendors now; kept as a harmless fallback
  title:              "/title/dashboard",
  title_agent:        "/title/dashboard",
  // `system` is DELIBERATELY ABSENT. It is a real users.user_type (the live CHECK
  // admits it) but it belongs to non-interactive AI-ISA service identities
  // (ai-isa+…@vipreos.internal) that have never signed in and never will. It used
  // to land on /dashboard/admin, which ROUTE_ROLE_REQUIREMENTS does not admit —
  // so the one thing the entry could do was send a service account into a
  // redirect loop. Granting it admin access to fix that would be widening a
  // route for a non-human identity, which is the opposite of the right answer.
  // Absent here, it falls through to DEFAULT_DASHBOARD_ROUTE like any unknown
  // role. (A ROLE_LABELS map below used to name it "System"; that map was
  // deleted unadopted — see the tombstone below.)
}

export const DEFAULT_DASHBOARD_ROUTE = "/dashboard/agent"

export function roleDashboardRoute(role: string | null | undefined): string {
  return ROLE_DASHBOARD_ROUTES[(role ?? "").toLowerCase()] ?? DEFAULT_DASHBOARD_ROUTE
}

// TOMBSTONE (§1.3, 2026-08-31, lane M4): `ROLE_LABELS` deleted — the label half
// of this consolidation never got an adopter (zero importers ever; the header's
// "routes + labels live here" and the `system`-is-"displayed in audit surfaces"
// note described an intent, not a wiring). What it held were DASHBOARD-SURFACE
// names ("Broker Command", "Coordinator OS", "Client Portal"), and no surface
// wants that map: the three live ROLE_LABELS in the tree label the ROLE itself,
// each with per-surface wording that is a decision, not drift —
//   · app/components/settings/VoiceAccessSettings.tsx — expansion-picker
//     phrasing ("Transaction Coordinator (tc)");
//   · app/dashboard/admin/users/[userId]/staff-360-panels.tsx — staff-audit
//     badge names;
//   · app/dashboard/admin/users/invite-user-button.tsx — invitable roles only
//     (deliberately NO lender: lenders are vendors, owner model round 16).
// Same spelling, three different capabilities; fusing them onto one map would
// put "Broker Command" on an invite button. ROLE_DASHBOARD_ROUTES above stays
// the live, imported half of this module.
