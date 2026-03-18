import { redirect } from 'next/navigation'

// /dashboard/contacts redirects to /crm for Kernel OS compatibility
export default function DashboardContactsPage() {
  redirect('/crm')
}
