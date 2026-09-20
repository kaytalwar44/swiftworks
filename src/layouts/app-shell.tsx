import { Outlet } from 'react-router';

import { Navbar } from '@/components/Navbar';
import { Sidebar } from '@/components/Sidebar';
import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Chrome for every authenticated operator route.
 *
 * App.tsx renders <AppShell /> as the element of a layout route, so pages
 * arrive through <Outlet /> and never manage their own sidebar or navbar.
 *
 * The sidebar is fixed on desktop and a slide-over on mobile. Technicians use
 * this on a phone in a hallway, so the drawer is the primary navigation there
 * rather than a fallback.
 */
export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-muted/30">
      {/* Desktop sidebar — sticky so it survives page scroll */}
      <aside className="hidden w-64 shrink-0 border-r bg-background lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar />
        </div>
      </aside>

      {/* Mobile slide-over */}
      <div
        className={cn(
          'fixed inset-0 z-40 lg:hidden',
          mobileNavOpen ? 'pointer-events-auto' : 'pointer-events-none',
        )}
        aria-hidden={!mobileNavOpen}
      >
        <div
          className={cn(
            'absolute inset-0 bg-black/50 transition-opacity duration-200',
            mobileNavOpen ? 'opacity-100' : 'opacity-0',
          )}
          onClick={() => setMobileNavOpen(false)}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          className={cn(
            'absolute inset-y-0 left-0 w-64 bg-background shadow-xl transition-transform duration-200',
            mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <Sidebar onNavigate={() => setMobileNavOpen(false)} />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <Navbar onMenuClick={() => setMobileNavOpen(true)} />

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-7xl">
            <Outlet />
          </div>
        </main>

        <footer className="border-t px-4 py-4 text-xs text-muted-foreground sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-7xl items-center justify-between">
            <span>SwiftWorks</span>
            {typeof __APP_VERSION__ !== 'undefined' && (
              <span>v{__APP_VERSION__}</span>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

export default AppShell;
