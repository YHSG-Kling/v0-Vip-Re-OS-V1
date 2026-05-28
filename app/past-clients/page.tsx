import { redirect } from "next/navigation"

// Past Clients was renamed to Lifetime Customers. This stub keeps existing
// bookmarks and dashboard links working while the canonical route lives at /lifetime-customers.
export default function PastClientsRedirect() {
  redirect("/lifetime-customers")
}
