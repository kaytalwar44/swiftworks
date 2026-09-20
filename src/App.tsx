import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router';

import { AppShell } from '@/layouts/app-shell';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { ProtectedRoute } from '@/features/auth/components/protected-route';
import { AuthProvider } from '@/features/auth/providers/auth-provider';
import { NotFoundPage } from '@/pages/not-found';

// Route-level splitting: a resident scanning a QR never downloads the operator
// bundle, and an operator never downloads the booking wizard.
//
// Only routes with a real file are declared below. A lazy import to a
// non-existent path compiles cleanly and 404s at navigation, so absent routes
// are removed rather than stubbed — add each one back as its page lands.

// ---------- Auth ----------
const LoginPage = lazy(() => import('@/pages/Login'));

// ---------- Operator console ----------
const DashboardPage = lazy(() => import('@/pages/Dashboard'));

export default function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          {/* ---------- Public: no auth, no operator chrome ---------- */}
          <Route path="/login" element={<LoginPage />} />

          {/* ---------- Authenticated operator console ---------- */}
          <Route
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
