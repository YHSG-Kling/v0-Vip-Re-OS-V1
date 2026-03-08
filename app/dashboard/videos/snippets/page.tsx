import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { SnippetsDashboard } from "@/components/video/snippets-dashboard"
import { SnippetGenerator } from "@/components/video/snippet-generator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Scissors, Sparkles, Library } from "lucide-react"

export const metadata = {
  title: "Video Snippets | VIP Re OS",
  description: "Create and manage platform-optimized video clips",
}

export default async function VideoSnippetsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    redirect("/login")
  }

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .single()

  const brokerageId = userData?.brokerage_id

  // Get recent video projects for snippet generation
  const { data: videoProjects } = await supabase
    .from("ai_video_projects")
    .select("id, title, duration_seconds, status, video_url")
    .eq("brokerage_id", brokerageId)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(10)

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="bg-gradient-to-r from-purple-500/10 via-pink-500/5 to-background rounded-xl p-6 border">
        <h1 className="text-3xl lg:text-4xl font-bold mb-2 text-balance">Video Snippets</h1>
        <p className="text-muted-foreground text-lg">
          Create platform-optimized clips from your videos for maximum social media impact
        </p>
      </div>

      <Tabs defaultValue="library" className="space-y-6">
        <TabsList className="grid w-full grid-cols-2 gap-2 h-auto bg-muted/50 p-2 rounded-xl">
          <TabsTrigger
            value="library"
            className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-background data-[state=active]:shadow-sm"
          >
            <Library className="h-5 w-5" />
            <span className="text-xs font-medium">Snippets Library</span>
          </TabsTrigger>
          <TabsTrigger
            value="create"
            className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-background data-[state=active]:shadow-sm"
          >
            <Sparkles className="h-5 w-5" />
            <span className="text-xs font-medium">Create New</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="library">
          <SnippetsDashboard brokerageId={brokerageId} userId={user.id} />
        </TabsContent>

        <TabsContent value="create" className="space-y-6">
          {videoProjects && videoProjects.length > 0 ? (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                {videoProjects.slice(0, 4).map((project) => (
                  <SnippetGenerator
                    key={project.id}
                    videoProjectId={project.id}
                    brokerageId={brokerageId}
                    videoDuration={project.duration_seconds || 90}
                    videoTitle={project.title}
                    userId={user.id}
                    onSnippetsCreated={() => {
                      // Refresh will happen via revalidatePath
                    }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-16 border-2 border-dashed rounded-xl">
              <div className="bg-muted rounded-full p-6 w-fit mx-auto mb-4">
                <Scissors className="h-12 w-12 text-muted-foreground" />
              </div>
              <h3 className="text-xl font-semibold mb-2">No completed videos yet</h3>
              <p className="text-muted-foreground max-w-md mx-auto">
                Generate videos first, then come back here to create optimized snippets for each social platform
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
