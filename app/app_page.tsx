'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/stores/authStore'

export default function Page() {
  const router = useRouter()
  const { isAuthenticated, initializeAuth } = useAuthStore()

  useEffect(() => {
    const checkAuth = async () => {
      // Initialize auth state from cookies
      await initializeAuth()

      // Small delay to let state update
      setTimeout(() => {
        if (isAuthenticated) {
          router.push('/dashboard')
        } else {
          router.push('/login')
        }
      }, 100)
    }

    checkAuth()
  }, [isAuthenticated, router, initializeAuth])

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-900">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-white mb-4">Smart Engine</h1>
        <p className="text-slate-400">Loading...</p>
      </div>
    </div>
  )
}
