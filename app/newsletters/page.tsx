import { Metadata } from "next"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { NewslettersClient } from "./newsletters-client"
import { SubscribersPanel, type SubscribableContact } from "./subscribers-panel"
import { PersonalizePreviewPanel } from "./personalize-preview-panel"

export const metadata: Metadata = {
  title: "Newsletters | Marketing Studio",
  description: "Create, manage, and send professional newsletters to your contacts",
}

export default async function NewslettersPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect("/login")
  }

  // Resolve agent + brokerage — never throw, fall back to empty strings
  let brokerageId = ""
  let agentId = ""

  try {
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id, user_type")
      .eq("id", user.id)
      .maybeSingle()

    brokerageId = userData?.brokerage_id ?? ""

    if (brokerageId) {
      const { data: agent } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle()
      agentId = agent?.id ?? ""
    }
  } catch {
    // non-fatal — page renders with empty state
  }

  // Load stats in parallel — individual failures fall back to empty
  let campaigns: Array<{
    id: string
    status: string
    open_rate: number | null
    campaign_name: string
    subject_line: string
    created_at: string
    send_date: string | null
  }> = []
  let totalSubscribers = 0

  try {
    const [campaignsResult, subscribersResult] = await Promise.all([
      brokerageId
        ? supabase
            .from("newsletter_campaigns")
            .select("id, status, open_rate, campaign_name, subject_line, created_at, send_date")
            .eq("brokerage_id", brokerageId)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as typeof campaigns, error: null }),
      brokerageId
        ? supabase
            .from("newsletter_subscribers")
            .select("id", { count: "exact", head: true })
            .eq("brokerage_id", brokerageId)
            .eq("status", "subscribed")
        : Promise.resolve({ count: 0, error: null }),
    ])

    campaigns = (campaignsResult as { data: typeof campaigns | null }).data ?? []
    totalSubscribers = (subscribersResult as { count: number | null }).count ?? 0
  } catch {
    // non-fatal — renders with empty campaign list
  }

  // Contacts the agent can put on the list by hand. The newsletter screen has
  // always shown a subscriber COUNT with no way to change it — the only writer
  // of newsletter_subscribers was the automatic lifecycle enrolment. This feeds
  // the manual lane (manageSubscribers / manageSubscriberBatch), both of which
  // had no caller anywhere in the tree.
  //
  // The error is destructured: a refused read here would otherwise render as
  // "you have no contacts", which is a claim about the agent's book.
  let subscribableContacts: SubscribableContact[] = []
  if (brokerageId) {
    const { data: contactRows, error: contactsError } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, email, email_opt_out")
      .eq("brokerage_id", brokerageId)
      .not("email", "is", null)
      .order("created_at", { ascending: false })
      .limit(200)
    if (contactsError) {
      console.error("[newsletters] contact list read failed:", contactsError.message)
    } else {
      subscribableContacts = (contactRows ?? []).map((c) => ({
        id: c.id as string,
        name: [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed contact",
        email: (c.email as string | null) ?? null,
        optedOut: c.email_opt_out === true,
      }))
    }
  }

  const activeCampaigns = campaigns.filter((c) => c.status === "scheduled").length
  const sentCampaigns = campaigns.filter((c) => c.status === "sent")
  const avgOpenRate =
    sentCampaigns.length > 0
      ? sentCampaigns.reduce((sum, c) => sum + (c.open_rate ?? 0), 0) / sentCampaigns.length
      : null

  return (
    <>
      <NewslettersClient
        userId={user.id}
        agentId={agentId}
        brokerageId={brokerageId}
        campaigns={campaigns}
        stats={{
          activeCampaigns,
          totalSubscribers,
          avgOpenRate,
          totalCampaigns: campaigns.length,
        }}
      />
      <div className="space-y-6 px-4 pb-8 md:px-6">
        <SubscribersPanel
          totalSubscribers={totalSubscribers}
          contacts={subscribableContacts}
        />
        {/* aiPersonalizeNewsletter had no caller AND a contact read that named
            two non-existent tables, so it failed on every invocation it never
            received. Both are fixed; this is its surface. */}
        <PersonalizePreviewPanel
          campaigns={campaigns.map((c) => ({
            id: c.id,
            label: c.subject_line || c.campaign_name || "Untitled campaign",
          }))}
          contacts={subscribableContacts.map((c) => ({ id: c.id, name: c.name }))}
        />
      </div>
    </>
  )
}
