import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Shimmer placeholder used while content loads.
 *
 * Composition is by class override rather than props — a caller sets the
 * dimensions and shape:
 *   <Skeleton className="h-7 w-48" />              text line
 *   <Skeleton className="h-10 w-10 rounded-full" /> avatar
 *
 * `animate-pulse` respects prefers-reduced-motion, which index.css forces to
 * near-zero duration, so the shimmer stops for users who ask it to.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };
