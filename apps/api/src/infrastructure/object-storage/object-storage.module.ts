import { Global, Module } from '@nestjs/common';
import { ObjectStorage } from './object-storage.js';

@Global()
@Module({ providers: [ObjectStorage], exports: [ObjectStorage] })
export class ObjectStorageModule {}
