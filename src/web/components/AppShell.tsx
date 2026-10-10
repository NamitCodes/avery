import { Sidebar } from '@rtcamp/frappe-ui-react';
import {
  CalendarCheck,
  ClipboardList,
  History,
  House,
  LogOut,
  MapPin,
  Menu,
  MonitorPlay,
  ScanLine,
  Ticket,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { DESK_STAFF, GATE_STAFF, ROLE_LABEL, type User } from '../api';
import { useAuth } from '../auth';
import { useDemo } from '../demoInfo';
import { buttonClass, Button } from './fui';

type LucideIcon = typeof House;

/** Lucide icon in the shape Frappe Button's `icon`/`iconLeft` props expect. */
const asButtonIcon = (I: LucideIcon, size: number) =>
  ((props: { className?: string }) => <I size={size} strokeWidth={1.5} {...props} />) as unknown as ComponentType<unknown>;

const SignOutIcon = asButtonIcon(LogOut, 16);
/** Collapsed rail: 20px, matching the collapsed navigation icons. */
const SignOutIconLarge = ((props: { className?: string }) => <LogOut size={20} {...props} className="size-5" />) as unknown as ComponentType<unknown>;
const MenuIcon = asButtonIcon(Menu, 20);
const CloseIcon = asButtonIcon(X, 20);

interface NavItem {
  label: string;
  to: string;
  Icon: LucideIcon;
  exact?: boolean;
}
interface NavSection {
  label: string;
  items: NavItem[];
}

/** Navigation for a user's role — shared by the desktop sidebar and the phone menu. */
function navFor(user: User, demo: boolean): NavSection[] {
  const has = (roles: string[]) => roles.includes(user.role);
  const sections: (NavSection | null)[] = [
    demo ? { label: 'Demo', items: [{ label: 'Demos', to: '/demo', Icon: MonitorPlay }] } : null,
    {
      label: 'Me',
      items: [
        { label: 'Home', to: '/', Icon: House, exact: true },
        { label: 'My attendance', to: '/me/attendance', Icon: History },
      ],
    },
    user.role === 'ADMIN'
      ? {
          label: 'Weekly check-in',
          items: [
            { label: 'Sessions', to: '/admin/sessions', Icon: CalendarCheck },
            { label: 'Venues', to: '/admin/venues', Icon: MapPin },
            { label: 'People', to: '/admin/volunteers', Icon: Users },
            { label: 'Audit log', to: '/admin/audit', Icon: ClipboardList },
          ],
        }
      : null,
    has(DESK_STAFF) || has(GATE_STAFF)
      ? {
          label: 'Events',
          items: [
            ...(has(DESK_STAFF) ? [{ label: 'Events', to: '/admin/events', Icon: Ticket }] : []),
            ...(has(GATE_STAFF) ? [{ label: 'Stations', to: '/staff', Icon: ScanLine }] : []),
          ],
        }
      : null,
  ];
  return sections.filter((s): s is NavSection => s !== null);
}

const isActive = (pathname: string, item: NavItem) =>
  item.exact ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);

function DemoBanner() {
  const demo = useDemo();
  const { user } = useAuth();
  if (!demo) return null;
  return (
    <div className="demo-banner no-print">
      Demo mode — sample data only. <Link to="/demo">Demos</Link>
      {user && <span> · signed in as {user.name}</span>}
    </div>
  );
}

