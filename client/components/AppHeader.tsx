import type { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
        <Link to="/" className="home-link" onClick={goHome}>
          <span aria-hidden="true">⌂</span> Home
        </Link>
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
