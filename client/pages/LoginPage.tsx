import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { AppConfig } from '../../shared/api.ts';
import { api, type ApiRequestError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.ts';
import { initials, usePageTitle } from '../lib/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { peerColor } from '../components/PeopleHere.tsx';

/** A drawn, simplified preview of the editor: a page with a comment and two people on it. */
function PreviewArt() {
  return (
    <div className="login-preview" aria-hidden="true">
      <div className="preview-bar">
        <span className="preview-dot" />
        <span className="preview-dot" />
        <span className="preview-dot" />
        <span className="preview-people">
          <span className="avatar avatar-small" style={{ background: '#1f7a6d' }}>
            B
          </span>
          <span className="avatar avatar-small" style={{ background: '#7a3b8f' }}>
            C
          </span>
        </span>
      </div>
      <div className="preview-body">
        <div className="preview-page">
          <span className="preview-heading" />
          <span className="preview-line" style={{ width: '92%' }} />
          <span className="preview-line" style={{ width: '84%' }}>
            <span className="preview-highlight" />
          </span>
          <span className="preview-line" style={{ width: '88%' }} />
          <span className="preview-line" style={{ width: '56%' }} />
          <span className="preview-caret" />
        </div>
        <div className="preview-comment">
          <span className="preview-line" style={{ width: '70%' }} />
          <span className="preview-line" style={{ width: '90%' }} />
          <span className="preview-line" style={{ width: '50%' }} />
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<AppConfig['demo']>(null);
  usePageTitle('Sign in');

  useEffect(() => {
    api.config().then(
      (config) => setDemo(config.demo),
      () => setDemo(null),
    );
  }, []);

  const destination = (location.state as { from?: string } | null)?.from ?? '/';

  if (user) return <Navigate to={destination} replace />;

  async function signIn(address: string, secret: string) {
    setBusy(true);
    setError('');
    try {
      setUser(await api.login(address, secret));
      navigate(destination, { replace: true });
    } catch (caught) {
      setError((caught as ApiRequestError).message);
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void signIn(email, password);
  }

  return (
    <main className="login">
      <section className="login-pitch">
        <p className="wordmark wordmark-large">Foolscap</p>
        <p className="login-tagline">Plain pages, kept and passed around.</p>
        <p className="login-lede">A calm place to write with other people. Import what you have, share it by role, and never lose a word.</p>
        <ul className="login-features">
          <li className="login-feature">
            <Icon name="share" /> Share as editor, commenter or viewer
          </li>
          <li className="login-feature">
            <Icon name="comment" /> Comments that stay with the text
          </li>
          <li className="login-feature">
            <Icon name="history" /> Every version kept, restore any time
          </li>
          <li className="login-feature">
            <Icon name="download" /> Import Word and Markdown, export PDF
          </li>
        </ul>
        <PreviewArt />
      </section>
      <section className="login-card" aria-labelledby="login-heading">
        <div>
          <h1 id="login-heading">Sign in</h1>
          <p className="login-sub">Welcome back. Pick up where you left off.</p>
        </div>
        <form onSubmit={submit}>
          <label>
            Email
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? 'Signing inâ€¦' : 'Sign in'}
          </button>
        </form>
        {demo && (
        <div className="demo-accounts">
          <h2>Try a demo account</h2>
          <p>
            One click signs you in. All use the password <code>{demo.password}</code>. Open a private window as someone else to try sharing.
          </p>
          <ul>
            {demo.accounts.map((account) => (
              <li key={account.email}>
                <button className="demo-account" type="button" disabled={busy} onClick={() => signIn(account.email, demo.password)}>
                  <span className="avatar" style={{ background: peerColor(account.name) }} aria-hidden="true">
                    {initials(account.name)}
                  </span>
                  <span className="demo-account-who">
                    <span>{account.name}</span>
                    <small>{account.email}</small>
                  </span>
                  <Icon name="chevronRight" className="demo-account-go" />
                </button>
              </li>
            ))}
          </ul>
        </div>
        )}
      </section>
    </main>
  );
}
