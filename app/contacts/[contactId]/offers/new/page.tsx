import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getContactDetails } from "@/app/actions/contact-details"
import { getConnectedEsignProvider } from "@/app/actions/buyer-offers"
import { notFound } from "next/navigation"
import OfferCreateClient from "./offer-create-client"

export const metadata = { title: "Create Offer" }

export default async function OfferCreatePage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!userData?.brokerage_id) redirect("/dashboard")

  const { data: agentRow } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  const { contact, error } = await getContactDetails(contactId)
  if (error || !contact) notFound()

  const esignProvider = await getConnectedEsignProvider(userData.brokerage_id)

  return (
    <div className="container mx-auto py-8 max-w-2xl">
      <OfferCreateClient
        contact={contact}
        brokerageId={userData.brokerage_id}
        agentUserId={user.id}
        agentId={agentRow?.id ?? null}
        esignProvider={esignProvider}
      />
    </div>
  )
}
