import { describe, it, expect } from "vitest";
import { normalise } from "../number-normaliser";

describe("NumberNormaliser", () => {
  // Step 0pre: Mixed spoken zero + "point" + numeric
  describe("spoken zero + point + numeric", () => {
    it("converts 'Nought Point 0.87' to '0.87'", () => {
      expect(normalise("Nought Point 0.87")).toBe("0.87");
    });
    it("converts 'nought point 0.34' to '0.34'", () => {
      expect(normalise("nought point 0.34")).toBe("0.34");
    });
    it("converts 'zero point 87' to '0.87'", () => {
      expect(normalise("zero point 87")).toBe("0.87");
    });
  });

  // Step 0a: Implied decimal
  describe("implied decimal (zero-word + 2-3 digit number)", () => {
    it("converts 'nought 88' to '0.88'", () => {
      expect(normalise("nought 88")).toBe("0.88");
    });
    it("converts 'naught 14' to '0.14'", () => {
      expect(normalise("naught 14")).toBe("0.14");
    });
    it("converts 'oh 75' to '0.75'", () => {
      expect(normalise("oh 75")).toBe("0.75");
    });
  });

  // Step 0b: Stray digit words before numeric with decimal
  describe("stray digit word before decimal number", () => {
    it("converts 'naught 0.14' to '0.14'", () => {
      expect(normalise("naught 0.14")).toBe("0.14");
    });
    it("converts 'nought 0.35' to '0.35'", () => {
      expect(normalise("nought 0.35")).toBe("0.35");
    });
    it("converts 'no 0.27' to '0.27'", () => {
      expect(normalise("no 0.27")).toBe("0.27");
    });
  });

  // Step 0c: Glued digit word
  describe("glued digit word + digits", () => {
    it("converts 'Nought0.87' to '0.87'", () => {
      expect(normalise("Nought0.87")).toBe("0.87");
    });
    it("converts 'nought87' to '0.87'", () => {
      expect(normalise("nought87")).toBe("0.87");
    });
  });

  // Step 1: Spoken abbreviations
  describe("spoken abbreviations", () => {
    it("converts 'zed s' to 'Zs'", () => {
      expect(normalise("zed s")).toBe("Zs");
    });
    it("converts 'zed ss' to 'Zs'", () => {
      expect(normalise("zed ss")).toBe("Zs");
    });
    it("converts 'zed sess' to 'Zs'", () => {
      expect(normalise("zed sess")).toBe("Zs");
    });
    it("converts 'zed e' to 'Ze'", () => {
      expect(normalise("zed e")).toBe("Ze");
    });
    it("converts 'zeddy' to 'Ze'", () => {
      expect(normalise("zeddy")).toBe("Ze");
    });
    it("converts 'zedee' to 'Ze'", () => {
      expect(normalise("zedee")).toBe("Ze");
    });
    it("converts 'p f c' to 'PFC'", () => {
      expect(normalise("p f c")).toBe("PFC");
    });
    it("converts 'm c b' to 'MCB'", () => {
      expect(normalise("m c b")).toBe("MCB");
    });
    it("converts 'r c b o' to 'RCBO'", () => {
      expect(normalise("r c b o")).toBe("RCBO");
    });
    it("converts 'r c d' to 'RCD'", () => {
      expect(normalise("r c d")).toBe("RCD");
    });
    it("converts 'a f d d' to 'AFDD'", () => {
      expect(normalise("a f d d")).toBe("AFDD");
    });
    it("converts 'c p c' to 'CPC'", () => {
      expect(normalise("c p c")).toBe("CPC");
    });
    it("converts 'r one' to 'R1'", () => {
      expect(normalise("r one")).toBe("R1");
    });
    it("converts 'r two' to 'R2'", () => {
      expect(normalise("r two")).toBe("R2");
    });
  });

  // Step 2: Hundreds
  describe("hundreds", () => {
    it("converts 'three hundred' to '300'", () => {
      expect(normalise("three hundred")).toBe("300");
    });
    it("converts 'two hundred' to '200'", () => {
      expect(normalise("two hundred")).toBe("200");
    });
    it("converts 'five hundred' to '500'", () => {
      expect(normalise("five hundred")).toBe("500");
    });
  });

  // Step 3: Spoken decimals
  describe("spoken decimals", () => {
    it("converts 'nought point two seven' to '0.27'", () => {
      expect(normalise("nought point two seven")).toBe("0.27");
    });
    it("converts 'one point five' to '1.5'", () => {
      expect(normalise("one point five")).toBe("1.5");
    });
    it("converts 'zero point three five' to '0.35'", () => {
      expect(normalise("zero point three five")).toBe("0.35");
    });
    it("converts 'nought point eight' to '0.8'", () => {
      expect(normalise("nought point eight")).toBe("0.8");
    });
    it("handles 3 decimal places: 'two point one two three'", () => {
      expect(normalise("two point one two three")).toBe("2.123");
    });
  });

  // Step 4: Implied zero decimal
  describe("implied zero decimal (point without leading zero-word)", () => {
    it("converts 'point two seven' to '0.27'", () => {
      expect(normalise("point two seven")).toBe("0.27");
    });
    it("converts 'point five' to '0.5'", () => {
      expect(normalise(" point five")).toContain("0.5");
    });
  });

  // Step 5: Tens + ones
  describe("tens + ones", () => {
    it("converts 'twenty one' to '21'", () => {
      expect(normalise("twenty one")).toBe("21");
    });
    it("converts 'thirty two' to '32'", () => {
      expect(normalise("thirty two")).toBe("32");
    });
    it("converts 'sixty three' to '63'", () => {
      expect(normalise("sixty three")).toBe("63");
    });
  });

  // Step 6: Teens
  describe("teens", () => {
    it("converts 'thirteen' to '13'", () => {
      expect(normalise("thirteen")).toBe("13");
    });
    it("converts 'sixteen' to '16'", () => {
      expect(normalise("sixteen")).toBe("16");
    });
    it("converts 'nineteen' to '19'", () => {
      expect(normalise("nineteen")).toBe("19");
    });
  });

  // Step 7a: Tens-plurals
  describe("tens-plurals", () => {
    it("converts 'twenties' to '20'", () => {
      expect(normalise("twenties")).toBe("20");
    });
    it("converts 'thirties' to '30'", () => {
      expect(normalise("thirties")).toBe("30");
    });
  });

  // Step 7b: Standalone tens
  describe("standalone tens", () => {
    it("converts 'twenty' to '20'", () => {
      expect(normalise("twenty")).toBe("20");
    });
    it("converts 'thirty' to '30'", () => {
      expect(normalise("thirty")).toBe("30");
    });
    it("converts 'fifty' to '50'", () => {
      expect(normalise("fifty")).toBe("50");
    });
    it("converts 'ninety' to '90'", () => {
      expect(normalise("ninety")).toBe("90");
    });
  });

  // Step 8: Digit sequence collapse
  describe("digit sequence collapse", () => {
    it("converts '2 9 9' to '299'", () => {
      expect(normalise("2 9 9")).toBe("299");
    });
    it("converts '6 0' to '60'", () => {
      expect(normalise("6 0")).toBe("60");
    });
  });

  // Step 8b: point + digits
  describe("point + already-numeric digits", () => {
    it("converts 'point 60' to '0.60'", () => {
      expect(normalise("Zs point 60")).toBe("Zs 0.60");
    });
    it("converts 'point 35' to '0.35'", () => {
      expect(normalise(" point 35")).toContain("0.35");
    });
  });

  // Step 9: Unit normalisation
  describe("unit normalisation", () => {
    it("converts 'meg ohms' to 'MΩ'", () => {
      expect(normalise("200 meg ohms")).toBe("200 MΩ");
    });
    it("converts 'mega ohms' to 'MΩ'", () => {
      expect(normalise("200 mega ohms")).toBe("200 MΩ");
    });
    it("converts 'megohms' to 'MΩ'", () => {
      expect(normalise("megohms")).toBe("MΩ");
    });
    it("converts 'ohms' to 'Ω'", () => {
      expect(normalise("0.35 ohms")).toBe("0.35 Ω");
    });
    it("converts 'milliamps' to 'mA'", () => {
      expect(normalise("30 milliamps")).toBe("30 mA");
    });
    it("converts 'milliseconds' to 'ms'", () => {
      expect(normalise("20 milliseconds")).toBe("20 ms");
    });
    it("converts 'mil squared' to 'mm²'", () => {
      expect(normalise("2.5 mil squared")).toBe("2.5 mm²");
    });
    it("converts 'mm squared' to 'mm²'", () => {
      expect(normalise("2.5 mm squared")).toBe("2.5 mm²");
    });
  });

  // Integration / real-world examples
  describe("real-world examples", () => {
    it("handles 'Ze is nought point two seven ohms'", () => {
      const result = normalise("Ze is nought point two seven ohms");
      expect(result).toBe("Ze is 0.27 Ω");
    });
    it("handles 'zed s is nought point three five ohms'", () => {
      const result = normalise("zed s is nought point three five ohms");
      expect(result).toBe("Zs is 0.35 Ω");
    });
    it("handles 'r one plus r two is nought point eight'", () => {
      const result = normalise("r one plus r two is nought point eight");
      expect(result).toBe("R1 plus R2 is 0.8");
    });
    it("handles 'circuit one sixteen amp m c b'", () => {
      // Note: standalone "one" is NOT converted to "1" by NumberNormaliser
      // (only in compound contexts like decimals, tens+ones, hundreds).
      // Circuit number detection is handled by TranscriptFieldMatcher.
      const result = normalise("circuit one sixteen amp m c b");
      expect(result).toBe("circuit one 16 amp MCB");
    });
    it("handles 'insulation resistance two hundred meg ohms'", () => {
      const result = normalise("insulation resistance two hundred meg ohms");
      expect(result).toBe("insulation resistance 200 MΩ");
    });
    it("handles 'r c d trip time twenties milliseconds'", () => {
      const result = normalise("r c d trip time twenties milliseconds");
      expect(result).toBe("RCD trip time 20 ms");
    });
    it("handles 'two point five mil squared'", () => {
      const result = normalise("two point five mil squared");
      expect(result).toBe("2.5 mm²");
    });
    it("handles 'three hundred milliamps'", () => {
      const result = normalise("three hundred milliamps");
      expect(result).toBe("300 mA");
    });
    it("handles 'p f c is two point five'", () => {
      const result = normalise("p f c is two point five");
      expect(result).toBe("PFC is 2.5");
    });
  });
});
