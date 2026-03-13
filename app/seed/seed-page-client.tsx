"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CheckCircle, XCircle, Loader2, Users, Contact, Database } from "lucide-react"

interface SeedResult {
  email?: string
  name?: string
  success: boolean
  error?: string
  id?: string
}

interface SeedResponse {
  message: string
  results: SeedResult[]
  error?: string
  sql?: string
}

export function SeedPageClient() {
  const [usersLoading, setUsersLoading] = useState(false)
  const [contactsLoading, setContactsLoading] = useState(false)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [verifyResult, setVerifyResult] = useState<any>(null)
  const [usersResult, setUsersResult] = useState<SeedResponse | null>(null)
  const [contactsResult, setContactsResult] = useState<SeedResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sqlScript, setSqlScript] = useState<string | null>(null)

  const seedUsers = async () => {
    setUsersLoading(true)
    setError(null)
    setSqlScript(null)
    try {
      const response = await fetch("/api/seed/users", { method: "POST" })
      const data = await response.json()
      if (!response.ok) {
        if (data.sql) {
          setSqlScript(data.sql)
          setError(data.error)
        } else {
          throw new Error(data.error || "Failed to seed users")
        }
        return
      }
      setUsersResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to seed users")
    } finally {
      setUsersLoading(false)
    }
  }

  const seedContacts = async () => {
    setContactsLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/seed/contacts", { method: "POST" })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || "Failed to seed contacts")
      }
      setContactsResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to seed contacts")
    } finally {
      setContactsLoading(false)
    }
  }

  const seedAll = async () => {
    await seedUsers()
    await seedContacts()
  }

  const verifyMigration = async () => {
    setVerifyLoading(true)
    setError(null)
    setVerifyResult(null)
    try {
      const response = await fetch("/api/migrate/verify")
      const data = await response.json()
      setVerifyResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify migration")
    } finally {
      setVerifyLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-gray-900">Supabase Database Setup</h1>
          <p className="text-gray-600">Create test data for production-ready unified database</p>
        </div>

        <Card className="border-blue-300 bg-gradient-to-br from-blue-50 to-indigo-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-blue-900">
              <Database className="h-5 w-5" />
              Verify Supabase Setup
            </CardTitle>
            <CardDescription className="text-blue-700">Check if all tables are created and ready</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={verifyMigration}
              disabled={verifyLoading}
              className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
            >
              {verifyLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Verifying Tables...
                </>
              ) : (
                <>
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Verify Supabase Tables
                </>
              )}
            </Button>

            {verifyResult && (
              <div className="space-y-3">
                <div
                  className={`p-3 rounded-lg ${verifyResult.success ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}
                >
                  <p className="font-medium">{verifyResult.message}</p>
                </div>

                <div className="bg-white rounded-lg p-4 border border-blue-200">
                  <p className="text-sm font-medium text-gray-700 mb-3">Table Status:</p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-gray-600">Contacts:</span>
                      <span className="font-medium text-gray-900">{verifyResult.results?.contacts || 0} records</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-600">Users:</span>
                      <span className="font-medium text-gray-900">{verifyResult.results?.users || 0} records</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-600">Transactions:</span>
                      <span className="font-medium text-gray-900">
                        {verifyResult.results?.transactions || 0} records
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-600">Listings:</span>
                      <span className="font-medium text-gray-900">{verifyResult.results?.listings || 0} records</span>
                    </div>
                  </div>
                </div>

                {verifyResult.results?.errors?.length > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                    <p className="text-sm font-medium text-amber-800 mb-2">Issues Found:</p>
                    <ul className="text-sm text-amber-700 space-y-1">
                      {verifyResult.results.errors.map((err: string, i: number) => (
                        <li key={i}>• {err}</li>
                      ))}
                    </ul>
                    <p className="text-sm text-amber-600 mt-3 italic">
                      Run the SQL schema script (scripts/020-create-complete-supabase-schema.sql) in your Supabase SQL
                      Editor to create missing tables.
                    </p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {error && !sqlScript && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">{error}</div>
        )}

        {sqlScript && (
          <Card className="border-amber-300 bg-amber-50">
            <CardHeader>
              <CardTitle className="text-amber-800">Users Table Not Found</CardTitle>
              <CardDescription className="text-amber-700">
                Copy and run the SQL below in your Supabase SQL Editor
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg text-sm overflow-x-auto">{sqlScript}</pre>
            </CardContent>
          </Card>
        )}

        {/* Users Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-blue-600" />
              Seed Test Users
            </CardTitle>
            <CardDescription>Create 7 test users for Supabase</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onClick={seedUsers} disabled={usersLoading} className="w-full">
              {usersLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Seeding Users...
                </>
              ) : (
                <>
                  <Database className="h-4 w-4 mr-2" />
                  Seed Users
                </>
              )}
            </Button>

            {usersResult && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-700">{usersResult.message}</p>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {usersResult.results.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm py-1">
                      {r.success ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-500" />
                      )}
                      <span className={r.success ? "text-gray-700" : "text-red-600"}>
                        {r.email}
                        {r.error && ` - ${r.error}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Contacts Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Contact className="h-5 w-5 text-purple-600" />
              Seed Test Contacts
            </CardTitle>
            <CardDescription>Create 6 test contacts for Supabase</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={seedContacts}
              disabled={contactsLoading}
              className="w-full bg-purple-600 hover:bg-purple-700"
            >
              {contactsLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Seeding Contacts...
                </>
              ) : (
                <>
                  <Database className="h-4 w-4 mr-2" />
                  Seed Contacts
                </>
              )}
            </Button>

            {contactsResult && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-700">{contactsResult.message}</p>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {contactsResult.results.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm py-1">
                      {r.success ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-500" />
                      )}
                      <span className={r.success ? "text-gray-700" : "text-red-600"}>
                        {r.name}
                        {r.error && ` - ${r.error}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Seed All Button */}
        <Button
          onClick={seedAll}
          className="w-full h-12 text-base bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
        >
          <Loader2 className="h-5 w-5 mr-2" />
          Seed All (Users + Contacts)
        </Button>
      </div>
    </div>
  )
}
