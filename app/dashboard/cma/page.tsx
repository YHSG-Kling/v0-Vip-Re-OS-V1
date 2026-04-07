import { redirect } from 'next/navigation'

export default function CMARedirect() {
  redirect('/dashboard/listings')
}
