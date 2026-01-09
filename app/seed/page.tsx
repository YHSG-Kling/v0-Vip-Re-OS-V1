"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  CheckCircle,
  XCircle,
  Loader2,
  Users,
  Contact,
  Database,
  Copy,
  AlertTriangle,
  Table,
  ArrowRight,
} from "lucide-react"

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
  tableNotFound?: boolean
}

export default function SeedPage() {
  const [usersLoading, setUsersLoading] = useState(false)
  const [contactsLoading, setContactsLoading] = useState(false)
  const [migrateLoading, setMigrateLoading] = useState(false)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [verifyResult, setVerifyResult] = useState<any>(null)
  const [migrateResult, setMigrateResult] = useState<SeedResponse | null>(null)
  const [usersResult, setUsersResult] = useState<SeedResponse | null>(null)
  const [contactsResult, setContactsResult] = useState<SeedResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sqlScript, setSqlScript] = useState<string | null>(null)
  const [airtableTableNotFound, setAirtableTableNotFound] = useState(false)
  const [copied, setCopied] = useState(false)

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
    setAirtableTableNotFound(false)
    try {
      const response = await fetch("/api/seed/contacts", { method: "POST" })
      const data = await response.json()
      if (!response.ok) {
        if (data.tableNotFound) {
          setAirtableTableNotFound(true)
          return
        }
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

  const migrateAirtableToSupabase = async () => {
    setMigrateLoading(true)
    setError(null)
    setMigrateResult(null)
    try {
      const response = await fetch("/api/migrate/airtable-to-supabase", { method: "POST" })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || "Failed to migrate contacts")
      }
      setMigrateResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to migrate contacts")
    } finally {
      setMigrateLoading(false)
    }
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

  const copySQL = () => {
    if (sqlScript) {
      navigator.clipboard.writeText(sqlScript)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-gray-900">Database Setup & Migration</h1>
          <p className="text-gray-600">Complete Supabase migration for production-ready unified database</p>
        </div>

        <Card className="border-blue-300 bg-gradient-to-br from-blue-50 to-indigo-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-blue-900">
              <Database className="h-5 w-5" />
              Verify Supabase Migration
            </CardTitle>
            <CardDescription className="text-blue-700">
              Check if all tables are created and data is migrated successfully
            </CardDescription>
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
                      <span className="font-medium text-gray-900">{verifyResult.results.contacts} records</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-600">Users:</span>
                      <span className="font-medium text-gray-900">{verifyResult.results.users} records</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-600">Transactions:</span>
                      <span className="font-medium text-gray-900">{verifyResult.results.transactions} records</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-600">Listings:</span>
                      <span className="font-medium text-gray-900">{verifyResult.results.listings} records</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-600">Agents:</span>
                      <span className="font-medium text-gray-900">{verifyResult.results.agents} records</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-600">Vendors:</span>
                      <span className="font-medium text-gray-900">{verifyResult.results.vendors} records</span>
                    </div>
                  </div>
                </div>

                {verifyResult.results.errors.length > 0 && (
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

        {error && !sqlScript && !airtableTableNotFound && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">{error}</div>
        )}

        {sqlScript && (
          <Card className="border-amber-300 bg-amber-50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-amber-800">
                <AlertTriangle className="h-5 w-5" />
                Users Table Not Found
              </CardTitle>
              <CardDescription className="text-amber-700">
                The users table doesnt exist in Supabase. Copy the SQL below and run it in your Supabase SQL Editor.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="relative">
                <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg text-sm overflow-x-auto whitespace-pre-wrap">
                  {sqlScript}
                </pre>
                <Button onClick={copySQL} size="sm" variant="secondary" className="absolute top-2 right-2">
                  {copied ? (
                    <>
                      <CheckCircle className="h-4 w-4 mr-1" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4 mr-1" />
                      Copy SQL
                    </>
                  )}
                </Button>
              </div>
              <div className="text-sm text-amber-700 space-y-1">
                <p className="font-medium">Steps:</p>
                <ol className="list-decimal list-inside space-y-1">
                  <li>Go to your Supabase Dashboard</li>
                  <li>Click SQL Editor in the left sidebar</li>
                  <li>Click New Query</li>
                  <li>Paste the SQL above and click Run</li>
                  <li>Return here and click Seed Users again</li>
                </ol>
              </div>
            </CardContent>
          </Card>
        )}

        {airtableTableNotFound && (
          <Card className="border-emerald-300 bg-emerald-50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-emerald-800">
                <Table className="h-5 w-5" />
                Airtable Contacts Table Not Found
              </CardTitle>
              <CardDescription className="text-emerald-700">
                You need to create a Contacts table in your Airtable base first.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="text-sm text-emerald-700 space-y-3">
                <p className="font-medium">Steps to create the Contacts table:</p>
                <ol className="list-decimal list-inside space-y-2">
                  <li>
                    Go to your{" "}
                    <a
                      href="https://airtable.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline font-medium"
                    >
                      Airtable Dashboard
                    </a>
                  </li>
                  <li>Open your base (ID: {process.env.AIRTABLE_BASE_ID || "check your env vars"})</li>
                  <li>
                    Click <strong>+ Add a table</strong>
                  </li>
                  <li>
                    Name it exactly: <code className="bg-emerald-100 px-1 py-0.5 rounded">Contacts</code>
                  </li>
                  <li>Add these fields (or just click seed again and Airtable will create them automatically):</li>
                </ol>

                <div className="bg-white rounded-lg p-4 border border-emerald-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 font-medium">Field Name</th>
                        <th className="text-left py-2 font-medium">Type</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      <tr>
                        <td className="py-1.5">first_name</td>
                        <td>Single line text</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">last_name</td>
                        <td>Single line text</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">email</td>
                        <td>Email</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">phone</td>
                        <td>Phone number</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">contact_type</td>
                        <td>Single select (buyer, seller, investor)</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">contact_persona</td>
                        <td>Single select</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">source</td>
                        <td>Single select</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">status</td>
                        <td>Single select</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">timeline</td>
                        <td>Single select</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">agent_id</td>
                        <td>Single line text</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">notes</td>
                        <td>Long text</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">has_login</td>
                        <td>Checkbox</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">created_at</td>
                        <td>Date</td>
                      </tr>
                      <tr>
                        <td className="py-1.5">updated_at</td>
                        <td>Date</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <p className="text-emerald-600 italic">
                  Tip: You can also just create an empty table named Contacts and Airtable will auto-create the fields
                  when you seed data.
                </p>
              </div>

              <Button
                onClick={seedContacts}
                disabled={contactsLoading}
                className="w-full bg-emerald-600 hover:bg-emerald-700"
              >
                {contactsLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Retrying...
                  </>
                ) : (
                  <>
                    <Database className="h-4 w-4 mr-2" />
                    Retry Seed Contacts
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        <Card className="border-purple-300 bg-gradient-to-br from-purple-50 to-blue-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-purple-900">
              <ArrowRight className="h-5 w-5" />
              Migrate Airtable → Supabase (Recommended)
            </CardTitle>
            <CardDescription className="text-purple-700">
              Move all your contacts from Airtable to Supabase for better performance and unified database
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-white/80 rounded-lg p-4 border border-purple-200 text-sm text-purple-900">
              <p className="font-medium mb-2">Why migrate to Supabase?</p>
              <ul className="list-disc list-inside space-y-1 text-purple-700">
                <li>Single unified database for users and contacts</li>
                <li>Better performance with proper SQL relationships</li>
                <li>Built-in Row Level Security (RLS)</li>
                <li>No manual table creation needed</li>
                <li>Easier to build and maintain features</li>
                <li>40+ tables with proper foreign keys and indexes</li>
                <li>Code-based workflows replace n8n</li>
              </ul>
            </div>

            <Button
              onClick={migrateAirtableToSupabase}
              disabled={migrateLoading}
              className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
            >
              {migrateLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Migrating Contacts...
                </>
              ) : (
                <>
                  <ArrowRight className="h-4 w-4 mr-2" />
                  Migrate Contacts to Supabase
                </>
              )}
            </Button>

            {migrateResult && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-700">{migrateResult.message}</p>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {migrateResult.results.map((r, i) => (
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

        <div className="grid md:grid-cols-2 gap-6">
          {/* Users Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-blue-600" />
                Seed Test Users
              </CardTitle>
              <CardDescription>Create 7 test users: admin, broker, 2 agents, TC, vendor, lender</CardDescription>
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
                    Seed Users to Supabase
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
                <Contact className="h-5 w-5 text-emerald-600" />
                Seed Test Contacts
              </CardTitle>
              <CardDescription>
                Create 6 test contacts: buyers, sellers, investors with various personas
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                onClick={seedContacts}
                disabled={contactsLoading}
                className="w-full bg-transparent"
                variant="outline"
              >
                {contactsLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Seeding Contacts...
                  </>
                ) : (
                  <>
                    <Database className="h-4 w-4 mr-2" />
                    Seed Contacts to Airtable
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
        </div>

        {/* Seed All Button */}
        <Card>
          <CardContent className="pt-6">
            <Button
              onClick={seedAll}
              disabled={usersLoading || contactsLoading || migrateLoading || verifyLoading}
              size="lg"
              className="w-full bg-gradient-to-r from-blue-600 to-emerald-600 hover:from-blue-700 hover:to-emerald-700"
            >
              {usersLoading || contactsLoading || migrateLoading || verifyLoading ? (
                <>
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Seeding All Test Data...
                </>
              ) : (
                <>
                  <Database className="h-5 w-5 mr-2" />
                  Seed All Test Data (Users + Contacts)
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Test Accounts Reference */}
        <Card>
          <CardHeader>
            <CardTitle>Test Account Credentials</CardTitle>
            <CardDescription>Use these to log in after seeding</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 gap-4 text-sm">
              <div className="space-y-2">
                <p className="font-medium text-gray-900">Users (Supabase)</p>
                <ul className="space-y-1 text-gray-600">
                  <li>admin@nexus.local - Admin</li>
                  <li>broker@nexus.local - Broker</li>
                  <li>sarah.agent@nexus.local - Agent</li>
                  <li>michael.agent@nexus.local - Agent</li>
                  <li>tc@nexus.local - Transaction Coordinator</li>
                  <li>vendor@nexus.local - Vendor</li>
                  <li>lender@nexus.local - Lender</li>
                </ul>
              </div>
              <div className="space-y-2">
                <p className="font-medium text-gray-900">Contacts (Airtable)</p>
                <ul className="space-y-1 text-gray-600">
                  <li>James Wilson - First Time Buyer</li>
                  <li>Patricia Garcia - Motivated Seller</li>
                  <li>Robert Martinez - Investor</li>
                  <li>Linda Thompson - Relocating Buyer</li>
                  <li>David Anderson - Luxury Buyer</li>
                  <li>Nancy White - FSBO</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
