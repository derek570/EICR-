/**
 * PLAN-B2 cycle-4/7/8 — batch-scoped, TOKEN-checked journal clearing.
 *
 * The pinned race: a save drains the pending patch and starts its async
 * outbox enqueue; WHILE it is in flight the inspector commits another
 * designation edit (new journal write + committed mark). A global
 * "clear all committed journals" on the first save's durable enqueue
 * would delete the second edit's journal even though the enqueue that
 * carries it has not happened — a kill in that window loses the edit
 * entirely. The batch API captures exactly the marks present at drain
 * time and clears only those, and only at their captured write token.
 *
 * Cycle-8 replaced the original module-local revision counter with a
 * token persisted INSIDE the localStorage record, because localStorage
 * is shared across tabs and a module-local counter cannot see another
 * tab's write (or a post-sign-out login's re-issued counter). The three
 * hazards below — in-flight keystroke, sign-out/login, second tab — are
 * now all the same check: is the stored token still the captured one?
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

  it('restore never downgrades a mark re-committed at a newer write token', () => {
    writeDesignationJournal(KEY, 'Cooker');
    markDesignationJournalCommitted(KEY);
    const batch = takeCommittedDesignationJournalBatch();
    // While save A is failing, a newer edit commits.
    writeDesignationJournal(KEY, 'Cooker and hob');
    markDesignationJournalCommitted(KEY);
    restoreDesignationJournalBatch(batch); // stale token must not win
    const next = takeCommittedDesignationJournalBatch();
    clearDesignationJournalBatch(next);
    // Cleared at the NEW token — the newer value was carried.
    expect(readDesignationJournal(KEY)).toBeNull();
  });

  it('cycle-6: sign-out purge removes every journal and resets the mark state', () => {
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

  it('cycle-7: a pre-sign-out batch completing later cannot delete the NEXT login’s journal', () => {
    // Inspector A commits an edit; the save drains its batch and is
    // still in flight when they sign out. Inspector B signs in on the
    // same device and types in the same job/circuit. Under the old
    // revision counter the purge reset it, so B's first write was
    // revision 1 — exactly what A's batch recorded — and A's completing
    // save deleted B's journal.
    writeDesignationJournal(KEY, 'Kitchen');
    markDesignationJournalCommitted(KEY);
    const staleBatch = takeCommittedDesignationJournalBatch();
    purgeDesignationDraftState();
    writeDesignationJournal(KEY, 'Bathroom'); // next login, fresh token
    clearDesignationJournalBatch(staleBatch);
    expect(readDesignationJournal(KEY)).toBe('Bathroom');
  });

  it('cycle-8: a SECOND TAB’s newer journal is never deleted by this tab’s completing save', () => {
    // localStorage is shared across tabs but the old bookkeeping was
    // module-local, so this tab's clear compared a revision the other
    // tab never touched and deleted its record. The other tab is
    // simulated by writing the shared record directly with a foreign
    // token — exactly what a second module instance produces.
    writeDesignationJournal(KEY, 'Kitchen');
    markDesignationJournalCommitted(KEY);
    const batch = takeCommittedDesignationJournalBatch(); // this tab's save drains
    window.localStorage.setItem(
      'cm-designation-draft:' + KEY,
      JSON.stringify({ t: 'other-tab:1', v: 'Bathroom' })
    );
    clearDesignationJournalBatch(batch); // this tab's save goes durable
    expect(readDesignationJournal(KEY)).toBe('Bathroom');
  });

  it('cycle-8: a failed batch is not restored over a SECOND TAB’s newer journal', () => {
    writeDesignationJournal(KEY, 'Kitchen');
    markDesignationJournalCommitted(KEY);
    const batch = takeCommittedDesignationJournalBatch();
    window.localStorage.setItem(
      'cm-designation-draft:' + KEY,
      JSON.stringify({ t: 'other-tab:1', v: 'Bathroom' })
    );
    restoreDesignationJournalBatch(batch); // this tab's save failed
    // Nothing to re-carry: the record it named no longer exists, and
    // re-marking would let the next save delete the other tab's edit.
    expect(takeCommittedDesignationJournalBatch()).toHaveLength(0);
    expect(readDesignationJournal(KEY)).toBe('Bathroom');
  });

  it('cycle-8: a LEGACY plain-string journal still reads back, and is never token-deleted', () => {
    // Upgrade path: a record written by a pre-cycle-8 build carries no
    // token. Recovery must still find it; a token match must fail safe
    // so it survives until its own post-upgrade cycle clears it.
    window.localStorage.setItem('cm-designation-draft:' + KEY, 'Kitchen sockets');
    expect(readDesignationJournal(KEY)).toBe('Kitchen sockets');
    clearDesignationJournalBatch([[KEY, 'any-token']]);
    expect(readDesignationJournal(KEY)).toBe('Kitchen sockets');
    // Its own write→commit→drain→durable cycle does clear it.
    writeDesignationJournal(KEY, 'Kitchen sockets and lights');
    markDesignationJournalCommitted(KEY);
    clearDesignationJournalBatch(takeCommittedDesignationJournalBatch());
    expect(readDesignationJournal(KEY)).toBeNull();
  });

  it('cycle-7: a pre-sign-out batch that FAILS cannot re-mark the next login’s journal', () => {
    // The failure path is equally unsafe: restoring A's batch would
    // leave a committed mark against B's live draft, so B's very next
    // save would clear a journal whose edit it never carried.
    writeDesignationJournal(KEY, 'Kitchen');
    markDesignationJournalCommitted(KEY);
    const staleBatch = takeCommittedDesignationJournalBatch();
    purgeDesignationDraftState();
    writeDesignationJournal(KEY, 'Bathroom');
    restoreDesignationJournalBatch(staleBatch); // save A failed post-purge
    expect(takeCommittedDesignationJournalBatch()).toHaveLength(0);
    expect(readDesignationJournal(KEY)).toBe('Bathroom');
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
