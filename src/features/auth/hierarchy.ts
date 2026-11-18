export type HierarchyRole = 'ultra_admin' | 'owner' | 'admin' | 'technician' | 'legacy' | 'conflict';

export const ROLE_LABELS: Record<HierarchyRole, string> = {
  ultra_admin: 'Ultra Admin',
  owner: 'Super Admin',
  admin: 'Admin',
  technician: 'Subcontractor',
  legacy: 'Legacy role — review required',
  conflict: 'Conflicting roles — review required',
};

/** Labels/delegation UX only. Database authorization is authoritative. */
export function hierarchyRole(
  profile: { is_platform_admin?: boolean } | null,
  roles: readonly { code: string }[],
): HierarchyRole {
  if (profile?.is_platform_admin) return 'ultra_admin';
  const codes = new Set(roles.map((role) => role.code));
  const operator = codes.has('owner') || codes.has('admin') || codes.has('company_admin');
  if (codes.has('technician') && operator) return 'conflict';
  if (codes.has('owner')) return 'owner';
  if (operator) return 'admin';
  if (codes.has('technician')) return 'technician';
  return 'legacy';
}

export function assignableRoles(actor: HierarchyRole): ('owner' | 'admin' | 'technician')[] {
  if (actor === 'ultra_admin') return ['owner', 'admin', 'technician'];
  if (actor === 'owner') return ['admin', 'technician'];
  if (actor === 'admin') return ['technician'];
  return [];
}
