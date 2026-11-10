import type { MouseEvent } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.ts';

/**
 * The bar shown on every signed-in page: a way home, who is signed in, and sign out.
 * `guard` lets a page with unsaved work run its own checks before leaving; it calls `go` when leaving is fine.
 */
export function AppHeader({ guard }: { guard?: (go: () => void) => void }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();

  const leaveVia = (go: () => void) => (guard ? guard(go) : go());

  function goHome(event: MouseEvent) {
    if (!guard) return;
    event.preventDefault();
    guard(() => navigate('/'));
  }

  async function signOut() {
    await api.logout().catch(() => {});
    setUser(null);
  }

  return (
    <header className="masthead">
      <nav className="masthead-nav" aria-label="Main">
        <Link to="/" className="wordmark" onClick={goHome}>
          Foolscap
        </Link>
        <span className="masthead-divider" aria-hidden="true" />
        <NavLink to="/" end className="home-link" onClick={goHome}>
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 9.2 10 3.5l7 5.7" />
            <path d="M5 7.8V16h3.6v-4.4h2.8V16H15V7.8" />
          </svg>
          <span className="home-label">Home</span>
        </NavLink>
      </nav>
      <div className="masthead-user">
        <span className="masthead-name" title={user?.email}>
          {user?.name}
        </span>
        <button type="button" className="link-button" onClick={() => leaveVia(() => void signOut())}>
          Sign out
        </button>
      </div>
    </header>
  );
}
