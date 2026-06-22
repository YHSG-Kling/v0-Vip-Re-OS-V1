import { redirect } from 'next/navigation'

// In-app help center + ticketing (replaces the old external redirect to Vercel help).
export default function SupportPage() {
  redirect('/dashboard/help')
}
