import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Scissors, Sparkles, Library } from "lucide-react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"

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

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="bg-purple-100 rounded-lg p-2">
            <Scissors className="h-6 w-6 text-purple-600" />
          </div>
          <h1 className="text-3xl font-bold">Video Snippets</h1>
        </div>
        <p className="text-muted-foreground">
          Create platform-optimized clips from your videos to repurpose across social media
        </p>
      </div>

      {/* Coming Soon Alert */}
      <Alert className="border-purple-500 bg-purple-50">
        <Sparkles className="h-4 w-4 text-purple-600" />
        <AlertDescription className="text-purple-900">
          Snippet management is currently being configured. The full feature will be available soon with support for
          Instagram Reels, TikTok, YouTube Shorts, LinkedIn, and more.
        </AlertDescription>
      </Alert>

      {/* Main Content */}
      <Tabs defaultValue="library" className="space-y-6">
        <TabsList className="grid w-full grid-cols-2 bg-muted/50 p-2 rounded-xl">
          <TabsTrigger value="library" className="flex items-center gap-2 data-[state=active]:bg-background">
            <Library className="h-4 w-4" />
            Snippet Library
          </TabsTrigger>
          <TabsTrigger value="create" className="flex items-center gap-2 data-[state=active]:bg-background">
            <Scissors className="h-4 w-4" />
            Create Snippet
          </TabsTrigger>
        </TabsList>

        <TabsContent value="library">
          <Card>
            <CardHeader className="bg-muted/30">
              <CardTitle className="flex items-center gap-2">
                <Library className="h-5 w-5" />
                Your Snippets
              </CardTitle>
              <CardDescription>Approved video clips ready to publish</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="text-center py-16 border-2 border-dashed rounded-xl">
                <div className="bg-muted rounded-full p-6 w-fit mx-auto mb-4">
                  <Library className="h-12 w-12 text-muted-foreground" />
                </div>
                <h3 className="text-xl font-semibold mb-2">No snippets yet</h3>
                <p className="text-muted-foreground max-w-md mx-auto leading-relaxed mb-4">
                  Create your first snippet to see it here
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="create">
          <Card>
            <CardHeader className="bg-muted/30">
              <CardTitle className="flex items-center gap-2">
                <Scissors className="h-5 w-5" />
                Create New Snippet
              </CardTitle>
              <CardDescription>Extract and optimize a clip from your video</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="text-center py-16 border-2 border-dashed rounded-xl">
                <div className="bg-muted rounded-full p-6 w-fit mx-auto mb-4">
                  <Scissors className="h-12 w-12 text-muted-foreground" />
                </div>
                <h3 className="text-xl font-semibold mb-2">Create Snippet</h3>
                <p className="text-muted-foreground max-w-md mx-auto leading-relaxed mb-4">
                  Start by selecting a video from your library and choosing the section you want to repurpose
                </p>
                <Button disabled>Coming Soon</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
