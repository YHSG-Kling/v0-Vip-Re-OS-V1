"use client"

import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  ArrowLeft, Search, MessageCircle, Phone, Mail, FileText, HelpCircle,
  ExternalLink, ShieldCheck, BookOpen, Users, ThumbsUp, Clock, Plus,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  searchHelp, getHelpArticle, voteArticleHelpful, createSupportTicket,
  TICKET_CATEGORIES, TICKET_PRIORITIES,
  type HelpArticle, type SupportTicket,
} from "@/app/actions/support"

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  open: { label: "Open", className: "bg-blue-100 text-blue-700 border-blue-200" },
  in_progress: { label: "In Progress", className: "bg-amber-100 text-amber-700 border-amber-200" },
  resolved: { label: "Resolved", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  closed: { label: "Closed", className: "bg-gray-100 text-gray-600 border-gray-200" },
}

const EXTERNAL_RESOURCES = [
  { href: "https://www.nar.realtor/", title: "NAR Resources", desc: "National Association of Realtors", icon: FileText },
  { href: "https://www.consumerfinance.gov/owning-a-home/", title: "CFPB Guidelines", desc: "Consumer Financial Protection", icon: ShieldCheck },
  { href: "https://www.hud.gov/topics/fair_housing", title: "Fair Housing", desc: "HUD Fair Housing Resources", icon: Users },
  { href: "https://www.realtor.com/advice/", title: "Market Insights", desc: "Real estate news and advice", icon: BookOpen },
]

