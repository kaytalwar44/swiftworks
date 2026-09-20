import { Link, useNavigate } from 'react-router';
import { ArrowLeft, Home, SearchX } from 'lucide-react';

import { useAuth } from '@/features/auth/providers/auth-provider';
import { Button } from '@/components/ui/button';

/**
 * 404 for both the authenticated console and the public booking flow.
 *
 * A resident who mistypes a booking link and an operator who follows a dead
 * notification link both land here, so the primary action adapts to whichever
 * audience is present.
 */
export function NotFoundPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <SearchX className="h-7 w-7 text-muted-foreground" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Page not found
          </h1>
          <p className="text-sm text-muted-foreground">
            {user
              ? 'That page does not exist, or you do not have access to it.'
              : 'That link is not valid. If you scanned a QR code, check that the code is still active.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="outline" onClick={() => navigate(-1)}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Go back
          </Button>

          {user ? (
            <Button asChild>
              <Link to="/dashboard">
                <Home className="mr-2 h-4 w-4" />
                Dashboard
              </Link>
            </Button>
          ) : (
            <Button asChild>
              <Link to="/login">
                <Home className="mr-2 h-4 w-4" />
                Sign in
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default NotFoundPage;
