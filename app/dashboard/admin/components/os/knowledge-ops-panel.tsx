"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  BookOpen, 
  ChevronRight,
  Loader2,
  FileText,
  Clock
} from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

interface KnowledgeOpsPanelProps {
  brokerageId: string
}

interface KnowledgeStatus {
  totalArticles: number
  publishedArticles: number
  draftArticles: number
  staleArticles: number
  recentArticles: Array<{
    id: string
    title: string
    status: string
    updated_at: string
  }>
}

export function KnowledgeOpsPanel({ brokerageId }: KnowledgeOpsPanelProps) {
  const [data, setData] = useState<KnowledgeStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadKnowledge() {
      if (!brokerageId) {
        setLoading(false)
        return
      }

      const supabase = createClient()
      const sixMonthsAgo = new Date()
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)

      const [
        { count: totalArticles },
        { count: publishedArticles },
        { count: draftArticles },
        { count: staleArticles },
        { data: recentArticles },
      ] = await Promise.all([
        supabase
          .from("knowledge_articles")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId),
        supabase
          .from("knowledge_articles")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("status", "published"),
        supabase
          .from("knowledge_articles")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("status", "draft"),
        supabase
          .from("knowledge_articles")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("status", "published")
          .lt("updated_at", sixMonthsAgo.toISOString()),
        supabase
          .from("knowledge_articles")
          .select("id, title, status, updated_at")
          .eq("brokerage_id", brokerageId)
          .order("updated_at", { ascending: false })
          .limit(3),
      ])

      setData({
        totalArticles: totalArticles || 0,
        publishedArticles: publishedArticles || 0,
        draftArticles: draftArticles || 0,
        staleArticles: staleArticles || 0,
        recentArticles: recentArticles || [],
      })
      setLoading(false)
    }

    loadKnowledge()
  }, [brokerageId])

  if (loading) {
    return (
      <Card className="border-border">
        <CardContent className="flex items-center justify-center p-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  const hasStale = data.staleArticles > 0

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <BookOpen className="h-4 w-4 text-cyan-600" />
            Knowledge Ops
          </CardTitle>
          <Badge variant="outline" className="text-xs">
            {data.publishedArticles} Published
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center p-2 bg-emerald-50/50 rounded-lg">
            <p className="text-lg font-bold text-emerald-700">{data.publishedArticles}</p>
            <p className="text-xs text-muted-foreground">Published</p>
          </div>
          <div className={`text-center p-2 rounded-lg ${data.draftArticles > 0 ? "bg-amber-50/50" : "bg-muted/50"}`}>
            <p className={`text-lg font-bold ${data.draftArticles > 0 ? "text-amber-700" : ""}`}>
              {data.draftArticles}
            </p>
            <p className="text-xs text-muted-foreground">Drafts</p>
          </div>
          <div className={`text-center p-2 rounded-lg ${hasStale ? "bg-red-50/50" : "bg-muted/50"}`}>
            <p className={`text-lg font-bold ${hasStale ? "text-red-700" : ""}`}>
              {data.staleArticles}
            </p>
            <p className="text-xs text-muted-foreground">Stale</p>
          </div>
        </div>

        {/* Recent Articles */}
        {data.recentArticles.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Recent Updates</p>
            {data.recentArticles.map((article) => (
              <div
                key={article.id}
                className="flex items-center justify-between p-2 bg-muted/30 rounded-lg"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="text-xs truncate">{article.title}</span>
                </div>
                <Badge 
                  variant={article.status === "published" ? "outline" : "secondary"} 
                  className="text-[10px] flex-shrink-0"
                >
                  {article.status}
                </Badge>
              </div>
            ))}
          </div>
        )}

        {hasStale && (
          <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-600" />
              <span className="text-xs text-amber-700">
                {data.staleArticles} article{data.staleArticles > 1 ? "s" : ""} need review
              </span>
            </div>
          </div>
        )}

        <Link href="/dashboard/settings/knowledge-base">
          <Button variant="outline" size="sm" className="w-full">
            Manage Knowledge Base
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
