import { redirect } from "next/navigation"

// Retired to the canonical recruiting surface (already aliased in routes-compatibility).
export default function LegacyRecruitingHubPage() {
  redirect("/dashboard/recruiting-roi")
}
