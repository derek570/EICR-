import {
  POSTCODE_HINT_STATE,
  canonicalisePostcodeHint,
  combinePostcodeHintStates,
  resolvePostcodeHintState,
} from '../extraction/postcode-hint.js';

describe('postcode hint trust boundary', () => {
  test.each([
    ['cl165nu', 'CL16 5NU'],
    [' c l 1 6 5 n u ', 'CL16 5NU'],
    ['SW1A 1AA', 'SW1A 1AA'],
  ])('canonicalises bounded UK shapes', (input, expected) => {
    expect(canonicalisePostcodeHint(input)).toBe(expected);
  });

  test.each([
    null,
    42,
    '',
    'NOT A POSTCODE',
    'A'.repeat(33),
    'SW1A\n1AA',
    'SW1A\r1AA',
    'SW1A\t1AA',
    'SW1A\u00001AA',
    'SW1A\u007f1AA',
  ])('rejects malformed or abusive hint %p', (input) => {
    expect(canonicalisePostcodeHint(input)).toBeNull();
  });

  test('dedicated malformed property blocks a valid legacy fallback', () => {
    const message = {
      postcode_hint: 'bad',
      regexResults: [{ field: 'install.postcode', value: 'CL16 5NU' }],
    };
    expect(resolvePostcodeHintState(message)).toEqual({
      state: 'present_invalid',
      source: 'dedicated',
    });
    expect(message[POSTCODE_HINT_STATE]).toEqual({
      state: 'present_invalid',
      source: 'dedicated',
    });
  });

  test('dedicated control-character postcode remains invalid and blocks fallback', () => {
    expect(
      resolvePostcodeHintState({
        postcode_hint: 'SW1A\n1AA',
        regexResults: [{ field: 'install.postcode', value: 'CL16 5NU' }],
      })
    ).toEqual({ state: 'present_invalid', source: 'dedicated' });
  });

  test('legacy fallback uses only the last valid current-message postcode', () => {
    expect(
      resolvePostcodeHintState({
        regexResults: [
          { field: 'install.postcode', value: 'SW1A 1AA' },
          { field: 'install.postcode', value: 'bad' },
          { field: 'install.postcode', value: 'CL16 5NU' },
        ],
      })
    ).toEqual({ state: 'present_valid', source: 'legacy_regex', postcode: 'CL16 5NU' });
  });

  test('batch gives the final dedicated property precedence even when invalid', () => {
    expect(
      combinePostcodeHintStates([
        {
          postcodeHintState: {
            state: 'present_valid',
            source: 'dedicated',
            postcode: 'SW1A 1AA',
          },
        },
        { postcodeHintState: { state: 'present_invalid', source: 'dedicated' } },
      ])
    ).toEqual({ state: 'present_invalid', source: 'dedicated' });
  });

  test('batch has no sticky fallback when no member supplies evidence', () => {
    expect(combinePostcodeHintStates([])).toEqual({ state: 'absent', source: 'none' });
  });
});
