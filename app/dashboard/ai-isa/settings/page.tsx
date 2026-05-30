'use client'

/**
 * app/dashboard/ai-isa/settings/page.tsx
 *
 * Admin/broker AI ISA settings panel.
 * Roles: broker, broker_admin, admin, superadmin.
 *
 * Surfaces:
 *   - Master enable/disable toggle
 *   - Channel authority controls per entity type (lead vs contact)
 *   - Stale/ghosted threshold controls
 *   - Max touches and cadence interval
 *   - Suppression outcome rules
 *   - Stats overview
 *   - Loading, empty, permission-denied, validation-error, success states
 */

import { useEffect, useState, useTransition } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AlertCircle, CheckCircle2, Bot, Shield, Clock, Phone, Mail, MessageSquare, Home, Users, TrendingDown } from 'lucide-react'
import { getAIISASettings, saveAIISASettings, getAIISAStats } from '@/app/actions/ai-isa-settings'
import type { AIISASettings } from '@/lib/ai-isa/settings-types'
import { getAgentContext } from '@/lib/identity/get-agent-context'
import { createClient } from '@/lib/supabase/client'

const WRITE_ROLES = new Set(['broker', 'broker_admin', 'admin', 'superadmin'])

const ALL_CONTACT_CHANNELS = [
  { key: 'email',        label: 'Email',       Icon: Mail },
  { key: 'sms',          label: 'SMS',         Icon: MessageSquare },
  { key: 'phone',        label: 'Phone',       Icon: Phone },
  { key: 'direct_mail',  label: 'Direct Mail', Icon: Home },
] as const

const LEAD_CHANNELS = [
  { key: 'email',       label: 'Email',       Icon: Mail },
  { key: 'direct_mail', label: 'Direct Mail', Icon: Home },
] as const

const OUTCOME_OPTIONS = [
  'not_interested',
  'do_not_contact',
  'do_not_call',
  'wrong_number',
  'bad_contact_data',
  'ghosted',
]

