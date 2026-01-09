"use client"

import type React from "react"
import { createContext, useContext, useEffect, useState } from "react"
import { supabase, isSupabaseConfigured } from "../services/supabase"
import { UserRole, type User } from "../types"

interface AuthContextType {
  user: User | null
  role: UserRole
  isLoading: boolean
  userPersona: string | null
  signIn: (email: string, role: UserRole) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null)
  const [role, setRole] = useState<UserRole>(UserRole.AGENT)
  const [isLoading, setIsLoading] = useState(true)
  const [userPersona, setUserPersona] = useState<string | null>(null)

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setIsLoading(false)
      return
    }

    let mounted = true

    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (!mounted) return

        if (session?.user) {
          const userType = session.user.user_metadata?.user_type
          const persona = session.user.user_metadata?.contact_persona

          // Set persona if this is a contact user
          if (userType === "contact" && persona) {
            setUserPersona(persona)
            setRole(UserRole.CONTACT)
          }

          setUser({
            id: session.user.id,
            email: session.user.email,
            name: session.user.user_metadata?.full_name || "User",
            role: userType === "contact" ? UserRole.CONTACT : UserRole.AGENT,
          })
        }
        setIsLoading(false)
      })
      .catch((error) => {
        // Ignore abort errors during unmount
        if (error.name === "AbortError" || !mounted) {
          return
        }
        console.error("[v0] Auth session error:", error)
        setIsLoading(false)
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return

      if (session?.user) {
        const userType = session.user.user_metadata?.user_type
        const persona = session.user.user_metadata?.contact_persona

        if (userType === "contact" && persona) {
          setUserPersona(persona)
          setRole(UserRole.CONTACT)
        }

        setUser({
          id: session.user.id,
          email: session.user.email,
          name: session.user.user_metadata?.full_name || "User",
          role: userType === "contact" ? UserRole.CONTACT : UserRole.AGENT,
        })
      } else {
        setUser(null)
        setUserPersona(null)
      }
      setIsLoading(false)
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  const signIn = async (email: string, selectedRole: UserRole) => {
    const ownsProperty = email.includes("investor") || email.includes("relo") || selectedRole === UserRole.SELLER

    const demoUser: User = {
      email,
      id: "demo-user",
      name: email.split("@")[0],
      role: selectedRole,
      ownsProperty: ownsProperty,
    }

    setUser(demoUser)
    setRole(selectedRole)
  }

  const signOut = async () => {
    if (isSupabaseConfigured()) {
      try {
        await supabase.auth.signOut()
      } catch (error) {
        // Ignore abort errors
        if (error instanceof Error && error.name !== "AbortError") {
          console.error("[v0] Sign out error:", error)
        }
      }
    }
    setUser(null)
    setUserPersona(null)
  }

  return (
    <AuthContext.Provider value={{ user, role, isLoading, userPersona, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}
