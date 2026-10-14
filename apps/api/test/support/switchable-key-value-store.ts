import { Redis } from 'ioredis';
import type { AppConfig } from '../../src/config/app-config.js';

/**
 * The real Valkey connection, with a switch that makes every command fail the way a dead store does.
 * Lets one test sign in while the store is up, then see what still works once it goes down.
 */
export function switchableKeyValueStore(config: AppConfig) {
  const realStore = new Redis(config.KEY_VALUE_STORE_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  const switchState = { isDown: false };
  const connectionRefused = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:56379'));
  const store = new Proxy(realStore, {
    get(target, property, receiver) {
      if (switchState.isDown && (property === 'eval' || property === 'ping' || property === 'del')) return connectionRefused;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store, switchState };
}
