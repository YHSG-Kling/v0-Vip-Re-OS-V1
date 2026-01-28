// Re-export all types from the main types file
export * from '../types'

// Additional auth-specific types
export interface DemoUser {
  email: string
  password: string
  user: {
    id: string
    email: string
    name: string
    role: string
    avatarUrl?: string
  }
}

// Demo users for testing
export const DEMO_USERS: DemoUser[] = [
  {
    email: 'admin@vipos.com',
    password: 'admin123',
    user: {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'admin@vipos.com',
      name: 'Admin User',
      role: 'admin',
    },
  },
  {
    email: 'agent@vipos.com',
    password: 'agent123',
    user: {
      id: '22222222-2222-2222-2222-222222222222',
      email: 'agent@vipos.com',
      name: 'John Agent',
      role: 'agent',
    },
  },
  {
    email: 'contact@demo.com',
    password: 'contact123',
    user: {
      id: '33333333-3333-3333-3333-333333333333',
      email: 'contact@demo.com',
      name: 'Jane Contact',
      role: 'contact',
    },
  },
]
