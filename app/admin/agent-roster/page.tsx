import { redirect } from 'next/navigation'

export default function AgentRosterRedirect() {
  redirect('/admin/users')
}
