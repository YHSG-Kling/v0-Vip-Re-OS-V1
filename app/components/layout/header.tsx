'use client'

// WAVE 151 (lane 151B — directive §151B "User types and navigation invariants": "The command-center header/global navigation
// must expose Transactions to appropriately authorized users"). The header carries a Transactions shortcut DERIVED from the
// role's own navigation (app/config/navigation-config.ts NAVIGATION_BY_ROLE → NavigationConfig.sidebarItems): the first item
// whose id is `transactions` or whose href is a transactions surface (/dashboard/transactions, /transaction/deals, a partner
// portal's assigned transactions). No second roster of "who may see deals" is spelled here — a role the navigation does not
// hand a transactions page (contact, vendor) gets no shortcut, and a role it does (agent, broker, team lead, admin, TC,
// compliance officer, the lender / title partner) gets exactly the page it already owns. The database decides the rows
// (transactions RLS: agent_read_own / team_leader_read_team / transactions_brokerage_staff_read / vendor_scoped_read).
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { NavigationConfig, NavItem } from '@/app/types/navigation'
import { UserContext } from '@/app/types/roles'
import { GlobalSearch } from './global-search'
import { UserMenu } from './user-menu'
import { NotificationBell } from './notification-bell'
import { Menu, Inbox, Sparkles, FileText } from 'lucide-react'
import { useShell } from './shell-context'

interface HeaderProps {
  navigation: NavigationConfig
  userContext: UserContext
}

/** A transactions surface, by href — the three spellings the navigation config carries (the title partner's deals surface is
 *  Title Orders, /title/orders — an order book, not a transactions page, so it is deliberately not one of them). */
const TRANSACTIONS_HREF = /(^|\/)(dashboard\/transactions|transaction\/deals|lender\/transactions)(\/|\?|$)/

/** PURE. The role's Transactions entry, from its own sidebar (children included) — null when the role has none.
 *  Module-local: the header is its one reader; scripts/access-matrix-guard.ts mirrors the href rule and asserts it verbatim. */
function findTransactionsNavItem(items: readonly NavItem[] | undefined): NavItem | null {
  for (const item of items ?? []) {
    if (item.href && (item.id === 'transactions' || TRANSACTIONS_HREF.test(item.href))) return item
    const inChildren = findTransactionsNavItem(item.children)
    if (inChildren) return inChildren
  }
  return null
}

export function Header({ navigation, userContext }: HeaderProps) {
  const { toggleInbox, toggleAiAssistant, toggleMobileSidebar } = useShell()
  const transactions = findTransactionsNavItem(navigation?.sidebarItems)

  return (
    <header className="border-b border-gray-200 bg-white h-16 flex items-center justify-between px-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={toggleMobileSidebar}
          aria-label="Toggle navigation"
        >
          <Menu className="w-5 h-5 text-gray-700" />
        </Button>
      </div>
      <div className="flex-1 max-w-md">
        <GlobalSearch />
      </div>
      <div className="flex items-center gap-1">
        {transactions?.href && (
          <Link
            href={transactions.href}
            title={`${transactions.label ?? 'Transactions'} · your deals`}
            aria-label={transactions.label ?? 'Transactions'}
            data-header-transactions
            className="hidden sm:inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900"
          >
            <FileText className="w-4 h-4" aria-hidden />
            <span>{transactions.label ?? 'Transactions'}</span>
          </Link>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleAiAssistant}
          title="AI Copilot · ask anything"
          aria-label="Open AI assistant"
        >
          <Sparkles className="w-5 h-5 text-gray-700" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleInbox}
          title="Inbox · press U anywhere"
          aria-label="Open inbox"
        >
          <Inbox className="w-5 h-5 text-gray-700" />
        </Button>
        <NotificationBell />
        <UserMenu userContext={userContext} />
      </div>
    </header>
  )
}
