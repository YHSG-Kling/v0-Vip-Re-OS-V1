import { redirect } from 'next/navigation'

// Alias stub — mirrors ROUTE_ALIASES['/tasks'] in app/routes-compatibility.ts
// (held in agreement by scripts/dangling-link-sweep.ts aliasAgreement). Moved
// from '/dashboard' to the agent-facing task list when that list was built
// (lane G3, 2026-09-03). app/actions/tasks.ts still revalidates "/tasks".
export default function TasksRedirect() {
  redirect('/dashboard/tasks')
}
