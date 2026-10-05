/**
 * A well-formed argon2id hash for rows the tests insert directly. It is not the hash of any
 * password, so nobody can sign in with it; tests that sign in create real hashes instead.
 */
export const PLACEHOLDER_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$cGxhY2Vob2xkZXJzYWx0$cGxhY2Vob2xkZXJoYXNoLW5vdC1hLXJlYWwtcGFzc3dvcmQ';
