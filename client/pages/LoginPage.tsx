import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '../../shared/demo.ts';
import { api, ApiRequestError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.ts';

export function LoginPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
      </section>
      <section className="login-card" aria-labelledby="login-heading">
        <h1 id="login-heading">Sign in</h1>
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
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div className="demo-accounts">
          <h2>Demo accounts</h2>
          <p>
            All use the password <code>{DEMO_PASSWORD}</code>. Open a second window to try sharing between people.
          </p>
          <ul>
            {DEMO_ACCOUNTS.map((account) => (
              <li key={account.email}>
                <button className="demo-account" type="button" disabled={busy} onClick={() => signIn(account.email, DEMO_PASSWORD)}>
                  <span>{account.name}</span>
                  <small>{account.email}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
