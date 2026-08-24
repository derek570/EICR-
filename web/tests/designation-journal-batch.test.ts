/**
 * PLAN-B2 cycle-4 — batch-scoped, revision-checked journal clearing.
 *
 * The pinned race: a save drains the pending patch and starts its async
 * outbox enqueue; WHILE it is in flight the inspector commits another
 * designation edit (new journal write + committed mark). A global
 * "clear all committed journals" on the first save's durable enqueue
 * would delete the second edit's journal even though the enqueue that
 * carries it has not happened — a kill in that window loses the edit
 * entirely. The batch API captures exactly the marks present at drain
 * time and clears only those, and only at their captured revision.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearDesignationJournalBatch,
  markDesignationJournalCommitted,
  purgeDesignationDraftState,
  readDesignationJournal,
  restoreDesignationJournalBatch,
  takeCommittedDesignationJournalBatch,
  writeDesignationJournal,
} from '../src/lib/designation-drafts';

const KEY = 'job1:designation:c1';

beforeEach(() => {
  window.localStorage.clear();
  // Drain any marks left by a previous test.
  takeCommittedDesignationJournalBatch();
});

describe('designation journal batches', () => {
  it('clears a committed journal once its batch durably enqueues', () => {
    writeDesignationJournal(KEY, 'Kitchen sockets');
    markDesignationJournalCommitted(KEY);
    const batch = takeCommittedDesignationJournalBatch();
    expect(batch).toHaveLength(1);
    clearDesignationJournalBatch(batch);
    expect(readDesignationJournal(KEY)).toBeNull();
  });

  it('a keystroke during the in-flight save survives the first batch clear', () => {
    writeDesignationJournal(KEY, 'Kitchen sockets');
    markDesignationJournalCommitted(KEY);
    const batch = takeCommittedDesignationJournalBatch(); // save A drains
    // Inspector types again while save A is in flight.
    writeDesignationJournal(KEY, 'Kitchen sockets and lights');
    clearDesignationJournalBatch(batch); // save A durable
    // The newer journal is NOT cleared — its own save hasn't enqueued.
    expect(readDesignationJournal(KEY)).toBe('Kitchen sockets and lights');
    // Its own commit → drain → durable cycle clears it.
    markDesignationJournalCommitted(KEY);
    clearDesignationJournalBatch(takeCommittedDesignationJournalBatch());
    expect(readDesignationJournal(KEY)).toBeNull();
  });

  it('take drains the mark set — a second save captures nothing extra', () => {
    writeDesignationJournal(KEY, 'Cooker');
    markDesignationJournalCommitted(KEY);
    expect(takeCommittedDesignationJournalBatch()).toHaveLength(1);
    expect(takeCommittedDesignationJournalBatch()).toHaveLength(0);
  });

  it('restore puts a failed batch back for the next save (newer marks win)', () => {
    writeDesignationJournal(KEY, 'Cooker');
    markDesignationJournalCommitted(KEY);
    const batch = takeCommittedDesignationJournalBatch();
    restoreDesignationJournalBatch(batch); // save failed pre-durability
    const retried = takeCommittedDesignationJournalBatch();
    expect(retried).toEqual(batch);
    clearDesignationJournalBatch(retried);
    expect(readDesignationJournal(KEY)).toBeNull();
  });

  it('restore never downgrades a mark re-committed at a newer revision', () => {
    writeDesignationJournal(KEY, 'Cooker');
    markDesignationJournalCommitted(KEY);
    const batch = takeCommittedDesignationJournalBatch();
    // While save A is failing, a newer edit commits.
    writeDesignationJournal(KEY, 'Cooker and hob');
    markDesignationJournalCommitted(KEY);
    restoreDesignationJournalBatch(batch); // stale revision must not win
    const next = takeCommittedDesignationJournalBatch();
    clearDesignationJournalBatch(next);
    // Cleared at the NEW revision — the newer value was carried.
    expect(readDesignationJournal(KEY)).toBeNull();
  });

  it('cycle-6: sign-out purge removes every journal and resets the mark/revision state', () => {
    writeDesignationJournal(KEY, 'Kitchen');
    markDesignationJournalCommitted(KEY);
    writeDesignationJournal('job2:designation:c9', 'Shower');
    purgeDesignationDraftState();
    // Journals gone — the next login's mount recovers nothing.
    expect(readDesignationJournal(KEY)).toBeNull();
    expect(readDesignationJournal('job2:designation:c9')).toBeNull();
    // No marks survive for a later save to clear.
    expect(takeCommittedDesignationJournalBatch()).toHaveLength(0);
  });

  it('a fresh keystroke supersedes an un-drained committed mark', () => {
    writeDesignationJournal(KEY, 'Shower');
    markDesignationJournalCommitted(KEY);
    writeDesignationJournal(KEY, 'Shower and pump'); // before any drain
    // The stale mark was dropped; nothing to capture until re-commit.
    expect(takeCommittedDesignationJournalBatch()).toHaveLength(0);
    expect(readDesignationJournal(KEY)).toBe('Shower and pump');
  });
});
