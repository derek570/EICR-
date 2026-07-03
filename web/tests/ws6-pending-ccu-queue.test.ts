/**
 * WS6 item 2 — pending CCU-extraction queue (iOS
 * `PendingExtractionQueue.swift` parity + idempotency contract).
 *
 * Pins:
 *   - persist-BEFORE-upload: the entry is durable in IDB before any
 *     network call, with one freshly-minted idempotency key;
 *   - the SAME `X-Idempotency-Key` goes out on the first attempt AND
 *     every retry of that capture (never re-minted);
 *   - success removes the entry;
 *   - retryable failures (network / 5xx / 429) KEEP the entry queued;
 *   - `422 retake_required` DROPS the entry, does not consume a retry,
 *     and does not re-upload (exactly one fetch);
 *   - `409 idempotency_inflight` honours Retry-After and re-polls with
 *     the same key;
 *   - document extraction has NO queue/key path: `analyzeDocument`
 *     sends no X-Idempotency-Key header.
 *
 * IDB comes from `fake-indexeddb/auto` (shared tests/setup.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api-client';
import {
  getPendingCcuExtractions,
  inflightWait,
  removePendingCcuExtraction,
  savePendingCcuExtraction,
  submitCcuCapture,
} from '@/lib/ccu/pending-extraction-queue';

interface StubCall {
  url: string;
  headers: Headers;
}

interface StubResponse {
  status?: number;
  body?: unknown;
  /** Reject the fetch with a TypeError (network failure) instead. */
  networkError?: boolean;
}

let calls: StubCall[] = [];

function stubFetch(responses: StubResponse[]): void {
  let i = 0;
  // vi.stubGlobal (auto-restored by `unstubGlobals` in vitest.config.ts)
  // instead of a direct `globalThis.fetch = fn` reassignment.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (next.networkError) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      const status = next.status ?? 200;
      return Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        statusText: '',
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type' ? 'application/json' : null,
        },
        json: () => Promise.resolve(next.body ?? {}),
        text: () => Promise.resolve(JSON.stringify(next.body ?? {})),
      } as unknown as Response);
    })
  );
}

const ANALYSIS_OK = { board_manufacturer: 'Wylex', circuits: [] };

function makePhoto(): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02])], 'ccu.jpg', {
    type: 'image/jpeg',
  });
}

async function queueOne(jobId = 'job-q1') {
  const entry = await savePendingCcuExtraction({
    userId: 'u1',
    jobId,
    mode: 'full_capture',
    photo: makePhoto(),
    targetBoardId: 'board-1',
  });
  expect(entry).not.toBeNull();
  return entry!;
}

beforeEach(() => {
  calls = [];
  // No real sleeping for the 409 Retry-After path.
  vi.spyOn(inflightWait, 'sleep').mockResolvedValue(undefined);
});

afterEach(async () => {
  // `unstubGlobals` + `restoreMocks` in vitest.config.ts revert the fetch
  // stub and the sleep spy automatically; this is belt-and-suspenders.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Drain the store between tests.
  for (const jobId of ['job-q1', 'job-q2']) {
    for (const entry of await getPendingCcuExtractions(jobId)) {
      await removePendingCcuExtraction(entry.id);
    }
  }
});

describe('persist-before-upload', () => {
  it('writes the entry (with one idempotency key) to IDB before any network call', async () => {
    const entry = await queueOne();
    expect(calls).toHaveLength(0); // nothing uploaded yet
    const rows = await getPendingCcuExtractions('job-q1');
    expect(rows.map((r) => r.id)).toContain(entry.id);
    expect(rows[0].idempotencyKey).toBe(entry.idempotencyKey);
    expect(rows[0].idempotencyKey.length).toBeGreaterThan(8);
    expect(rows[0].mode).toBe('full_capture');
    expect(rows[0].targetBoardId).toBe('board-1');
  });
});

describe('submitCcuCapture', () => {
  it('sends X-Idempotency-Key and removes the entry on success', async () => {
    const entry = await queueOne();
    stubFetch([{ status: 200, body: ANALYSIS_OK }]);

    const result = await submitCcuCapture(entry);

    expect(result.kind).toBe('analysis');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('X-Idempotency-Key')).toBe(entry.idempotencyKey);
    expect(await getPendingCcuExtractions('job-q1')).toHaveLength(0);
  });

  it('keeps the entry on a retryable failure and REUSES the same key on the retry', async () => {
    const entry = await queueOne();
    // Attempt 1: network failure → queued. Attempt 2: success.
    stubFetch([{ networkError: true }, { status: 200, body: ANALYSIS_OK }]);

    const first = await submitCcuCapture(entry);
    expect(first.kind).toBe('queued');
    // Entry survived the failure — that's the durable-photo guarantee.
    const rows = await getPendingCcuExtractions('job-q1');
    expect(rows.map((r) => r.id)).toContain(entry.id);

    const second = await submitCcuCapture(rows.find((r) => r.id === entry.id)!);
    expect(second.kind).toBe('analysis');

    // The SAME key on both attempts — the backend's withIdempotency
    // dedup contract only works if retries never re-mint.
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get('X-Idempotency-Key')).toBe(entry.idempotencyKey);
    expect(calls[1].headers.get('X-Idempotency-Key')).toBe(entry.idempotencyKey);
  });

  it('5xx is retryable-kept; other 4xx is dropped as a terminal error', async () => {
    const e1 = await queueOne();
    stubFetch([{ status: 503, body: { error: 'upstream' } }]);
    expect((await submitCcuCapture(e1)).kind).toBe('queued');
    expect((await getPendingCcuExtractions('job-q1')).map((r) => r.id)).toContain(e1.id);
    await removePendingCcuExtraction(e1.id);

    const e2 = await queueOne();
    stubFetch([{ status: 400, body: { error: 'bad image' } }]);
    expect((await submitCcuCapture(e2)).kind).toBe('error');
    expect(await getPendingCcuExtractions('job-q1')).toHaveLength(0);
  });

  it('422 retake_required drops the entry, does not consume a retry, and does not re-upload', async () => {
    const entry = await queueOne();
    stubFetch([
      {
        status: 422,
        body: {
          status: 'retake_required',
          reason: 'blurry',
          message: 'The photo is too blurry to read breaker labels.',
        },
      },
      // If the engine (wrongly) retried, this would come back and the
      // call-count assertion below would catch it.
      { status: 200, body: ANALYSIS_OK },
    ]);

    const result = await submitCcuCapture(entry);

    expect(result).toEqual({
      kind: 'retake',
      reason: 'blurry',
      message: 'The photo is too blurry to read breaker labels.',
    });
    // Exactly ONE upload — a quality-gate rejection must never burn a
    // retry or re-send the same bytes (iOS CCUExtractionViewModel
    // drop-on-retake parity).
    expect(calls).toHaveLength(1);
    expect(await getPendingCcuExtractions('job-q1')).toHaveLength(0);
  });

  it('409 idempotency_inflight waits per Retry-After and re-polls with the SAME key', async () => {
    const entry = await queueOne();
    stubFetch([
      { status: 409, body: { error: 'idempotency_inflight', retryable: true } },
      { status: 200, body: ANALYSIS_OK },
    ]);

    const result = await submitCcuCapture(entry);

    expect(result.kind).toBe('analysis');
    expect(calls).toHaveLength(2);
    expect(calls[1].headers.get('X-Idempotency-Key')).toBe(entry.idempotencyKey);
    // Honoured the middleware's Retry-After: 5 contract.
    expect(inflightWait.sleep).toHaveBeenCalledWith(5000);
  });
});

describe('document extraction stays queue-free (iOS parity)', () => {
  it('analyzeDocument sends NO X-Idempotency-Key header', async () => {
    stubFetch([{ status: 200, body: { success: true, formData: {} } }]);

    await api.analyzeDocument([makePhoto()]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/analyze-document');
    expect(calls[0].headers.get('X-Idempotency-Key')).toBeNull();
  });
});
