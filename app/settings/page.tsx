'use client';

import React from 'react';
import Link from 'next/link';
import {
  Settings as SettingsIcon,
  Palette,
  DollarSign,
  Mail,
  Bell,
  Plug,
  Layers,
  SlidersHorizontal,
  Film,
  Sparkles,
  ChevronRight,
} from 'lucide-react';

type Tile = {
  href: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string; // tailwind text/bg accent for the icon chip
};

// Same destinations as before — richer, scannable presentation.
const TILES: Tile[] = [
  { href: '/settings/general', title: 'General', description: 'Brokerage name, time zone, and date format', icon: SettingsIcon, accent: 'text-slate-600 bg-slate-100' },
  { href: '/settings/branding', title: 'Branding', description: 'Colors, fonts, logos, and your public website', icon: Palette, accent: 'text-fuchsia-600 bg-fuchsia-100' },
  { href: '/settings/commission', title: 'Commissions', description: 'Split and revenue-share structures', icon: DollarSign, accent: 'text-emerald-600 bg-emerald-100' },
  { href: '/settings/email-templates', title: 'Email Templates', description: 'Reusable content for outgoing email', icon: Mail, accent: 'text-blue-600 bg-blue-100' },
  { href: '/settings/notifications', title: 'Notifications', description: 'Which events notify whom, and on what channel', icon: Bell, accent: 'text-amber-600 bg-amber-100' },
  { href: '/settings/integrations', title: 'Integrations', description: 'Connect your CRM, IDX, social, and more', icon: Plug, accent: 'text-cyan-600 bg-cyan-100' },
  { href: '/settings/campaign-bundles', title: 'Campaign Bundles', description: 'Compose presets into coordinated multi-channel dispatches', icon: Layers, accent: 'text-indigo-600 bg-indigo-100' },
  { href: '/settings/channel-presets', title: 'Channel Presets', description: 'Locked creative per channel — email, SMS, social, ads, portal', icon: SlidersHorizontal, accent: 'text-violet-600 bg-violet-100' },
  { href: '/dashboard/settings/stock-library', title: 'Stock Library', description: 'Intros, outros, B-roll, and music for your videos', icon: Film, accent: 'text-rose-600 bg-rose-100' },
  { href: '/dashboard/settings/twin-studio', title: 'AI Avatar & Voice', description: 'Your on-camera avatar and cloned voice in Twin Studio', icon: Sparkles, accent: 'text-purple-600 bg-purple-100' },
];

export default function SettingsDashboard() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-600 mt-2">
          Configure your brokerage — identity, money, communication, campaigns, and AI media.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {TILES.map(({ href, title, description, icon: Icon, accent }) => (
          <Link
            key={href}
            href={href}
            className="group relative flex items-start gap-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-all hover:border-blue-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <span className={`shrink-0 grid place-items-center h-10 w-10 rounded-lg ${accent}`}>
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 pr-5">
              <h2 className="font-semibold text-gray-900">{title}</h2>
              <p className="text-sm text-gray-600 mt-0.5 leading-snug">{description}</p>
            </div>
            <ChevronRight className="absolute right-4 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-300 transition-colors group-hover:text-blue-400" />
          </Link>
        ))}
      </div>
    </div>
  );
}
