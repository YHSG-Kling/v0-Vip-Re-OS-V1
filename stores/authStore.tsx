"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { UserRole } from "../types"

interface User {
  id: string
  email: string
  name: string
  role: UserRole
  avatarUrl?: string
  phone?: string
  // Role-specific IDs
  agentId?: string // For agents - their agent record ID
  contactId?: string // For contacts - their contact record ID
  vendorId?: string // For vendors - their vendor record ID
  // Team and brokerage
  teamId?: string
  teamIds?: string[] // For TCs managing multiple teams
  brokerageId?: string
  managedAgentIds?: string[] // For team leads/brokers
  // Contact-specific fields
  searchCriteria?: {
    zip?: string
    priceRange?: [number, number]
    beds?: number
    baths?: number
  }
  // Sub-type for more granular roles
  subType?:
    | "agent"
    | "team_lead"
    | "buyer"
    | "seller"
    | "investor"
    | "vendor"
    | "lender"
    | "inspector"
    | "appraiser"
    | "title_officer"
    | "escrow_officer"
    | "transaction_coordinator"
    | "compliance_manager"
}

interface AuthState {
  user: User | null
  role: UserRole
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  login: (email: string, password: string) => Promise<boolean>
  logout: () => void
  checkAuth: () => void
  setUser: (user: User | null) => void
  setRole: (role: UserRole) => void
  clearError: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      role: UserRole.CONTACT,
      isAuthenticated: false,
      isLoading: true,
      error: null,

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null })
        try {
          const mockUsers: Record<string, User> = {
            "admin@vipos.com": {
              id: "11111111-1111-1111-1111-111111111111",
              email: "admin@vipos.com",
              name: "Admin User",
              role: UserRole.ADMIN,
              brokerageId: "brokerage_1",
            },
            "broker@vipos.com": {
              id: "22222222-2222-2222-2222-222222222222",
              email: "broker@vipos.com",
              name: "Sarah Johnson",
              role: UserRole.BROKER,
              brokerageId: "brokerage_1",
              managedAgentIds: ["33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444"],
            },
            "agent1@vipos.com": {
              id: "33333333-3333-3333-3333-333333333333",
              email: "agent1@vipos.com",
              name: "Michael Chen",
              role: UserRole.AGENT,
              agentId: "33333333-3333-3333-3333-333333333333",
              teamId: "team_1",
              teamIds: ["team_1"],
              brokerageId: "brokerage_1",
              subType: "agent",
            },
            "agent2@vipos.com": {
              id: "44444444-4444-4444-4444-444444444444",
              email: "agent2@vipos.com",
              name: "Emily Rodriguez",
              role: UserRole.AGENT,
              agentId: "44444444-4444-4444-4444-444444444444",
              teamId: "team_1",
              teamIds: ["team_1"],
              brokerageId: "brokerage_1",
              subType: "team_lead",
              managedAgentIds: ["33333333-3333-3333-3333-333333333333"],
            },
            "tc@vipos.com": {
              id: "66666666-6666-6666-6666-666666666666",
              email: "tc@vipos.com",
              name: "Jessica Brown",
              role: UserRole.TC,
              teamIds: ["team_1", "team_2"],
              brokerageId: "brokerage_1",
              managedAgentIds: ["33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444"],
              subType: "transaction_coordinator",
            },
            "lender@mortgage.com": {
              id: "55555555-5555-5555-5555-555555555555",
              email: "lender@mortgage.com",
              name: "David Williams",
              role: UserRole.LENDER,
              subType: "lender",
            },
            "buyer@email.com": {
              id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              email: "buyer@email.com",
              name: "John Smith",
              role: UserRole.CONTACT,
              contactId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              subType: "buyer",
              searchCriteria: {
                zip: "78704",
                priceRange: [400000, 800000],
                beds: 3,
                baths: 2,
              },
            },
            "seller@email.com": {
              id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
              email: "seller@email.com",
              name: "Lisa Anderson",
              role: UserRole.CONTACT,
              contactId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
              subType: "seller",
            },
            "vendor@inspections.com": {
              id: "vendor_1",
              email: "vendor@inspections.com",
              name: "Home Inspector Pro",
              role: UserRole.VENDOR,
              vendorId: "vendor_1",
              subType: "inspector",
            },
            "compliance@vipos.com": {
              id: "compliance_1",
              email: "compliance@vipos.com",
              name: "Compliance Manager",
              role: UserRole.COMPLIANCE_OFFICER,
              brokerageId: "brokerage_1",
              subType: "compliance_manager",
            },
          }

          const user = mockUsers[email.toLowerCase()]
          if (user && password.length > 0) {
            set({
              user,
              role: user.role,
              isAuthenticated: true,
              isLoading: false,
            })
            return true
          }

          set({ error: "Invalid credentials", isLoading: false })
          return false
        } catch (error) {
          set({ error: "Authentication failed", isLoading: false })
          return false
        }
      },

      logout: () => {
        set({
          user: null,
          role: UserRole.CONTACT,
          isAuthenticated: false,
          error: null,
        })
      },

      checkAuth: () => {
        // This will be called on mount to check localStorage and set isLoading to false
        const state = get()
        set({ isLoading: false })
        
        // If user exists in state but not authenticated, clear the user
        if (state.user && !state.isAuthenticated) {
          set({ user: null, role: UserRole.CONTACT })
        }
      },

      setUser: (user) => {
        set({
          user,
          role: user?.role || UserRole.CONTACT,
          isAuthenticated: !!user,
        })
      },

      setRole: (role) => {
        set({ role })
        if (get().user) {
          set({ user: { ...get().user!, role } })
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: "auth-storage",
      partialize: (state) => ({
        user: state.user,
        role: state.role,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
)
