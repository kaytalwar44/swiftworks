import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Loader2 } from 'lucide-react';

import { useAuth } from '@/features/auth/providers/auth-provider';

interface ProtectedRouteProps {
  children: ReactNode;
  /**
   * Permission required to view this route. When omitted, any authenticated
   * user may proceed. Matching happens client-side for UX only — the database
   * enforces the same rule through the Phase 4 RLS policies, so hiding a route
   * here is a convenience, never the security boundary.
   */
  permission?: string;
}

/**
 * Gate for every authenticated operator route.
 *
 * Resolves in order: still loading -> session? -> profile loaded? -> permitted?
 * A signed-out user is bounced to /login with the attempted path preserved, so
 * signing in returns them to where they were headed.
 */
export function ProtectedRoute({ children, permission }: ProtectedRouteProps) {
  const location = useLocation();
  const { authUser, user, isLoading, error, hasPermission } = useAuth();

  // The session and profile resolve in sequence. Rendering anything before
  // both settle would flash the login screen at a user who is already signed in.
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!authUser) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // Authenticated but no profile row: the user accepted an invite but
  // handle_new_user() never completed, or their account was removed.
  if (error && !user) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md space-y-3 text-center">
          <h1 className="text-lg font-semibold">Workspace unavailable</h1>
          <p className="text-sm text-muted-foreground">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (permission && !hasPermission(permission)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}

export default ProtectedRoute;
