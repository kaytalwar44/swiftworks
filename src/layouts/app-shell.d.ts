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
export declare function AppShell(): import("react").JSX.Element;
export default AppShell;
//# sourceMappingURL=app-shell.d.ts.map