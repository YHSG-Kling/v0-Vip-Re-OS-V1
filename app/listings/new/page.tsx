import { redirect } from "next/navigation"

export default function NewListingPage() {
  redirect("/dashboard/listings?action=new")
}
