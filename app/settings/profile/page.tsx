import { redirect } from "next/navigation"

// Profile consolidation: the one-field personal-website editor that lived here has
// been folded into the canonical "My Profile" hub (/dashboard/profile), alongside
// account info, email signature, video settings, and social accounts. Kept as a
// redirect stub so old bookmarks / deep links don't 404.
export default function ProfileSettingsRedirect() {
  redirect("/dashboard/profile")
}
