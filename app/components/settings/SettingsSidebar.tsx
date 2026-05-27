'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth/client';

// personal: every tier (solo agents too); brokerage: admin/broker/superadmin only.
const menuItems: Array<{ label: string; href: string; personal: boolean }> = [
  { label: 'Dashboard', href: '/settings', personal: true },
  { label: 'General', href: '/settings/general', personal: true },
  { label: 'Integrations', href: '/settings/integrations', personal: true },
  { label: 'CRM Sync', href: '/settings/crm', personal: true },
  { label: 'Phone / SMS', href: '/settings/phone', personal: true },
  { label: 'Brand Voice', href: '/settings/brand-voice', personal: true },
  { label: 'Branding', href: '/settings/branding', personal: true },
  { label: 'Email Templates', href: '/settings/email-templates', personal: true },
  { label: 'Notifications', href: '/settings/notifications', personal: true },
  { label: 'Commission', href: '/settings/commission', personal: false },
  { label: 'Providers', href: '/settings/providers', personal: false },
  { label: 'Users', href: '/settings/users', personal: false },
];

export function SettingsSidebar() {
  const pathname = usePathname();
  const { userContext } = useAuth();
  const isBrokerageRole = !!userContext?.roles.some((r) => ['admin', 'broker', 'superadmin'].includes(r));
  const items = menuItems.filter((i) => i.personal || isBrokerageRole);

  return (
    <aside className="w-64 bg-white border-r border-gray-200 h-full">
      <div className="px-6 py-6 border-b border-gray-200">
        <h1 className="text-xl font-bold text-gray-900">Settings</h1>
      </div>
      <nav className="p-4">
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`block px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  pathname === item.href
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
