import { Global, Module } from '@nestjs/common';
import { DerivedKeys } from './derived-keys.js';

@Global()
@Module({ providers: [DerivedKeys], exports: [DerivedKeys] })
export class SecurityModule {}
