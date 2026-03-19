import { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Plus, MailOpen, Settings, AlertCircle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'

export const metadata: Metadata = {
  title: 'Newsletters | Marketing Studio',
  description: 'Create, manage, and send professional newsletters to your contacts',
}

export default async function NewslettersPage() {
  return (
    <div className="container mx-auto py-6 px-4">
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl font-bold">Newsletter Manager</h1>
          <Link href="/newsletters/templates">
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Create Campaign
            </Button>
          </Link>
        </div>
        <p className="text-muted-foreground">
          Design, schedule, and send professional newsletters to your database
        </p>
      </div>

      <Alert className="mb-6">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Newsletter features are best accessed from the Marketing Studio dashboard. 
          <Link href="/dashboard/marketing/studio" className="ml-2 font-semibold hover:underline">
            Open Marketing Studio →
          </Link>
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="setup">Setup</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Active Campaigns</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">0</div>
                <p className="text-xs text-muted-foreground mt-1">Newsletters currently sending</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Total Subscribers</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">0</div>
                <p className="text-xs text-muted-foreground mt-1">Active newsletter subscribers</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Avg. Open Rate</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">--</div>
                <p className="text-xs text-muted-foreground mt-1">Average across all campaigns</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MailOpen className="h-5 w-5" />
                Getting Started
              </CardTitle>
              <CardDescription>
                Set up your newsletter system to start engaging with contacts
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <div className="rounded-full bg-primary/10 p-2 w-8 h-8 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-semibold text-primary">1</span>
                  </div>
                  <div>
                    <p className="font-medium">Create Your First Template</p>
                    <p className="text-sm text-muted-foreground">
                      Design a professional newsletter template with your branding
                    </p>
                    <Link href="/newsletters/templates">
                      <Button variant="link" className="px-0 mt-2">
                        Go to Templates →
                      </Button>
                    </Link>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="rounded-full bg-primary/10 p-2 w-8 h-8 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-semibold text-primary">2</span>
                  </div>
                  <div>
                    <p className="font-medium">Configure Newsletter Settings</p>
                    <p className="text-sm text-muted-foreground">
                      Set up sender details, frequency, and subscriber preferences
                    </p>
                    <Link href="/newsletters/templates?tab=settings">
                      <Button variant="link" className="px-0 mt-2">
                        Configure Settings →
                      </Button>
                    </Link>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="rounded-full bg-primary/10 p-2 w-8 h-8 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-semibold text-primary">3</span>
                  </div>
                  <div>
                    <p className="font-medium">Schedule & Send Campaigns</p>
                    <p className="text-sm text-muted-foreground">
                      Create campaigns and schedule them for the right time
                    </p>
                    <Link href="/dashboard/marketing/studio">
                      <Button variant="link" className="px-0 mt-2">
                        Open Marketing Studio →
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="templates" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Newsletter Templates</CardTitle>
              <CardDescription>
                Create and manage templates for your newsletters
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-center py-8">
                <MailOpen className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground mb-4">
                  No templates yet. Create your first newsletter template to get started.
                </p>
                <Link href="/newsletters/templates">
                  <Button>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Template
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="setup" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                Newsletter Configuration
              </CardTitle>
              <CardDescription>
                Configure your newsletter system settings
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Newsletter configuration and list management is available in the full Marketing Studio.
              </p>
              <Link href="/dashboard/marketing/studio">
                <Button>
                  Open Marketing Studio
                </Button>
              </Link>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
