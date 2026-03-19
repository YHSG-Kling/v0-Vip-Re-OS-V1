import { redirect } from 'next/navigation'

// /contacts redirects to /crm
export default function ContactsPage() {
  redirect('/crm')
}
