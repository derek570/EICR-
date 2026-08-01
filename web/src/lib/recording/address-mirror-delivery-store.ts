const STORAGE_KEY = 'certmate.addressMirrorDeliveryTokens.v1';
const MAX_TOKENS = 256;
export const ADDRESS_MIRROR_DELIVERY_DEDUPE_PREFIX = 'address_mirror_delivery::';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160;
}

export function addressMirrorDeliveryDedupeKey(token: string): string {
  return `${ADDRESS_MIRROR_DELIVERY_DEDUPE_PREFIX}${token}`;
}

export function tokenFromAddressMirrorDeliveryDedupeKey(key: string): string | null {
  if (!key.startsWith(ADDRESS_MIRROR_DELIVERY_DEDUPE_PREFIX)) return null;
  const token = key.slice(ADDRESS_MIRROR_DELIVERY_DEDUPE_PREFIX.length);
  return validToken(token) ? token : null;
}

/**
 * Playback-owned durable terminal ledger. Reservations suppress a replay only
 * while its first copy is queued. Heard tokens persist before the websocket
 * ACK is sent, so an app/tab restart between playback start and ACK cannot
 * double-speak the same terminal.
 */
export class AddressMirrorDeliveryStore {
  private readonly heard = new Set<string>();
  private heardOrder: string[] = [];
  private readonly reserved = new Set<string>();

  constructor(private readonly storage: StorageLike | null = null) {
    if (!storage) return;
    try {
      const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
      if (!Array.isArray(parsed)) return;
      for (const token of parsed.filter(validToken).slice(-MAX_TOKENS)) {
        if (this.heard.has(token)) continue;
        this.heard.add(token);
        this.heardOrder.push(token);
      }
    } catch {
      // Corrupt/unavailable storage degrades to process-lifetime dedupe.
    }
  }

  static fromBrowser(): AddressMirrorDeliveryStore {
    try {
      return new AddressMirrorDeliveryStore(
        typeof window === 'undefined' ? null : window.localStorage
      );
    } catch {
      return new AddressMirrorDeliveryStore(null);
    }
  }

  isHeard(token: string): boolean {
    return this.heard.has(token);
  }

  reserve(token: string): boolean {
    if (!validToken(token) || this.heard.has(token) || this.reserved.has(token)) return false;
    this.reserved.add(token);
    return true;
  }

  discard(token: string): void {
    this.reserved.delete(token);
  }

  markPlaybackStarted(token: string): void {
    if (!validToken(token)) return;
    this.reserved.delete(token);
    if (!this.heard.has(token)) {
      this.heard.add(token);
      this.heardOrder.push(token);
      while (this.heardOrder.length > MAX_TOKENS) {
        const oldest = this.heardOrder.shift();
        if (oldest) this.heard.delete(oldest);
      }
      this.persist();
    }
  }

  clearReservations(): void {
    this.reserved.clear();
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.heardOrder));
    } catch {
      // Storage failure must not prevent speech or its websocket ACK.
    }
  }
}
