import { NavLink } from 'react-router';
import {
  Building2,
  CalendarDays,
  FileText,
  Gauge,
  HardHat,
  Handshake,
  QrCode,
  Receipt,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';

import { useAuth } from '@/features/auth/providers/auth-provider';
import { cn } from '@/lib/utils';

interface SidebarProps {
  onNavigate?: () => void;
}

interface NavItem {
  to: string;
  label: string;
  icon: typeof Gauge;
  /** Permission required to see this entry. Omitted means always visible. */
  permission?: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [{ to: '/dashboard', label: 'Dashboard', icon: Gauge }],
  },
  {
    title: 'Operations',
    items: [
      { to: '/jobs', label: 'Jobs', icon: Building2, permission: 'jobs.read' },
      { to: '/bookings', label: 'Bookings', icon: CalendarDays, permission: 'bookings.read' },
      { to: '/schedule', label: 'Schedule', icon: QrCode, permission: 'jobs.read' },
    ],
  },
  {
    title: 'Directory',
    items: [
      { to: '/customers', label: 'Customers', icon: Users, permission: 'customers.read' },
      { to: '/partners', label: 'Partners', icon: Handshake, permission: 'partners.read' },
      { to: '/technicians', label: 'Technicians', icon: HardHat, permission: 'technicians.read' },
    ],
  },
  {
    title: 'Finance',
    items: [
      { to: '/rates', label: 'Rate cards', icon: Receipt, permission: 'rates.read' },
      { to: '/invoices', label: 'Invoices', icon: FileText, permission: 'invoices.read' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/team', label: 'Team', icon: ShieldCheck, permission: 'users.manage' },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function Sidebar({ onNavigate }: SidebarProps) {
  const { hasPermission } = useAuth();

  return (
    <nav className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-4">
      <div className="px-3 py-2">
        <span className="text-lg font-semibold tracking-tight">SwiftWorks</span>
      </div>

      {SECTIONS.map((section) => {
        // Hide a whole section when the user holds none of its permissions,
        // so an operator is not shown headings with nothing beneath them.
        const visible = section.items.filter(
          (item) => !item.permission || hasPermission(item.permission),
        );
        if (visible.length === 0) return null;

        return (
          <div key={section.title} className="flex flex-col gap-1">
            <p className="px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {section.title}
            </p>

            {visible.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )
                }
              >
                <item.icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
