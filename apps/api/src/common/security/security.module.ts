import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { DerivedKeys } from './derived-keys.js';
import { HUMAN_CHECK, humanCheckFor } from './human-check.js';
import { TwoFactorSecretBox } from './two-factor-secret-box.js';

@Global()
@Module({
  providers: [
    DerivedKeys,
    { provide: HUMAN_CHECK, inject: [APP_CONFIG], useFactory: (config: AppConfig) => humanCheckFor(config) },
    { provide: TwoFactorSecretBox, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new TwoFactorSecretBox(config.TWO_FACTOR_ENCRYPTION_SECRET) },
  ],
  exports: [DerivedKeys, HUMAN_CHECK, TwoFactorSecretBox],
})
export class SecurityModule {}