export function HelpCenterClient({
  brokerageName, supportEmail, supportPhone, initialArticles, initialTickets,
}: {
  brokerageName: string | null
  supportEmail: string | null
  supportPhone: string | null
  initialArticles: HelpArticle[]
  initialTickets: SupportTicket[]
}) {
  const { toast } = useToast()
  const [query, setQuery] = useState("")
  const [articles, setArticles] = useState<HelpArticle[]>(initialArticles)
  const [searching, setSearching] = useState(false)
  const [tickets, setTickets] = useState<SupportTicket[]>(initialTickets)

  // Article reader dialog
  const [openArticle, setOpenArticle] = useState<{ title: string; content: string } | null>(null)
  const [activeArticleId, setActiveArticleId] = useState<string | null>(null)

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setSearching(true)
    try { setArticles(await searchHelp(query)) } finally { setSearching(false) }
  }

  async function openHelp(a: HelpArticle) {
    const full = await getHelpArticle(a.id, a.source)
    if (!full) { toast({ title: "Unavailable", description: "That article could not be opened.", variant: "destructive" }); return }
    setOpenArticle({ title: full.title, content: full.content })
    setActiveArticleId(a.source === "article" ? a.id : null)
  }

  async function vote(helpful: boolean) {
    if (!activeArticleId) return
    await voteArticleHelpful(activeArticleId, helpful)
    toast({ title: "Thanks for the feedback" })
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-4">
          <Link href="/dashboard">
            <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-2" />Back to Dashboard</Button>
          </Link>
          <div className="h-8 w-px bg-border" />
          <div>
            <h1 className="text-2xl font-bold">Help & Support</h1>
            <p className="text-sm text-muted-foreground">Search help articles or raise a support ticket</p>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <Tabs defaultValue="help" className="space-y-6">
          <TabsList>
            <TabsTrigger value="help" className="gap-1"><HelpCircle className="h-4 w-4" />Help Center</TabsTrigger>
            <TabsTrigger value="tickets" className="gap-1"><MessageCircle className="h-4 w-4" />My Tickets {tickets.length > 0 && `(${tickets.length})`}</TabsTrigger>
          </TabsList>

          {/* ── HELP CENTER ── */}
          <TabsContent value="help" className="space-y-6">
            <Card>
              <CardContent className="pt-6">
                <form onSubmit={handleSearch} className="relative flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input placeholder="Search for help topics..." className="pl-10" value={query} onChange={(e) => setQuery(e.target.value)} />
                  </div>
                  <Button type="submit" disabled={searching}>{searching ? "Searching…" : "Search"}</Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><BookOpen className="h-5 w-5" />Help Articles</CardTitle>
                <CardDescription>{articles.length} article{articles.length === 1 ? "" : "s"} from your brokerage's knowledge base</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {articles.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No help articles found{query ? ` for "${query}"` : ""}. Try a different search or raise a ticket below.
                  </p>
                ) : (
                  articles.map((a) => (
                    <button
                      key={`${a.source}-${a.id}`}
                      onClick={() => openHelp(a)}
                      className="w-full text-left p-4 rounded-lg border hover:bg-accent/50 transition-colors flex items-start gap-3"
                    >
                      <div className="p-2 rounded-lg bg-primary/10"><FileText className="h-4 w-4 text-primary" /></div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{a.title}</span>
                          {a.category && <Badge variant="secondary" className="text-xs">{a.category}</Badge>}
                        </div>
                        {a.excerpt && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{a.excerpt}</p>}
                      </div>
                      {a.helpfulCount > 0 && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground"><ThumbsUp className="h-3 w-3" />{a.helpfulCount}</span>
                      )}
                    </button>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="bg-primary/5 border-primary/20">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><MessageCircle className="h-5 w-5 text-primary" />Still need help?</CardTitle>
                <CardDescription>Reach {brokerageName || "your brokerage"} support directly, or raise a ticket from the My Tickets tab.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-4">
                {supportPhone && (
                  <a href={`tel:${supportPhone}`}><Button variant="outline"><Phone className="h-4 w-4 mr-2" />{supportPhone}</Button></a>
                )}
                {supportEmail && (
                  <a href={`mailto:${supportEmail}`}><Button variant="outline"><Mail className="h-4 w-4 mr-2" />{supportEmail}</Button></a>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Industry Resources</CardTitle>
                <CardDescription>Helpful external references</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {EXTERNAL_RESOURCES.map((r) => {
                  const Icon = r.icon
                  return (
                    <a key={r.href} href={r.href} target="_blank" rel="noopener noreferrer"
                       className="flex items-center gap-3 p-4 rounded-lg border hover:bg-accent/50 transition-colors">
                      <div className="p-2 rounded-lg bg-muted"><Icon className="h-4 w-4" /></div>
                      <div className="flex-1"><p className="font-medium">{r.title}</p><p className="text-sm text-muted-foreground">{r.desc}</p></div>
                      <ExternalLink className="h-4 w-4 text-muted-foreground" />
                    </a>
                  )
                })}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── MY TICKETS ── */}
          <TabsContent value="tickets" className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">My Support Tickets</h2>
                <p className="text-sm text-muted-foreground">Track requests you've raised with support.</p>
              </div>
              <NewTicketDialog onCreated={(t) => setTickets((cur) => [t, ...cur])} />
            </div>

            {tickets.length === 0 ? (
              <Card><CardContent className="py-10 text-center text-muted-foreground">
                You haven't raised any tickets yet.
              </CardContent></Card>
            ) : (
              <div className="space-y-2">
                {tickets.map((t) => {
                  const badge = STATUS_BADGE[t.status] ?? STATUS_BADGE.open
                  return (
                    <Card key={t.id}>
                      <CardContent className="py-4 flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{t.subject}</span>
                            {t.category && <Badge variant="secondary" className="text-xs">{t.category}</Badge>}
                            <Badge variant="outline" className="text-xs capitalize">{t.priority}</Badge>
                          </div>
                          {t.description && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{t.description}</p>}
                          <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                            <Clock className="h-3 w-3" />{new Date(t.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <Badge className={badge.className}>{badge.label}</Badge>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Article reader */}
      <Dialog open={!!openArticle} onOpenChange={(o) => !o && setOpenArticle(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{openArticle?.title}</DialogTitle></DialogHeader>
          <div className="prose prose-sm max-w-none whitespace-pre-wrap leading-relaxed">{openArticle?.content}</div>
          {activeArticleId && (
            <DialogFooter className="sm:justify-start gap-2">
              <span className="text-sm text-muted-foreground self-center">Was this helpful?</span>
              <Button variant="outline" size="sm" onClick={() => vote(true)}><ThumbsUp className="h-4 w-4 mr-1" />Yes</Button>
              <Button variant="outline" size="sm" onClick={() => vote(false)}>No</Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function NewTicketDialog({ onCreated }: { onCreated: (t: SupportTicket) => void }) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState<string>("general")
  const [priority, setPriority] = useState<string>("medium")
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    if (!subject.trim()) { toast({ title: "Subject required", variant: "destructive" }); return }
    setSubmitting(true)
    try {
      const r = await createSupportTicket({ subject, description, category, priority: priority as (typeof TICKET_PRIORITIES)[number] })
      if (!r.ok) { toast({ title: "Could not create ticket", description: r.error, variant: "destructive" }); return }
      onCreated({
        id: r.id, subject: subject.trim(), description: description.trim() || null,
        status: "open", priority, category, agentId: null,
        createdAt: new Date().toISOString(), updatedAt: null,
      })
      toast({ title: "Ticket raised", description: "Support will follow up with you." })
      setSubject(""); setDescription(""); setCategory("general"); setPriority("medium"); setOpen(false)
    } finally { setSubmitting(false) }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-2" />New Ticket</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Raise a support ticket</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="t-subject">Subject</Label>
            <Input id="t-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Brief summary of the issue" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TICKET_CATEGORIES.map((c) => <SelectItem key={c} value={c} className="capitalize">{c.replace("_", " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TICKET_PRIORITIES.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="t-desc">Description</Label>
            <Textarea id="t-desc" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's happening? Include any steps to reproduce." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>{submitting ? "Submitting…" : "Submit Ticket"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
