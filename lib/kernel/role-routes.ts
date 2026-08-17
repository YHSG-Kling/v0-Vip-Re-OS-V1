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
  // The bare seat lands on its own work. Without this entry it would fall
  // through to DEFAULT_DASHBOARD_ROUTE — /dashboard/agent — which is a
  // producing agent's workspace, i.e. the one place a rights-less seat must
  // not open on. /dashboard/profile is the first item of NAVIGATION_BY_ROLE.member.
  member:             "/dashboard/profile",
  // `system` is DELIBERATELY ABSENT. It is a real users.user_type (the live CHECK
  // admits it) but it belongs to non-interactive AI-ISA service identities
  // (ai-isa+…@vipreos.internal) that have never signed in and never will. It used
  // to land on /dashboard/admin, which ROUTE_ROLE_REQUIREMENTS does not admit —
  // so the one thing the entry could do was send a service account into a
  // redirect loop. Granting it admin access to fix that would be widening a
  // route for a non-human identity, which is the opposite of the right answer.
  // Absent here, it falls through to DEFAULT_DASHBOARD_ROUTE like any unknown
  // role. ROLE_LABELS still names it, because it is displayed in audit surfaces.
}

export const DEFAULT_DASHBOARD_ROUTE = "/dashboard/agent"

export function roleDashboardRoute(role: string | null | undefined): string {
  return ROLE_DASHBOARD_ROUTES[(role ?? "").toLowerCase()] ?? DEFAULT_DASHBOARD_ROUTE
}

export const ROLE_LABELS: Record<string, string> = {
  superadmin: "Super Admin", support: "Platform Support", admin: "Brokerage Admin",
  broker: "Broker Command", tc: "Coordinator OS", compliance_officer: "Compliance",
  isa: "ISA Qualification", team_lead: "Agent Command", agent: "Agent Command",
  contact: "Client Portal", vendor: "Vendor Portal", lender: "Lender Portal",
  title: "Title Portal", title_agent: "Title Portal", system: "System",
  member: "My Work",
}
