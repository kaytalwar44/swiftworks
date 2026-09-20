import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Joins class names and resolves Tailwind conflicts.
 *
 * clsx handles conditional and array/object syntax:
 *   cn('base', isActive && 'active', { 'text-red-500': hasError })
 *
 * twMerge then dedupes conflicting utilities, keeping the last one:
 *   cn('px-2 py-1', 'px-4')  ->  'py-1 px-4'
 *
 * That second step is what makes component overrides work. A caller passing
 * className="px-6" to a component whose base includes px-2 gets px-6 rather
 * than both, which would otherwise depend on CSS source order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
