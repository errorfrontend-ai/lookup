import { z } from 'zod';

/** The phones the listener app runs on. */
export const LISTENER_PLATFORMS = ['ANDROID', 'IOS'] as const;
export type ListenerPlatform = (typeof LISTENER_PLATFORMS)[number];

/** How long an install token works; the app registers again (same install id) to get a new one. */
export const INSTALL_TOKEN_LIFETIME_DAYS = 30;

/**
 * POST /api/v1/installs. The app registers once with an id it made for itself (a random UUID kept on
 * the phone); the server keeps only a keyed hash of it. Listeners are anonymous: there is no account.
 */
export const RegisterInstallInput = z
  .strictObject({
    install_id: z.uuid(),
    platform: z.enum(LISTENER_PLATFORMS),
    app_version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/),
  })
  .meta({ id: 'RegisterInstallInput' });
export type RegisterInstallInput = z.infer<typeof RegisterInstallInput>;

/** The answer: a token for `Authorization: Bearer …` on the listener routes, and when it stops working. */
export const InstallRegistration = z
  .strictObject({
    install_token: z.string().min(1).max(1024),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'InstallRegistration' });
export type InstallRegistration = z.infer<typeof InstallRegistration>;

export function emitRegisterInstallInputJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://contracts.lookup.invalid/register-install-input/1.json',
    ...z.toJSONSchema(RegisterInstallInput, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' }),
  };
}

export function emitInstallRegistrationJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://contracts.lookup.invalid/install-registration/1.json',
    ...z.toJSONSchema(InstallRegistration, { target: 'draft-2020-12', io: 'output', unrepresentable: 'throw' }),
  };
}
