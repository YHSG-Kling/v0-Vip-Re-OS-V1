'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore, User } from '@/stores/authStore'

export function LoginPage() {
  const router = useRouter()
  const { login, isLoading, error, isAuthenticated, getDemoUsers } = useAuthStore()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [demoUsers, setDemoUsers] = useState<User[]>([])
  const [loadingDemos, setLoadingDemos] = useState(true)

  // Load demo users on mount
  useEffect(() => {
    const loadDemos = async () => {
      setLoadingDemos(true)
      try {
        const users = await getDemoUsers()
        setDemoUsers(users)
      } catch (err) {
        console.error('Failed to load demo users:', err)
      } finally {
        setLoadingDemos(false)
      }
    }
    loadDemos()
  }, [getDemoUsers])

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      router.push('/dashboard')
    }
  }, [isAuthenticated, router])

  // Handle manual login form submission
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    const success = await login(email, password)
    if (success) {
      router.push('/dashboard')
    }
  }

  // Handle quick demo login
  const handleDemoLogin = async (demoEmail: string) => {
    setEmail(demoEmail)
    const success = await login(demoEmail, 'demo')
    if (success) {
      router.push('/dashboard')
    }
  }

  // Group demo users by user_type for better display
  const groupedDemoUsers = demoUsers.reduce(
    (acc, user) => {
      const type = user.user_type.toUpperCase()
      if (!acc[type]) acc[type] = []
      acc[type].push(user)
      return acc
    },
    {} as Record<string, User[]>
  )

  // Display order for user types
  const displayOrder = ['AGENT', 'BROKER', 'ADMIN', 'TRANSACTION_COORDINATOR', 'CONTACT']

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white flex items-center justify-center p-4">
      <div className="max-w-3xl w-full">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-5xl font-bold mb-2">Smart Engine</h1>
          <p className="text-slate-300 text-xl">VIP Agents Platform</p>
          <p className="text-slate-500 text-sm mt-2">Real Estate AI-Powered Workspace</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Login Form Section */}
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-8 backdrop-blur">
            <h2 className="text-2xl font-bold mb-6">Sign In</h2>

            {error && (
              <div className="mb-4 p-3 bg-red-900/50 border border-red-700 text-red-200 rounded">
                {error}
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2 text-slate-300">
                  Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:border-blue-500 transition"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2 text-slate-300">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:border-blue-500 transition"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed py-2 rounded-lg font-medium transition"
              >
                {isLoading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>

            <div className="mt-6 pt-6 border-t border-slate-700">
              <p className="text-xs text-slate-400 text-center">
                Demo accounts accept any password
              </p>
            </div>
          </div>

          {/* Demo Users Section */}
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-8 backdrop-blur">
            <h2 className="text-2xl font-bold mb-6">Demo Accounts</h2>

            {loadingDemos ? (
              <div className="text-center py-8">
                <p className="text-slate-400">Loading demo users...</p>
              </div>
            ) : demoUsers.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-slate-400">No demo users available</p>
              </div>
            ) : (
              <div className="space-y-6 max-h-[500px] overflow-y-auto">
                {displayOrder.map(type => 
                  groupedDemoUsers[type] ? (
                    <div key={type}>
                      <h3 className="text-xs font-bold text-slate-400 uppercase mb-3">
                        {type.replace(/_/g, ' ')}
                      </h3>
                      <div className="space-y-2">
                        {groupedDemoUsers[type].map(user => (
                          <button
                            key={user.email}
                            onClick={() => handleDemoLogin(user.email)}
                            disabled={isLoading}
                            className="w-full text-left bg-slate-700 hover:bg-slate-600 disabled:opacity-50 p-4 rounded-lg transition flex items-center justify-between"
                          >
                            <div>
                              <div className="font-medium text-sm">
                                {user.name || `${user.first_name} ${user.last_name}`}
                              </div>
                              <div className="text-xs text-slate-400 mt-1">
                                {user.email}
                              </div>
                              {user.role && (
                                <div className="text-xs text-slate-500 mt-1">
                                  {user.role}
                                </div>
                              )}
                            </div>
                            <div className="text-slate-500">→</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-12 text-center text-slate-500 text-xs">
          <p>
            By signing in, you agree to our Terms of Service and Privacy Policy
          </p>
        </div>
      </div>
    </div>
  )
}
