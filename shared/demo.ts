/**
 * Seeded demo accounts. These are deliberately public: the login exists to give
 * the app real user identities for access control, not to protect real data.
 */
export const DEMO_PASSWORD = 'foolscap-demo';

export const DEMO_ACCOUNTS = [
  { email: 'avery@foolscap.test', name: 'Avery Lindqvist' },
  { email: 'blake@foolscap.test', name: 'Blake Okafor' },
  { email: 'casey@foolscap.test', name: 'Casey Moreau' },
] as const;
