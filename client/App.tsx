import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { User } from '../shared/api.ts';
import { api, setUnauthorizedHandler } from './lib/api.ts';
import { AuthContext } from './lib/auth.ts';
import { ToastProvider } from './lib/ui.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { LibraryPage } from './pages/LibraryPage.tsx';
import { EditorPage } from './pages/EditorPage.tsx';

function RequireUser({ user, children }: { user: User | null; children: React.ReactNode }) {
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    // The editor handles a 401 itself so it can keep unsaved text on screen.
    setUnauthorizedHandler(() => setUser((current) => (window.location.pathname.startsWith('/d/') ? current : null)));
    api.me().then(setUser, () => setUser(null));
  }, []);

  if (user === undefined) {
    return (
      <div className="center-state splash" aria-busy="true">
        <span className="wordmark">Foolscap</span>
        <span className="splash-bar" aria-hidden="true" />
        <span className="visually-hidden">Opening…</span>
      </div>
    );
  }

  return (
    <ToastProvider>
    <AuthContext.Provider value={{ user, setUser }}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireUser user={user}>
              <LibraryPage />
            </RequireUser>
          }
        />
        <Route
          path="/d/:id"
          element={
            <RequireUser user={user}>
              <EditorPage />
            </RequireUser>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthContext.Provider>
    </ToastProvider>
  );
}
