'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from './stores/authStore'

export default function Home() {
  const router = useRouter()
  const { user, isLoading } = useAuthStore()

  useEffect(() => {
    // ✅ Only redirect if NOT loading and NO user
    if (!isLoading && !user) {
      router.push('/login')
    }
  }, [user, isLoading, router])

  // ✅ Show loading while checking auth
  if (isLoading || !user) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p>Loading...</p>
        </div>
      </div>
    )
  }

  return <Dashboard />
}
