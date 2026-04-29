import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getEducationTemplates } from "@/app/actions/video-generation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const metadata = {
  title: "Education Videos | Dashboard",
  description: "Buyer and seller education video templates",
}

const CATEGORY_LABELS: Record<string, string> = {
  buyer_education: "Buyer",
  seller_education: "Seller",
  market_update: "Market",
}

export default async function EducationVideosPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const templates = await getEducationTemplates()

  const byType = templates.reduce<Record<string, typeof templates>>((acc, t) => {
    const key = t.script_type ?? "other"
    if (!acc[key]) acc[key] = []
    acc[key].push(t)
    return acc
  }, {})

  return (
    <div className="container mx-auto py-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Education Videos</h1>
          <p className="text-muted-foreground mt-1">
            Buyer and seller education content templates — ready to personalize and record.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/videos/create">Create Video</Link>
        </Button>
      </div>

      {Object.entries(byType).map(([scriptType, items]) => (
        <section key={scriptType} className="space-y-4">
          <h2 className="text-lg font-medium capitalize">
            {CATEGORY_LABELS[scriptType] ?? scriptType.replace(/_/g, " ")} Education
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map(template => (
              <Card key={template.id} className="flex flex-col">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base leading-snug">{template.template_name}</CardTitle>
                    <Badge variant="secondary" className="shrink-0">
                      {template.duration_seconds}s
                    </Badge>
                  </div>
                  {template.description && (
                    <CardDescription className="text-xs">{template.description}</CardDescription>
                  )}
                </CardHeader>
                <CardContent className="mt-auto pt-2">
                  <div className="flex flex-wrap gap-1 mb-3">
                    {(template.tags ?? []).map((tag: string) => (
                      <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
                    ))}
                  </div>
                  <Button asChild size="sm" className="w-full">
                    <Link
                      href={`/dashboard/videos/create?template_id=${template.id}&script_type=${template.script_type}`}
                    >
                      Use Template
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}

      {templates.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          No education templates found. Run the seed migration to populate them.
        </div>
      )}
    </div>
  )
}
