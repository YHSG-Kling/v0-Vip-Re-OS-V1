import { redirect } from "next/navigation"

// Redirect to main settings branding page
//
// TOMBSTONE (orphan tranche 3): the leftover agent-branding-client.tsx
// (AgentBrandingClient) is deleted — this page redirects and never rendered
// it, and nothing else did. Both of its halves live elsewhere, more
// completely: the personal email signature is AgentSignaturePanel on
// app/dashboard/profile/page.tsx (the panel also owns the save path), and the
// brokerage compliance logo is managed by BrandingForm on
// app/settings/branding/page.tsx — the exact surface the deleted card's own
// buttons linked to.
export default function DashboardSettingsBrandingPage() {
  redirect("/settings/branding")
}
