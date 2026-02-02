import { DEMO_CONFIG, DEMO_USERS } from '@/app/constants/auth'

/**
 * Get all demo users (for demo user selector)
 * This is a regular function (not a server action) so it can be used in client components
 */
export function getDemoUsers() {
  if (!DEMO_CONFIG.ENABLED) {
    return []
  }

  return DEMO_USERS.map((user) => ({
    email: user.email,
    name: user.name,
    role: user.role,
    description: user.description,
  }))
}