/** True on phone-width screens. */
function useIsMobile() {
  const query = '(max-width: 640px)';
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

const Logo = () => <div className="w-full h-full bg-surface-gray-7 text-ink-white flex items-center justify-center font-semibold">R</div>;

/**
 * Main layout.
 * - Desktop/tablet, signed in: Frappe UI Sidebar + page.
 * - Phone, signed in: top bar with a ☰ button that opens a slide-out menu (labels,
 *   and Sign out always visible at the bottom).
 * - Signed out: simple top bar.
 * The page (<Outlet/>) sits at the same position in every case, so signing in or
 * rotating the phone never remounts the page and loses what was typed.
 */
export function AppShell({ narrow = false }: { narrow?: boolean }) {
  const { user, loading, logout } = useAuth();
  const demo = useDemo();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isMobile = useIsMobile();

  // Close the phone menu whenever the page changes.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  if (loading && !user) return null;

  const signOut = async () => {
    setMenuOpen(false);
    await logout();
    navigate('/login');
  };
  const sections = user ? navFor(user, !!demo) : [];
  const current = sections.flatMap((s) => s.items).find((i) => isActive(location.pathname, i));

  let sidebar: ReactNode = null;
  if (user && !isMobile) {
    sidebar = (
      <Sidebar
        header={{ title: 'RSSB', subtitle: ROLE_LABEL[user.role], logo: <Logo />, menuItems: [{ label: 'Sign out', onClick: signOut }] }}
        sections={sections.map((s) => ({
          label: s.label,
          items: s.items.map((i) => ({
            label: i.label,
            icon: <i.Icon className="size-4 text-ink-gray-6" strokeWidth={1.5} />,
            isActive: isActive(location.pathname, i),
            onClick: () => navigate(i.to),
          })),
        }))}
        collapsed={collapsed}
        onCollapseChange={setCollapsed}
      >
        {/* Rendered by Frappe's Sidebar above its Collapse control. */}
        <div slot="footer-items" className="px-1">
          {collapsed ? (
            <Button icon={SignOutIconLarge} size="lg" label="Sign out" theme="red" variant="subtle" onClick={signOut} title="Sign out" />
          ) : (
            <Button iconLeft={SignOutIcon} theme="red" variant="subtle" className="w-full" onClick={signOut}>
              Sign out
            </Button>
          )}
        </div>
      </Sidebar>
    );
  }

  let top: ReactNode;
  if (!user) top = <PlainHeader />;
  else if (isMobile)
    top = (
      <>
        <header className="mobile-bar no-print">
          <Button variant="ghost" icon={MenuIcon} label="Open menu" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)} />
          <Link to="/" className="brand">
            RSSB
          </Link>
          {current && <span className="mobile-bar-title">{current.label}</span>}
        </header>
        <DemoBanner />
        <MobileMenu
          open={menuOpen}
          user={user}
          sections={sections}
          pathname={location.pathname}
          onClose={() => setMenuOpen(false)}
          onNavigate={(to) => navigate(to)}
          onSignOut={signOut}
        />
      </>
    );
  else top = <DemoBanner />;

  return (
    <div className={sidebar ? 'shell' : undefined}>
      {sidebar ? <aside className="shell-sidebar no-print">{sidebar}</aside> : null}
      <div className="shell-main">
        {top}
        <div className={`page-body ${narrow ? 'narrow' : ''}`}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}

/** Phone navigation: slides in from the left over a dimmed page; Sign out pinned to the bottom. */
function MobileMenu({
  open,
  user,
  sections,
  pathname,
  onClose,
  onNavigate,
  onSignOut,
}: {
  open: boolean;
  user: User;
  sections: NavSection[];
  pathname: string;
  onClose(): void;
  onNavigate(to: string): void;
  onSignOut(): void;
}) {
  const closeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // no background scrolling while the menu is open
    closeRef.current?.querySelector('button')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  return (
    <div className={`mmenu ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="mmenu-backdrop" onClick={onClose} />
      <nav className="mmenu-panel" role="dialog" aria-modal="true" aria-label="Menu">
        <div className="mmenu-head">
          <div className="mmenu-logo">
            <Logo />
          </div>
          <div className="mmenu-who">
            <div className="mmenu-name">{user.name}</div>
            <div className="mmenu-role">{ROLE_LABEL[user.role]}</div>
          </div>
          <div ref={closeRef}>
            <Button variant="ghost" icon={CloseIcon} label="Close menu" aria-label="Close menu" onClick={onClose} tabIndex={open ? 0 : -1} />
          </div>
        </div>
        <div className="mmenu-body">
          {sections.map((s) => (
            <div key={s.label} className="mmenu-section">
              <div className="mmenu-section-label">{s.label}</div>
              {s.items.map((i) => {
                const active = isActive(pathname, i);
                return (
                  <Button
                    key={i.to}
                    variant="ghost"
                    size="lg"
                    iconLeft={asButtonIcon(i.Icon, 18)}
                    className={`mmenu-item ${active ? 'active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    tabIndex={open ? 0 : -1}
                    onClick={() => onNavigate(i.to)}
                  >
                    {i.label}
                  </Button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="mmenu-foot">
          <Button iconLeft={SignOutIcon} theme="red" variant="subtle" size="lg" className="w-full" tabIndex={open ? 0 : -1} onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </nav>
    </div>
  );
}

/** Top bar for signed-out / phone-first pages. */
function PlainHeader() {
  const { user, logout } = useAuth();
  const demo = useDemo();
  const navigate = useNavigate();
  return (
    <>
      <DemoBanner />
      <header className="topbar no-print">
        <Link to="/" className="brand">
          RSSB
        </Link>
        <nav>
          {demo && <Link to="/demo">Demos</Link>}
          {user ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              Sign out
            </Button>
          ) : (
            <Link className={buttonClass({ variant: 'subtle', size: 'sm' })} to="/login">
              Sign in
            </Link>
          )}
        </nav>
      </header>
    </>
  );
}

/** Phone-first public pages (sign-in, check-in, registration): minimal top bar. */
export function PlainShell({ narrow = true, children }: { narrow?: boolean; children?: ReactNode }) {
  return (
    <>
      <PlainHeader />
      <main className={narrow ? 'narrow' : undefined}>{children ?? <Outlet />}</main>
    </>
  );
}
