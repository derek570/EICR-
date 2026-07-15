/**
 * NumberNormaliser unit tests — verbatim port of
 * `CertMateUnified/Tests/CertMateUnifiedTests/Whisper/NumberNormaliserTests.swift`
 * (592 lines, ~150 assertions).
 *
 * Each Swift `func testX() { XCTAssertEqual(...) }` is one `it('X', ...)`
 * block here. Test names + inputs + expected outputs match Swift one-for-one
 * so iOS↔PWA parity is provable: when iOS's NumberNormaliser changes, this
 * suite is the spec the PWA port must satisfy.
 */
import { describe, it, expect } from 'vitest';
import { normalise } from '@/lib/recording/number-normaliser';

describe('NumberNormaliser', () => {
  // MARK: - Spoken Decimal Numbers

  it('noughtPointTwoSeven', () => {
    expect(normalise('nought point two seven')).toBe('0.27');
  });

  it('noughtPointThreeFive', () => {
    expect(normalise('nought point three five')).toBe('0.35');
  });

  it('onePointFive', () => {
    expect(normalise('one point five')).toBe('1.5');
  });

  it('zeroPointSeven', () => {
    expect(normalise('zero point seven')).toBe('0.7');
  });

  it('noughtPointOneFour', () => {
    expect(normalise('nought point one four')).toBe('0.14');
  });

  it('noughtPointFourFiveEight', () => {
    expect(normalise('nought point four five eight')).toBe('0.458');
  });

  // MARK: - Implied Zero Decimal ("point X Y")

  it('pointTwoSeven', () => {
    const result = normalise('Zs point two seven');
    expect(result).toContain('0.27');
  });

  // MARK: - Whole Numbers

  it('thirtyTwo', () => {
    expect(normalise('thirty two')).toBe('32');
  });

  it('twentyOne', () => {
    expect(normalise('twenty one')).toBe('21');
  });

  it('thirteen', () => {
    expect(normalise('thirteen')).toBe('13');
  });

  it('sixteen', () => {
    expect(normalise('sixteen')).toBe('16');
  });

  it('standaloneTwenty', () => {
    expect(normalise('twenty')).toBe('20');
  });

  it('standaloneForty', () => {
    expect(normalise('forty')).toBe('40');
  });

  // MARK: - Hundreds

  it('twoHundredAndForty (bare hundreds)', () => {
    // Swift name is `testTwoHundredAndForty` but asserts plain "two hundred" → "200"
    expect(normalise('two hundred')).toBe('200');
  });

  it('threeHundred', () => {
    expect(normalise('three hundred')).toBe('300');
  });

  // MARK: - Compound Hundreds (British "<digit> hundred and <tens>[ <ones>]")

  it('twoHundredAndFifty', () => {
    expect(normalise('two hundred and fifty volts')).toBe('250 volts');
  });

  it('fiveHundredAndTen', () => {
    expect(normalise('five hundred and ten')).toBe('510');
  });

  it('threeHundredAndFortyFive', () => {
    expect(normalise('three hundred and forty five')).toBe('345');
  });

  it('twoHundredAndFifteen', () => {
    expect(normalise('two hundred and fifteen')).toBe('215');
  });

  it('twoHundredFiftyAmericanForm', () => {
    expect(normalise('two hundred fifty')).toBe('250');
  });

  it('compoundHundredInContext', () => {
    expect(normalise('test voltage was two hundred and fifty volts')).toBe(
      'test voltage was 250 volts'
    );
  });

  it('nineHundredAndNinetyNine', () => {
    expect(normalise('nine hundred and ninety nine')).toBe('999');
  });

  it('bareHundredStillWorksWhenNoTail', () => {
    expect(normalise('two hundred volts')).toBe('200 volts');
  });

  // MARK: - "nil" as a Deepgram-mishearing of "naught"

  it('nilStrippedBeforeDecimal', () => {
    expect(normalise('lives are nil 0.47')).toBe('lives are 0.47');
  });

  it('nilGluedToDigits', () => {
    expect(normalise('nil0.47')).toBe('0.47');
  });

  it('nilImpliedDecimal', () => {
    expect(normalise('nil 47')).toBe('0.47');
  });

  it('nilPointFourSeven', () => {
    expect(normalise('nil point four seven')).toBe('0.47');
  });

  // MARK: - Already Numeric (passthrough)

  it('alreadyNumericDecimal', () => {
    expect(normalise('0.27')).toBe('0.27');
  });

  it('alreadyNumericInteger', () => {
    expect(normalise('32')).toBe('32');
  });

  // MARK: - Edge Cases

  it('emptyString', () => {
    expect(normalise('')).toBe('');
  });

  it('noNumbersInText', () => {
    expect(normalise('hello world')).toBe('hello world');
  });

  it('mixedTextAndNumbers', () => {
    const result = normalise('Ze is nought point three four');
    expect(result).toContain('0.34');
  });

  // MARK: - Spoken Abbreviations

  it('zedS', () => {
    const result = normalise('zed s is nought point seven two');
    expect(result).toContain('Zs');
    expect(result).toContain('0.72');
  });

  it('zedE', () => {
    const result = normalise('zed e is nought point three four');
    expect(result).toContain('Ze');
    expect(result).toContain('0.34');
  });

  // field-feedback-2026-07-14 F10 (session 6B6FE011 06:27): "Zedi" is a
  // live Deepgram garble of "Ze". The pre-existing zed regex
  // (\bzed(?:dy|d?e(?:e)?)\b) does NOT match it, and normalise() output is
  // what the backend receives — without the alias the server still sees
  // raw "zedi". iOS canon: NumberNormaliser.swift (commit 67ffb9d).
  it('zedi → Ze (F10 garble alias)', () => {
    const result = normalise('zedi is nought point three four');
    expect(result).toContain('Ze');
    expect(result).toContain('0.34');
    expect(result.toLowerCase()).not.toContain('zedi');
  });

  it('PFC', () => {
    const result = normalise('p f c is two point five');
    expect(result).toContain('PFC');
  });

  it('MCB', () => {
    const result = normalise('m c b');
    expect(result).toContain('MCB');
  });

  it('RCBO', () => {
    const result = normalise('r c b o');
    expect(result).toContain('RCBO');
  });

  it('RCD', () => {
    const result = normalise('r c d');
    expect(result).toContain('RCD');
  });

  // MARK: - Unit Normalisation

  it('megOhms', () => {
    const result = normalise('two hundred meg ohms');
    expect(result).toContain('MΩ');
  });

  it('milliamps', () => {
    const result = normalise('thirty milliamps');
    expect(result).toContain('mA');
  });

  it('millimetresSquared', () => {
    const result = normalise('two point five mm squared');
    expect(result).toContain('mm²');
  });

  // MARK: - Stray Digit Word Before Numeric

  it('naughtBeforeDecimal', () => {
    expect(normalise('naught 0.14')).toBe('0.14');
  });

  // MARK: - Implied Decimal ("Nought 88" → "0.88")

  it('noughtEightyEight', () => {
    expect(normalise('nought 88')).toBe('0.88');
  });

  // MARK: - Digit Sequence Collapse ("2 9 9" → "299")

  it('digitSequenceCollapse', () => {
    expect(normalise('2 9 9')).toBe('299');
  });

  it('digitSequenceCollapseTwo', () => {
    expect(normalise('2 3')).toBe('23');
  });

  // MARK: - Mixed Spoken Zero + Point + Numeric

  it('noughtPointNumeric', () => {
    expect(normalise('Nought Point 0.87')).toBe('0.87');
  });

  // MARK: - Tens Plurals

  it('twenties', () => {
    expect(normalise('twenties')).toBe('20');
  });

  it('thirties', () => {
    expect(normalise('thirties')).toBe('30');
  });

  // MARK: - Standalone digit words (production bug 2026-04-27, session CA335528)

  it('standaloneFour', () => {
    expect(normalise('Number of points for cooker is four')).toBe(
      'Number of points for cooker is 4'
    );
  });

  it('standaloneTwo', () => {
    expect(normalise('Circuit two is upstairs lighting')).toBe('Circuit 2 is upstairs lighting');
  });

  it('standaloneOneInLongerSentence', () => {
    expect(normalise('set R2 for circuit one to 0.5')).toBe('set R2 for circuit 1 to 0.5');
  });

  it('standaloneNineMatches', () => {
    expect(normalise('nine points')).toBe('9 points');
  });

  it('compoundDecimalStillTakesPrecedence', () => {
    expect(normalise('Ze is nought point three five')).toBe('Ze is 0.35');
  });

  it('compoundTensOnesStillTakesPrecedence', () => {
    expect(normalise('twenty one points')).toBe('21 points');
  });

  it('hundredsCompoundStillTakesPrecedence', () => {
    expect(normalise('breaking capacity is three hundred amps')).toBe(
      'breaking capacity is 300 amps'
    );
  });

  it('zeroWordsNotConvertedStandalone', () => {
    expect(normalise('the result is naught')).toBe('the result is naught');
  });

  // MARK: - Ordinal-pronoun guard (production bug 2026-04-27, session F456A97C)
  // Policy reversal 2026-04-30, session 9FC3A6F1: "second" rewritten unconditionally
  // to "circuit" (Flux mishearing). Other ordinals still protect "one".

  it('secondOneRewrittenToCircuit', () => {
    expect(normalise('the second one is a cooker')).toBe('the circuit 1 is a cooker');
  });

  it('firstOneNotConverted', () => {
    expect(normalise('the first one is upstairs lighting')).toBe(
      'the first one is upstairs lighting'
    );
  });

  it('thirdOneNotConverted', () => {
    expect(normalise('third one is the shower')).toBe('third one is the shower');
  });

  it('nextOneNotConverted', () => {
    expect(normalise('the next one is a ring final')).toBe('the next one is a ring final');
  });

  it('lastOneNotConverted', () => {
    expect(normalise('the last one is spare')).toBe('the last one is spare');
  });

  it('anotherOneNotConverted', () => {
    expect(normalise('add another one called shower')).toBe('add another one called shower');
  });

  it('secondTwoRewrittenToCircuitTwo', () => {
    expect(normalise('second two is a shower')).toBe('circuit 2 is a shower');
  });

  it('numberOfPointsForCookerStillConverts', () => {
    expect(normalise('Number of points for cooker is four')).toBe(
      'Number of points for cooker is 4'
    );
  });

  it('naughtAfterOrdinalStillNotConverted', () => {
    expect(normalise('the third result is naught')).toBe('the third result is naught');
  });

  // MARK: - Flux Misheard "circuit" → "second" Rewrite (2026-04-30)

  it('fluxMishearCircuitOneIsACooker', () => {
    expect(normalise('Second one is, uh, a cooker.')).toBe('circuit 1 is, uh, a cooker.');
  });

  it('fluxMishearCircuitTwoIsUpstairsSockets', () => {
    expect(normalise('Second two is upstairs sockets.')).toBe('circuit 2 is upstairs sockets.');
  });

  it('fluxMishearAnswerSecondOne', () => {
    expect(normalise('second one.')).toBe('circuit 1.');
  });

  it('fluxMishearAnswerSecondTwo', () => {
    expect(normalise('Second two.')).toBe('circuit 2.');
  });

  it('pluralSecondsPreserved', () => {
    expect(normalise('trip time was 0.04 seconds')).toBe('trip time was 0.04 seconds');
  });

  it('secondaryPreserved', () => {
    expect(normalise('the secondary winding is intact')).toBe('the secondary winding is intact');
  });

  it('capitalisedSecondRewritten', () => {
    expect(normalise('Second three is a hob.')).toBe('circuit 3 is a hob.');
  });

  // MARK: - BS Code Handling (2026-04-30, session 9FC3A6F1)

  it('spelledBsCodeWithZeroWord', () => {
    expect(normalise('Six zero eight nine eight.')).toBe('60898.');
  });

  it('productionAnswerSixZeroEightNineEight', () => {
    expect(normalise('Six zero eight nine eight.')).toBe('60898.');
  });

  it('productionOcpdTriggerUtterance', () => {
    expect(
      normalise('The circuit breaker for circuit one is a b s six zero eight nine eight.')
    ).toBe('The circuit breaker for circuit 1 is BS 60898.');
  });

  it('mixedDigitAndWordWithInnerZero', () => {
    expect(normalise('6 zero 8 nine 8')).toBe('60898');
  });

  it('spelledBsEnPrefix', () => {
    expect(normalise('a b s e n 61009')).toBe('BS EN 61009');
  });

  it('spelledBsPrefixWithDots', () => {
    expect(normalise('A. B. S. 60898')).toBe('BS 60898');
  });

  it('bareAbsNotTouched', () => {
    expect(normalise('the abs system is fine')).toBe('the abs system is fine');
  });

  it('absoluteNotTouched', () => {
    // "zero" survives as standalone (step 8e requires it sandwiched between digits;
    // "is" is not a digit).
    expect(normalise('absolute zero is cold')).toBe('absolute zero is cold');
  });

  it('zeroAfterPluralSecondsPreserved', () => {
    expect(normalise('zero seconds remaining')).toBe('zero seconds remaining');
  });
});
