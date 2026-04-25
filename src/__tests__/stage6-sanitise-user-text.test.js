/**
 * Stage 6 Phase 3 Plan 03-10 Task 2 — sanitiseUserText() unit tests.
 *
 * WHAT: Locks the contract for the pure helper that caps + scrubs the
 * user_text payload on ask_user_answered before either CloudWatch logs or
 * Anthropic tool_result bodies see it. This is NOT a prompt-injection
 * detector — that's a model-alignment concern. STR-05 (Phase 8) will add
 * retention-based PII redaction at the analyzer layer; this helper is
 * string hygiene only (length cap + C0 control-character strip).
 *
 * WHY a dedicated pure-function test file: the wiring tests in
 * sonnet-stream-ask-routing.test.js drive a real WebSocket harness and are
 * slow to iterate on. Exhaustive edge-case coverage for the sanitiser
 * lives here where tests run in sub-millisecond time.
 */

import { describe, test, expect } from '@jest/globals';
import {
  sanitiseUserText,
  MAX_USER_TEXT_LEN,
  HARD_REJECT_USER_TEXT_LEN,
} from '../extraction/stage6-sanitise-user-text.js';

describe('sanitiseUserText() — contract', () => {
  test('short clean string passes through unchanged with flags both false', () => {
    const res = sanitiseUserText('Circuit 5 reads 0.25 ohms');
    expect(res.text).toBe('Circuit 5 reads 0.25 ohms');
    expect(res.truncated).toBe(false);
    expect(res.stripped).toBe(false);
  });

  test('preserves allowed whitespace (tab, LF, CR) verbatim', () => {
    const input = 'line1\nline2\tcol\r\nline3';
    const res = sanitiseUserText(input);
    expect(res.text).toBe(input);
    expect(res.stripped).toBe(false);
  });

  test('strips NUL (0x00) and flags stripped=true', () => {
    const res = sanitiseUserText('hello\x00world');
    expect(res.text).toBe('helloworld');
    expect(res.stripped).toBe(true);
    expect(res.truncated).toBe(false);
  });

  test('strips all C0 controls EXCEPT \\t \\n \\r and flags stripped=true', () => {
    // 0x00-0x08 (NUL..BS), 0x0B (VT), 0x0C (FF), 0x0E-0x1F all stripped.
    const controls = [
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
      0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    ];
    const dirty = 'a' + controls.map((c) => String.fromCharCode(c)).join('') + 'b';
    const res = sanitiseUserText(dirty);
    expect(res.text).toBe('ab');
    expect(res.stripped).toBe(true);
  });

  test('strips DEL (0x7F) and flags stripped=true', () => {
    const res = sanitiseUserText('hello\x7Fworld');
    expect(res.text).toBe('helloworld');
    expect(res.stripped).toBe(true);
  });

  test('truncates at MAX_USER_TEXT_LEN and flags truncated=true', () => {
    const input = 'a'.repeat(MAX_USER_TEXT_LEN + 500);
    const res = sanitiseUserText(input);
    expect(res.text.length).toBe(MAX_USER_TEXT_LEN);
    expect(res.text).toBe('a'.repeat(MAX_USER_TEXT_LEN));
    expect(res.truncated).toBe(true);
    expect(res.stripped).toBe(false);
  });

  test('string of length exactly MAX_USER_TEXT_LEN is NOT truncated', () => {
    const input = 'a'.repeat(MAX_USER_TEXT_LEN);
    const res = sanitiseUserText(input);
    expect(res.text.length).toBe(MAX_USER_TEXT_LEN);
    expect(res.truncated).toBe(false);
  });

  test('controls stripped BEFORE length check — length after strip can fit', () => {
    // 2048 + 100 = 2148 raw, but 100 of those are NULs. After strip: 2048.
    const input = 'a'.repeat(MAX_USER_TEXT_LEN) + '\x00'.repeat(100);
    const res = sanitiseUserText(input);
    expect(res.text.length).toBe(MAX_USER_TEXT_LEN);
    expect(res.stripped).toBe(true);
    expect(res.truncated).toBe(false);
  });

  test('above hard reject length throws Error with rejected flag', () => {
    const input = 'a'.repeat(HARD_REJECT_USER_TEXT_LEN + 1);
    expect(() => sanitiseUserText(input)).toThrow(/user_text_too_long/);
  });

  test('exactly at hard reject length is accepted (truncated)', () => {
    const input = 'a'.repeat(HARD_REJECT_USER_TEXT_LEN);
    const res = sanitiseUserText(input);
    expect(res.text.length).toBe(MAX_USER_TEXT_LEN);
    expect(res.truncated).toBe(true);
  });

  test('non-string input (number) throws TypeError', () => {
    expect(() => sanitiseUserText(42)).toThrow(TypeError);
  });

  test('non-string input (null) throws TypeError', () => {
    expect(() => sanitiseUserText(null)).toThrow(TypeError);
  });

  test('non-string input (undefined) throws TypeError', () => {
    expect(() => sanitiseUserText(undefined)).toThrow(TypeError);
  });

  test('empty string passes through with both flags false', () => {
    const res = sanitiseUserText('');
    expect(res.text).toBe('');
    expect(res.truncated).toBe(false);
    expect(res.stripped).toBe(false);
  });

  test('unicode (emoji, CJK) passes through unchanged', () => {
    const input = 'Circuit 五 reads 0.25 ⚡ ohms';
    const res = sanitiseUserText(input);
    expect(res.text).toBe(input);
    expect(res.stripped).toBe(false);
  });

  test('MAX_USER_TEXT_LEN is 2048 and HARD_REJECT_USER_TEXT_LEN is 8192', () => {
    expect(MAX_USER_TEXT_LEN).toBe(2048);
    expect(HARD_REJECT_USER_TEXT_LEN).toBe(8192);
  });
});
