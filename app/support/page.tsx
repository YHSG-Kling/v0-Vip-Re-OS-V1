import { redirect } from 'next/navigation'

// Support page - redirects to external help
export default function SupportPage() {
  redirect('https://vercel.com/help')
}
