import { createClient } from '@/lib/supabase/server'
import { getAgentContext } from '@/lib/identity'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  ArrowLeft,
  Search,
  MessageCircle,
  Phone,
  Mail,
  FileText,
  HelpCircle,
  ExternalLink,
  Users,
  BarChart3,
  Settings,
  ShieldCheck,
  Zap,
  BookOpen,
  Video,
  Headphones,
} from 'lucide-react'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Help & Support | Dashboard',
  description: 'Get help and support for using the dashboard',
}

export default async function DashboardHelpPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect('/login')

  const supabase = await createClient()

  // Fetch agent's brokerage info for support contact details
  const { data: brokerage } = await supabase
    .from('brokerages')
    .select('name, support_email:email, support_phone:phone')
    .eq('id', ctx.brokerageId ?? '')
    .single()

  const faqs = [
    {
      icon: Users,
      question: 'How do I manage my contacts?',
      answer:
        'Navigate to the Contacts section to view, add, and manage your leads and clients. You can filter by stage, search by name, and bulk-update contact information.',
    },
    {
      icon: BarChart3,
      question: 'Where can I see my performance metrics?',
      answer:
        'Your Dashboard home shows key metrics including active deals, pending tasks, and pipeline value. For detailed analytics, visit the Reports section.',
    },
    {
      icon: FileText,
      question: 'How do I upload and manage documents?',
      answer:
        'Documents can be uploaded in the Documents section or attached directly to transactions. All files are automatically organized by transaction and client.',
    },
    {
      icon: Settings,
      question: 'How do I update my profile and settings?',
      answer:
        'Click on Settings in the navigation to update your profile information, notification preferences, and account settings.',
    },
    {
      icon: ShieldCheck,
      question: 'How does compliance tracking work?',
      answer:
        'The system automatically tracks compliance requirements for each transaction. You\'ll receive alerts for missing documents or upcoming deadlines.',
    },
    {
      icon: Zap,
      question: 'Can I automate repetitive tasks?',
      answer:
        'Yes! Check out Automations in your settings to set up automatic follow-ups, task assignments, and notifications based on triggers you define.',
    },
  ]

  const resources = [
    {
      icon: BookOpen,
      title: 'Getting Started Guide',
      description: 'Learn the basics of the platform',
      href: '/dashboard/help/getting-started',
      color: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
    },
    {
      icon: Video,
      title: 'Video Tutorials',
      description: 'Watch step-by-step walkthroughs',
      href: '/dashboard/help/tutorials',
      color: 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400',
    },
    {
      icon: FileText,
      title: 'Best Practices',
      description: 'Tips from top-performing agents',
      href: '/dashboard/help/best-practices',
      color: 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400',
    },
    {
      icon: Headphones,
      title: 'Live Support',
      description: 'Chat with our support team',
      href: '/dashboard/help/support',
      color: 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
    },
  ]

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center gap-4">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Dashboard
              </Button>
            </Link>
            <div className="h-8 w-px bg-border" />
            <div>
              <h1 className="text-2xl font-bold">Help & Support</h1>
              <p className="text-sm text-muted-foreground">Find answers and get assistance</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* Search */}
        <Card>
          <CardContent className="pt-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search for help topics..." className="pl-10" />
            </div>
          </CardContent>
        </Card>

        {/* Quick Resources */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {resources.map((resource) => {
            const Icon = resource.icon
            return (
              <Link key={resource.title} href={resource.href}>
                <Card className="h-full hover:border-primary/50 transition-colors cursor-pointer">
                  <CardContent className="pt-6">
                    <div className={`w-10 h-10 rounded-lg ${resource.color} flex items-center justify-center mb-3`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="font-semibold mb-1">{resource.title}</h3>
                    <p className="text-sm text-muted-foreground">{resource.description}</p>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>

        {/* Contact Support */}
        <Card className="bg-primary/5 border-primary/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-primary" />
              Contact Support
            </CardTitle>
            <CardDescription>
              Get help from {brokerage?.name || 'your brokerage'} support team
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4">
              <Button variant="default">
                <MessageCircle className="h-4 w-4 mr-2" />
                Open Support Chat
              </Button>
              <Button variant="outline">
                <Phone className="h-4 w-4 mr-2" />
                {brokerage?.support_phone || '(800) 555-0199'}
              </Button>
              <Button variant="outline">
                <Mail className="h-4 w-4 mr-2" />
                {brokerage?.support_email || 'support@realestate.com'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* FAQs */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HelpCircle className="h-5 w-5" />
              Frequently Asked Questions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {faqs.map((faq, index) => {
              const Icon = faq.icon
              return (
                <div
                  key={index}
                  className="p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    <div className="space-y-1">
                      <h3 className="font-medium">{faq.question}</h3>
                      <p className="text-sm text-muted-foreground">{faq.answer}</p>
                    </div>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>

        {/* External Resources */}
        <Card>
          <CardHeader>
            <CardTitle>Industry Resources</CardTitle>
            <CardDescription>Helpful external links and references</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <a
                href="https://www.nar.realtor/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-4 rounded-lg border hover:bg-accent/50 transition-colors"
              >
                <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                  <FileText className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="flex-1">
                  <p className="font-medium">NAR Resources</p>
                  <p className="text-sm text-muted-foreground">National Association of Realtors</p>
                </div>
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
              </a>

              <a
                href="https://www.consumerfinance.gov/owning-a-home/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-4 rounded-lg border hover:bg-accent/50 transition-colors"
              >
                <div className="p-2 rounded-lg bg-green-100 dark:bg-green-900/30">
                  <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
                </div>
                <div className="flex-1">
                  <p className="font-medium">CFPB Guidelines</p>
                  <p className="text-sm text-muted-foreground">Consumer Financial Protection</p>
                </div>
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
              </a>

              <a
                href="https://www.hud.gov/topics/fair_housing"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-4 rounded-lg border hover:bg-accent/50 transition-colors"
              >
                <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-900/30">
                  <Users className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                </div>
                <div className="flex-1">
                  <p className="font-medium">Fair Housing</p>
                  <p className="text-sm text-muted-foreground">HUD Fair Housing Resources</p>
                </div>
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
              </a>

              <a
                href="https://www.realtor.com/advice/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-4 rounded-lg border hover:bg-accent/50 transition-colors"
              >
                <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900/30">
                  <BookOpen className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="flex-1">
                  <p className="font-medium">Market Insights</p>
                  <p className="text-sm text-muted-foreground">Real estate news and advice</p>
                </div>
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
              </a>
            </div>
          </CardContent>
        </Card>

        {/* Emergency Contact */}
        <Card className="border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20">
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-full bg-amber-100 dark:bg-amber-900/50">
                <Phone className="h-6 w-6 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <p className="font-medium">Need Urgent Technical Support?</p>
                <p className="text-sm text-muted-foreground">
                  Call our 24/7 support line: <strong>(800) 555-HELP</strong>
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  For critical system issues and account lockouts
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
