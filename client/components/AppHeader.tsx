import type { MouseEvent } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.ts';
import { initials, usePopover } from '../lib/ui.tsx';
import { Icon } from './Icon.tsx';
import { peerColor } from './PeopleHere.tsx';

/**
 * The bar shown on every signed-in page: a way home, who is signed in, and sign out.
 * `guard` lets a page with unsaved work run its own checks before leaving; it calls `go` when leaving is fine.
 */
export function AppHeader({ guard }: { guard?: (go: () => void) => void }) {
  const navigate = useNavigate();

  function goHome(event: MouseEvent) {
    if (!guard) return;
    event.preventDefault();
    guard(() => navigate('/'));
  }

  return (
    <header className="masthead">
      <nav className="masthead-nav" aria-label="Main">
        <Link to="/" className="wordmark" onClick={goHome}>
          Foolscap
        </Link>
        <span className="masthead-divider" aria-hidden="true" />
        <NavLink to="/" end className="home-link" onClick={goHome}>
          <Icon name="home" />
          <span className="home-label">Home</span>
        </NavLink>
      </nav>
      <UserMenu guard={guard} />
    </header>
  );
}

function UserMenu({ guard }: { guard?: (go: () => void) => void }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const { open, setOpen, ref } = usePopover();
  if (!user) return null;

  const leaveVia = (go: () => void) => (guard ? guard(go) : go());

  async function signOut() {
    await api.logout().catch(() => {});
    setUser(null);
  }

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="user-menu-panel"
        aria-label={`Account: ${user.name}`}
        onClick={() => setOpen(!open)}
      >
        <span className="avatar" style={{ background: peerColor(user.name) }} aria-hidden="true">
          {initials(user.name)}
        </span>
        <span className="user-trigger-name" aria-hidden="true">
          {user.name}
        </span>
        <Icon name="chevronDown" size={14} className="user-trigger-chevron" />
      </button>
      {open && (
        <div className="popover user-panel" id="user-menu-panel">
          <div className="user-panel-head">
            <span className="avatar avatar-large" style={{ background: peerColor(user.name) }} aria-hidden="true">
              {initials(user.name)}
            </span>
            <span className="user-panel-who">
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </span>
          </div>
          <div className="popover-items">
            <button
              type="button"
              className="popover-item"
              onClick={() => {
                setOpen(false);
                leaveVia(() => navigate('/'));
              }}
            >
              <Icon name="file" /> Your documents
            </button>
            <button
              type="button"
              className="popover-item"
              onClick={() => {
                setOpen(false);
                leaveVia(() => void signOut());
              }}
            >
              <Icon name="signOut" /> Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
