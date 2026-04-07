import { redirect } from 'next/navigation'

export default function OpenHouseRedirect() {
  redirect('/dashboard/listings')
}
