"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { createClient } from "@/lib/supabase/client"
import { Building, FileText, AlertTriangle, CheckCircle2, DollarSign, Clock, ChevronRight, Shield } from "lucide-react"

export default function TitlePortalDashboard() {
  const [titleUser, setTitleUser] = useState<any>(null)
  const [transactions, setTransactions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const supabase = createClient()

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: titleData } = await supabase
      .from("title_company_users")
      .select("*")
      .eq("user_id", user.id)
      .single()

    if (titleData) {
      setTitleUser(titleData)

      const { data: txns } = await supabase
        .from("transaction_title_escrow")
        .select(`
          *,
          transactions(
            *,
            leads(*),
            agents(*)
          )
        `)
        .eq("title_company_email", titleData.email)
        .order("created_at", { ascending: false })

      setTransactions(txns || [])
    }

    setLoading(false)
  }

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">Loading...</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!titleUser) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <Building className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">No title company profile found. Please contact your administrator.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const activeCount = transactions.filter(t => !["closed", "cancelled"].includes(t.transactions?.transaction_status)).length
  const pendingEarnestMoney = transactions.filter(t => t.earnest_money_status === "pending").length
  const titleIssuesCount = transactions.filter(t => (t.title_issues?.length || 0) > 0).length
  const readyToClose = transactions.filter(t => t.title_status === "clear" && t.earnest_money_status === "received").length

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Title & Escrow Portal</h1>
          <p className="text-muted-foreground">{titleUser.company_name}</p>
        </div>
        <Badge variant="outline" className="text-sm">
          {activeCount} Active Transactions
        </Badge>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Active Files
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeCount}</div>
            <p className="text-xs text-muted-foreground">In progress</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Pending Earnest Money
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">{pendingEarnestMoney}</div>
            <p className="text-xs text-muted-foreground">Awaiting deposit</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Title Issues
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{titleIssuesCount}</div>
            <p className="text-xs text-muted-foreground">Need resolution</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              Ready to Close
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{readyToClose}</div>
            <p className="text-xs text-muted-foreground">Title clear</p>
          </CardContent>
        </Card>
      </div>

      {/* Transaction List */}
      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All Files ({transactions.length})</TabsTrigger>
          <TabsTrigger value="issues">Title Issues ({titleIssuesCount})</TabsTrigger>
          <TabsTrigger value="pending">Pending EMD ({pendingEarnestMoney})</TabsTrigger>
          <TabsTrigger value="ready">Ready to Close ({readyToClose})</TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Transaction Files</CardTitle>
              <CardDescription>All assigned title and escrow files</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {transactions.map((txn) => (
                  <TitleTransactionCard key={txn.id} transaction={txn} />
                ))}
                {transactions.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <FileText className="h-12 w-12 mx-auto mb-2" />
                    <p>No transactions assigned</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="issues" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Title Issues</CardTitle>
              <CardDescription>Transactions with unresolved title issues</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {transactions
                  .filter(t => (t.title_issues?.length || 0) > 0)
                  .map((txn) => (
                    <TitleTransactionCard key={txn.id} transaction={txn} showIssues />
                  ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pending" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Pending Earnest Money</CardTitle>
              <CardDescription>Awaiting earnest money deposits</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {transactions
                  .filter(t => t.earnest_money_status === "pending")
                  .map((txn) => (
                    <TitleTransactionCard key={txn.id} transaction={txn} />
                  ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ready" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Ready to Close</CardTitle>
              <CardDescription>Clear title, ready for closing</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {transactions
                  .filter(t => t.title_status === "clear" && t.earnest_money_status === "received")
                  .map((txn) => (
                    <TitleTransactionCard key={txn.id} transaction={txn} />
                  ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function TitleTransactionCard({ transaction, showIssues = false }: { transaction: any; showIssues?: boolean }) {
  const txn = transaction.transactions
  const titleIssues = transaction.title_issues || []
  const unresolvedIssues = titleIssues.filter((i: any) => i.status !== "resolved")

  return (
    <div className="border rounded-lg p-4 hover:bg-muted/50 transition-colors">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="font-medium">{txn?.property_address || "Address pending"}</h4>
            <Badge variant={transaction.title_status === "clear" ? "default" : "secondary"}>
              {transaction.title_status || "Pending"}
            </Badge>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span>Agent: {txn?.agents?.first_name} {txn?.agents?.last_name}</span>
            <span>Closing: {txn?.closing_date ? new Date(txn.closing_date).toLocaleDateString() : "TBD"}</span>
          </div>

          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">
                EMD: <Badge variant={transaction.earnest_money_status === "received" ? "default" : "outline"} className="ml-1">
                  {transaction.earnest_money_status || "Pending"}
                </Badge>
              </span>
            </div>
            {unresolvedIssues.length > 0 && (
              <div className="flex items-center gap-1 text-red-600">
                <AlertTriangle className="h-4 w-4" />
                <span className="text-sm">{unresolvedIssues.length} issue(s)</span>
              </div>
            )}
          </div>

          {showIssues && unresolvedIssues.length > 0 && (
            <div className="mt-3 space-y-2">
              {unresolvedIssues.map((issue: any, idx: number) => (
                <div key={idx} className="flex items-center gap-2 text-sm p-2 bg-red-50 rounded">
                  <Badge variant={issue.severity === "critical" ? "destructive" : "secondary"} className="text-xs">
                    {issue.severity}
                  </Badge>
                  <span>{issue.description || issue.type}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <Button variant="ghost" size="icon">
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>
    </div>
  )
}
