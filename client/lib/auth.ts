import { createContext, useContext } from 'react';
import type { User } from '../../shared/api.ts';

export const AuthContext = createContext<{ user: User | null; setUser: (user: User | null) => void }>({
  user: null,
  setUser: () => {},
});

export const useAuth = () => useContext(AuthContext);
