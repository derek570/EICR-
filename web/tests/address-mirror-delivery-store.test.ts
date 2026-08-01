import { describe, expect, it } from 'vitest';
import {
  AddressMirrorDeliveryStore,
  addressMirrorDeliveryDedupeKey,
  tokenFromAddressMirrorDeliveryDedupeKey,
} from '@/lib/recording/address-mirror-delivery-store';

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('AddressMirrorDeliveryStore', () => {
  it('reserves while queued, releases on discard, and permits an audible retry', () => {
    const store = new AddressMirrorDeliveryStore();
    expect(store.reserve('direct:op-1')).toBe(true);
    expect(store.reserve('direct:op-1')).toBe(false);
    store.discard('direct:op-1');
    expect(store.reserve('direct:op-1')).toBe(true);
  });

  it('persists at playback start and a restarted store suppresses replay', () => {
    const storage = new MemoryStorage();
    const first = new AddressMirrorDeliveryStore(storage);
    expect(first.reserve('convenience:resolution-1')).toBe(true);
    first.markPlaybackStarted('convenience:resolution-1');

    const restarted = new AddressMirrorDeliveryStore(storage);
    expect(restarted.isHeard('convenience:resolution-1')).toBe(true);
    expect(restarted.reserve('convenience:resolution-1')).toBe(false);
  });

  it('bounds durable tokens and ignores corrupt storage', () => {
    const storage = new MemoryStorage();
    const store = new AddressMirrorDeliveryStore(storage);
    for (let i = 0; i < 260; i += 1) {
      const token = `direct:op-${i}`;
      store.reserve(token);
      store.markPlaybackStarted(token);
    }
    const restarted = new AddressMirrorDeliveryStore(storage);
    expect(restarted.isHeard('direct:op-0')).toBe(false);
    expect(restarted.isHeard('direct:op-259')).toBe(true);

    storage.values.set('certmate.addressMirrorDeliveryTokens.v1', '{broken');
    expect(new AddressMirrorDeliveryStore(storage).reserve('direct:fresh')).toBe(true);
  });

  it('round-trips only valid queue dedupe keys', () => {
    const key = addressMirrorDeliveryDedupeKey('direct:op-7');
    expect(tokenFromAddressMirrorDeliveryDedupeKey(key)).toBe('direct:op-7');
    expect(tokenFromAddressMirrorDeliveryDedupeKey('measured_zs_ohm_1')).toBeNull();
  });
});
