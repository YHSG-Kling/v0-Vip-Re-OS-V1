'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const menuItems = [
  { label: 'Dashboard', href: '/settings' },
  { label: 'General', href: '/settings/general' },
  { label: 'Branding', href: '/settings/branding' },
  { label: 'Commission', href: '/settings/commission' },
  { label: 'Email Templates', href: '/settings/email-templates' },
  { label: 'Notifications', href: '/settings/notifications' },
  { label: 'Integrations', href: '/settings/integrations' },
  { label: 'Providers', href: '/settings/providers' },
  { label: 'Users', href: '/settings/users' },
];

export function SettingsSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-white border-r border-gray-200 h-full">
      <div className="px-6 py-6 border-b border-gray-200">
        <h1 className="text-xl font-bold text-gray-900">Settings</h1>
      </div>
      <nav className="p-4">
        <ul className="space-y-2">
          {menuItems.map((item) => (
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