export default function AIISASettingsPage() {
  const [brokerageId, setBrokerageId]   = useState<string | null>(null)
  const [role, setRole]                 = useState<string | null>(null)
  const [settings, setSettings]         = useState<AIISASettings | null>(null)
  const [stats, setStats]               = useState<Awaited<ReturnType<typeof getAIISAStats>> | null>(null)
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState<string | null>(null)
  const [success, setSuccess]           = useState(false)
  const [isPending, startTransition]    = useTransition()

  // ── Load identity + settings ─────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setError('Not authenticated'); setLoading(false); return }

      const { data: profile } = await supabase
        .from('users')
        .select('brokerage_id, user_type')
        .eq('id', user.id)
        .maybeSingle()

      const bid  = profile?.brokerage_id ?? null
      const r    = profile?.user_type ?? null
      setBrokerageId(bid)
      setRole(r)

      if (!bid) { setError('No brokerage configured'); setLoading(false); return }

      const [cfg, kpis] = await Promise.all([
        getAIISASettings(bid),
        getAIISAStats(bid),
      ])
      setSettings(cfg)
      setStats(kpis)
      setLoading(false)
    }
    load()
  }, [])

  const canWrite = role ? WRITE_ROLES.has(role) : false

  function patchSettings(partial: Partial<AIISASettings>) {
    setSettings(prev => prev ? { ...prev, ...partial } : prev)
  }

  function handleSave() {
    if (!brokerageId || !settings) return
    setError(null)
    setSuccess(false)

    // Validation
    if (settings.stale_threshold_days < 1 || settings.ghosted_threshold_days < 1) {
      setError('Threshold days must be at least 1.')
      return
    }
    if (settings.max_touches_lead < 1 || settings.max_touches_contact < 1) {
      setError('Max touches must be at least 1.')
      return
    }
    if (settings.touch_interval_days < 1) {
      setError('Touch interval must be at least 1 day.')
      return
    }

    startTransition(async () => {
      const result = await saveAIISASettings(brokerageId, settings)
      if (!result.success) {
        setError(result.error ?? 'Failed to save settings.')
      } else {
        setSuccess(true)
        setTimeout(() => setSuccess(false), 4000)
      }
    })
  }

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="p-8 space-y-4 max-w-3xl">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  // ── Permission denied ─────────────────────────────────────────────────────
  if (!brokerageId) {
    return (
      <div className="p-8 max-w-3xl">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error ?? 'You do not have access to AI ISA settings.'}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="p-8 max-w-3xl">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Failed to load AI ISA settings.</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl font-sans">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Bot className="h-6 w-6 text-primary" />
            AI ISA Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure autonomous engagement behavior, channel authority, and suppression rules.
          </p>
        </div>
        {!canWrite && (
          <Badge variant="outline" className="text-xs">
            <Shield className="h-3 w-3 mr-1" />
            View only
          </Badge>
        )}
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Active Contacts', value: stats.activeContactCount,      icon: Users },
            { label: 'Stale Contacts',  value: stats.staleContactCount,       icon: Clock },
            { label: 'Handoffs Needed', value: stats.handoffRequiredCount,    icon: TrendingDown },
            { label: 'Active Leads',    value: stats.activeLeadCount,         icon: Bot },
            { label: 'Outreach (30d)', value: stats.outreachLast30Days,      icon: Mail },
            { label: 'Neg. Outcomes',  value: stats.negativeOutcomeLast30Days, icon: AlertCircle },
          ].map(({ label, value, icon: Icon }) => (
            <Card key={label} className="p-3">
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
              <p className="text-2xl font-bold mt-1">{value}</p>
            </Card>
          ))}
        </div>
      )}

      {/* Master toggle */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Master Control</CardTitle>
          <CardDescription>Enable or disable AI ISA for the entire brokerage.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              checked={settings.enabled}
              onCheckedChange={(v) => patchSettings({ enabled: v })}
              disabled={!canWrite}
            />
            <span className="text-sm font-medium">{settings.enabled ? 'AI ISA is active' : 'AI ISA is paused'}</span>
          </div>
        </CardContent>
      </Card>

      {/* Channel authority */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Channel Authority</CardTitle>
          <CardDescription>
            Leads (no TCPA): only email and direct mail are ever permitted.
            Contacts with consent may use all enabled channels.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <p className="text-sm font-medium mb-2">Lead channels (unconsented)</p>
            <div className="flex gap-4">
              {LEAD_CHANNELS.map(({ key, label, Icon }) => (
                <div key={key} className="flex items-center gap-2">
                  <Checkbox
                    checked={settings.lead_allowed_channels.includes(key as any)}
                    onCheckedChange={(checked) => {
                      const current = settings.lead_allowed_channels
                      patchSettings({
                        lead_allowed_channels: checked
                          ? [...current, key as any]
                          : current.filter((c) => c !== key),
                      })
                    }}
                    disabled={!canWrite}
                  />
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <Label className="text-sm">{label}</Label>
                </div>
              ))}
            </div>
          </div>

          <Separator />

          <div>
            <p className="text-sm font-medium mb-2">Contact channels (with consent)</p>
            <div className="flex flex-wrap gap-4">
              {ALL_CONTACT_CHANNELS.map(({ key, label, Icon }) => (
                <div key={key} className="flex items-center gap-2">
                  <Checkbox
                    checked={settings.contact_allowed_channels.includes(key as any)}
                    onCheckedChange={(checked) => {
                      const current = settings.contact_allowed_channels
                      patchSettings({
                        contact_allowed_channels: checked
                          ? [...current, key as any]
                          : current.filter((c) => c !== key),
                      })
                    }}
                    disabled={!canWrite}
                  />
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <Label className="text-sm">{label}</Label>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Thresholds */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Detection Thresholds</CardTitle>
          <CardDescription>Controls when contacts are flagged as stale or ghosted.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-sm">Stale threshold (days)</Label>
            <Input
              type="number"
              min={1}
              value={settings.stale_threshold_days}
              onChange={(e) => patchSettings({ stale_threshold_days: parseInt(e.target.value) || 14 })}
              disabled={!canWrite}
              className="h-8"
            />
            <p className="text-xs text-muted-foreground">Days with no contact before stale flag.</p>
          </div>
          <div className="space-y-1">
            <Label className="text-sm">Ghosted threshold (days)</Label>
            <Input
              type="number"
              min={1}
              value={settings.ghosted_threshold_days}
              onChange={(e) => patchSettings({ ghosted_threshold_days: parseInt(e.target.value) || 21 })}
              disabled={!canWrite}
              className="h-8"
            />
            <p className="text-xs text-muted-foreground">Days after outreach with no reply before ghosted.</p>
          </div>
          <div className="space-y-1">
            <Label className="text-sm">Max touches (leads)</Label>
            <Input
              type="number"
              min={1}
              value={settings.max_touches_lead}
              onChange={(e) => patchSettings({ max_touches_lead: parseInt(e.target.value) || 5 })}
              disabled={!canWrite}
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-sm">Max touches (contacts)</Label>
            <Input
              type="number"
              min={1}
              value={settings.max_touches_contact}
              onChange={(e) => patchSettings({ max_touches_contact: parseInt(e.target.value) || 8 })}
              disabled={!canWrite}
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-sm">Touch interval (days)</Label>
            <Input
              type="number"
              min={1}
              value={settings.touch_interval_days}
              onChange={(e) => patchSettings({ touch_interval_days: parseInt(e.target.value) || 3 })}
              disabled={!canWrite}
              className="h-8"
            />
            <p className="text-xs text-muted-foreground">Minimum days between AI ISA touches.</p>
          </div>
        </CardContent>
      </Card>

      {/* Handoff + automation */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Handoff and Automation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label className="text-sm">Default handoff action</Label>
            <Select
              value={settings.default_handoff_action}
              onValueChange={(v) => patchSettings({ default_handoff_action: v as any })}
              disabled={!canWrite}
            >
              <SelectTrigger className="h-8 w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="notify_agent">Notify agent only</SelectItem>
                <SelectItem value="create_task">Create task only</SelectItem>
                <SelectItem value="both">Notify agent + create task</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-3">
            <Switch
              checked={settings.auto_enable_on_new_contacts}
              onCheckedChange={(v) => patchSettings({ auto_enable_on_new_contacts: v })}
              disabled={!canWrite}
            />
            <Label className="text-sm">Auto-enable AI ISA on newly captured contacts</Label>
          </div>

          <div className="flex items-center gap-3">
            <Switch
              checked={settings.pause_on_agent_assigned}
              onCheckedChange={(v) => patchSettings({ pause_on_agent_assigned: v })}
              disabled={!canWrite}
            />
            <Label className="text-sm">Pause AI ISA when agent is assigned to contact</Label>
          </div>
        </CardContent>
      </Card>

      {/* Suppression outcomes */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Suppression Rules</CardTitle>
          <CardDescription>
            When a contact or lead receives one of these outcomes, AI ISA stops automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {OUTCOME_OPTIONS.map((outcome) => (
              <div key={outcome} className="flex items-center gap-2">
                <Checkbox
                  checked={settings.suppress_on_outcomes.includes(outcome)}
                  onCheckedChange={(checked) => {
                    const current = settings.suppress_on_outcomes
                    patchSettings({
                      suppress_on_outcomes: checked
                        ? [...current, outcome]
                        : current.filter((o) => o !== outcome),
                    })
                  }}
                  disabled={!canWrite}
                />
                <Label className="text-sm capitalize">{outcome.replace(/_/g, ' ')}</Label>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Validation / feedback */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {success && (
        <Alert className="border-green-200 bg-green-50">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-800">Settings saved successfully.</AlertDescription>
        </Alert>
      )}

      {/* Save */}
      {canWrite && (
        <Button onClick={handleSave} disabled={isPending} className="w-full sm:w-auto">
          {isPending ? 'Saving...' : 'Save Settings'}
        </Button>
      )}
    </div>
  )
}
