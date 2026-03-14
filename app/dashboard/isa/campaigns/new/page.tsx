import { redirect } from 'next/navigation'
// New campaign creation is embedded in the campaigns page
export default function NewISACampaignPage() {
  redirect('/dashboard/isa/campaigns')
}
