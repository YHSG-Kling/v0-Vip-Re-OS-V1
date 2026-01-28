'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// All possible user types from your schema
export enum UserType {
  // Internal team
  AGENT = 'agent',
  BROKER = 'broker',
  ADMIN = 'admin',
  TRANSACTION_COORDINATOR = 'transaction_coordinator',
  COMPLIANCE_MANAGER = 'compliance_manager',
  
  // Contacts
  CONTACT = 'contact',
  
  // Service providers
  LENDER = 'lender',
  INSPECTOR = 'inspector',
  APPRAISER = 'appraiser',
  TITLE_OFFICER = 'title_officer',
  ESCROW_OFFICER = 'escrow_officer',
  VENDOR = 'vendor',
}

// All possible roles
export enum UserRole {
  // Team roles
  AGENT = 'AGENT',
  TEAM_LEADER = 'TEAM_LEADER',
  BROKER = 'BROKER',
  ADMIN = 'ADMIN',
  TC = 'TC',
  COMPLIANCE_MANAGER = 'COMPLIANCE_MANAGER',
  
  // Contact role
  CONTACT = 'CONTACT',
  
  // Service provider roles
  LENDER = 'LENDER',
  INSPECTOR = 'INSPECTOR',
  APPRAISER = 'APPRAISER',
  TITLE_OFFICER = 'TITLE_OFFICER',
  ESCROW_OFFICER = 'ESCROW_OFFICER',
  VENDOR = 'VENDOR',
}

// Contact personas (for contacts specifically)
export enum ContactPersona {
  FIRST_TIME_BUYER = 'first_time_buyer',
  LUXURY_BUYER = 'luxury_buyer',
  RELOCATING_BUYER = 'relocating_buyer',
  MOTIVATED_SELLER = 'motivated_seller',
  DOWNSIZING_SELLER = 'downsizing_seller',
  COMMERCIAL_INVESTOR = 'commercial_investor',
  RESIDENTIAL_INVESTOR = 'residential_investor',
}

export interface User {
  id: string
  email: string
  first_name: string
  last_name: string
  name?: string // Computed from first_name + last_name
  user_type: UserType
  role: UserRole
  phone?: string
  brokerage?: string
  is_contact: boolean
  username?: string
  is_demo?: boolean
  
  // For contacts - which type of contact
  contact_type?: string // 'buyer', 'seller', 'investor', etc
  contact_persona?: string // 'first_time_buyer', 'motivated_seller', etc
  
  // For team structure
  team_id?: string
  team_ids?: string[]
  agent_id?: string // Own agent ID if they're an agent
  managed_agent_ids?: string[] // Agents they manage if they're team lead/broker
}

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  login: (email: string, password: string) => Promise<boolean>
  logout: () => void
  setUser: (user: User | null) => void
  clearError: () => void
  getDemoUsers: () => Promise<User[]>
  initializeAuth: () => Promise<void>
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      initializeAuth: async () => {
        try {
          const authToken = document.cookie
            .split('; ')
            .find(row => row.startsWith('auth_token='))
            ?.split('=')[1]

          if (!authToken) {
            set({ user: null, isAuthenticated: false })
            return
          }

          const currentUser = get().user
          if (currentUser) {
            set({ isAuthenticated: true })
          }
        } catch (error) {
          console.error('Auth initialization error:', error)
          set({ user: null, isAuthenticated: false })
        }
      },

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null })
        try {
          if (!email || !password) {
            set({
              isLoading: false,
              error: 'Email and password are required',
              isAuthenticated: false,
            })
            return false
          }

          const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.toLowerCase(), password }),
          })

          if (!response.ok) {
            const data = await response.json()
            set({
              isLoading: false,
              error: data.error || 'Invalid credentials',
              isAuthenticated: false,
            })
            return false
          }

          const data = await response.json()

          // Map database response to User interface
          const user: User = {
            id: data.id,
            email: data.email,
            first_name: data.first_name,
            last_name: data.last_name,
            name: `${data.first_name} ${data.last_name}`,
            user_type: data.user_type as UserType,
            role: data.role as UserRole,
            phone: data.phone,
            brokerage: data.brokerage,
            is_contact: data.is_contact || false,
            username: data.username,
            is_demo: data.is_demo || false,
            contact_type: data.contact_type,
            contact_persona: data.contact_persona,
            team_id: data.team_id,
            agent_id: data.agent_id,
            managed_agent_ids: data.managed_agent_ids,
          }

          document.cookie = `auth_token=${btoa(email)}; path=/; max-age=86400; SameSite=Lax`
          document.cookie = `user_email=${email}; path=/; max-age=86400; SameSite=Lax`

          set({
            user,
            isAuthenticated: true,
            isLoading: false,
            error: null,
          })

          return true
        } catch (error) {
          console.error('Login error:', error)
          set({
            isLoading: false,
            error: 'Login failed. Please try again.',
            isAuthenticated: false,
          })
          return false
        }
      },

      getDemoUsers: async () => {
        try {
          const response = await fetch('/api/auth/demo-users')
          if (!response.ok) {
            console.error('Failed to fetch demo users')
            return []
          }

          const users = await response.json()
          return users.map((u: any) => ({
            id: u.id,
            email: u.email,
            first_name: u.first_name,
            last_name: u.last_name,
            name: `${u.first_name} ${u.last_name}`,
            user_type: u.user_type as UserType,
            role: u.role as UserRole,
            phone: u.phone,
            brokerage: u.brokerage,
            is_contact: u.is_contact || false,
            username: u.username,
            is_demo: u.is_demo || false,
            contact_type: u.contact_type,
            contact_persona: u.contact_persona,
            team_id: u.team_id,
            agent_id: u.agent_id,
            managed_agent_ids: u.managed_agent_ids,
          }))
        } catch (error) {
          console.error('Error fetching demo users:', error)
          return []
        }
      },

      logout: () => {
        document.cookie = 'auth_token=; path=/; max-age=0'
        document.cookie = 'user_email=; path=/; max-age=0'

        fetch('/api/auth/logout', { method: 'POST' }).catch(console.error)

        set({
          user: null,
          isAuthenticated: false,
          error: null,
        })
      },

      setUser: (user) => set({ user }),
      clearError: () => set({ error: null }),
    }),
    {
      name: 'auth-store',
      version: 1,
    }
  )
)
