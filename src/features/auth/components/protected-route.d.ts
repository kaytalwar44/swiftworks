import type { ReactNode } from 'react';
interface ProtectedRouteProps {
    children: ReactNode;
    /**
     * Permission required to view this route. When omitted, any authenticated
     * user may proceed. Matching happens client-side for UX only — the database
     * enforces the same rule through the Phase 4 RLS policies, so hiding a route
     * here is a convenience, never the security boundary.
     */
    permission?: string;
    /**
     * Permits a technician to render this route. Set only on the technician
     * portal — everywhere else a technician is redirected to /tech.
     */
    allowTechnician?: boolean;
}
/**
 * Gate for every authenticated operator route.
 *
 * Resolves in order: still loading -> session? -> profile loaded? -> role? ->
 * permitted? A signed-out user is bounced to /login with the attempted path
 * preserved, so signing in returns them to where they were headed.
 */
export declare function ProtectedRoute({ children, permission, allowTechnician, }: ProtectedRouteProps): import("react").JSX.Element;
export default ProtectedRoute;
//# sourceMappingURL=protected-route.d.ts.map