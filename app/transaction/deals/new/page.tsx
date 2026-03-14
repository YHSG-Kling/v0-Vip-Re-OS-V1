import { redirect } from 'next/navigation'
// Transaction creation lives in the main transactions dashboard
export default function NewDealPage() {
  redirect('/dashboard/transactions')
}
