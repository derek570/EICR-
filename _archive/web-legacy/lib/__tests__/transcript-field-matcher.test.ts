import { describe, it, expect, beforeEach } from "vitest";
import { TranscriptFieldMatcher, RegexMatchResult } from "../transcript-field-matcher";
import type { JobDetail } from "../types";

function emptyJob(): JobDetail {
  return {
    id: "test",
    address: "Test Address",
    status: "done",
    created_at: "2026-01-01",
    certificate_type: "EICR",
    circuits: [],
    observations: [],
    board_info: {},
  };
}

function jobWithCircuits(circuits: Array<{ ref: string; designation: string }>): JobDetail {
  const job = emptyJob();
  job.circuits = circuits.map((c) => ({
    circuit_ref: c.ref,
    circuit_designation: c.designation,
  }));
  return job;
}

describe("TranscriptFieldMatcher", () => {
  let matcher: TranscriptFieldMatcher;

  beforeEach(() => {
    matcher = new TranscriptFieldMatcher();
  });

  // ---- Circuit ref detection ----
  describe("circuit ref detection", () => {
    it("detects 'circuit 1'", () => {
      const result = matcher.match("circuit 1 Zs 0.35", emptyJob());
      expect(Object.keys(result.circuitUpdates)).toContain("1");
    });
    it("detects 'circuit two'", () => {
      const result = matcher.match("circuit two Zs 0.40", emptyJob());
      expect(Object.keys(result.circuitUpdates)).toContain("2");
    });
    it("detects 'way 3'", () => {
      const result = matcher.match("way 3 Zs 0.50", emptyJob());
      expect(Object.keys(result.circuitUpdates)).toContain("3");
    });
    it("detects ordinal 'first circuit'", () => {
      const result = matcher.match("first circuit Zs 0.30", emptyJob());
      expect(Object.keys(result.circuitUpdates)).toContain("1");
    });
    it("updates activeCircuitRef", () => {
      matcher.match("circuit 5 Zs 0.60", emptyJob());
      expect(matcher.activeCircuitRef).toBe("5");
    });
  });

  // ---- Supply fields ----
  describe("supply fields", () => {
    it("matches Ze value", () => {
      const result = matcher.match("Ze is 0.35", emptyJob());
      expect(result.supplyUpdates.ze).toBe("0.35");
    });
    it("matches Ze with 'external loop impedance'", () => {
      const result = matcher.match("external loop impedance 0.28", emptyJob());
      expect(result.supplyUpdates.ze).toBe("0.28");
    });
    it("matches PFC value", () => {
      const result = matcher.match("PFC is 2.5", emptyJob());
      expect(result.supplyUpdates.pfc).toBe("2.5");
    });
    it("matches earthing arrangement TN-C-S", () => {
      const result = matcher.match("earthing is TN-C-S", emptyJob());
      expect(result.supplyUpdates.earthingArrangement).toBe("TN-C-S");
    });
    it("matches PME as TN-C-S", () => {
      const result = matcher.match("it's PME supply", emptyJob());
      expect(result.supplyUpdates.earthingArrangement).toBe("TN-C-S");
    });
    it("matches TT", () => {
      const result = matcher.match("earthing is TT", emptyJob());
      expect(result.supplyUpdates.earthingArrangement).toBe("TT");
    });
    it("matches supply polarity confirmed", () => {
      const result = matcher.match("supply polarity confirmed", emptyJob());
      expect(result.supplyUpdates.supplyPolarityConfirmed).toBe(true);
    });
    it("matches main earth conductor CSA", () => {
      const result = matcher.match("main earthing conductor is 10 mm", emptyJob());
      expect(result.supplyUpdates.mainEarthCsa).toBe("10");
    });
    it("matches bonding conductor CSA", () => {
      const result = matcher.match("bonding conductor 10 mm", emptyJob());
      expect(result.supplyUpdates.bondingCsa).toBe("10");
    });
    it("matches bonding to water", () => {
      const result = matcher.match("bonding to water", emptyJob());
      expect(result.supplyUpdates.bondingWater).toBe("Yes");
    });
    it("matches bonding to gas", () => {
      const result = matcher.match("bonding to gas", emptyJob());
      expect(result.supplyUpdates.bondingGas).toBe("Yes");
    });
    it("matches combined bonding", () => {
      const result = matcher.match("bonding to water and gas", emptyJob());
      expect(result.supplyUpdates.bondingWater).toBe("Yes");
      expect(result.supplyUpdates.bondingGas).toBe("Yes");
    });
    it("matches earth electrode type rod", () => {
      const result = matcher.match("earth electrode type is rod", emptyJob());
      expect(result.supplyUpdates.earthElectrodeType).toBe("rod");
    });
    it("matches earth rod shorthand", () => {
      const result = matcher.match("there is an earth rod", emptyJob());
      expect(result.supplyUpdates.earthElectrodeType).toBe("rod");
    });
    it("matches earth electrode resistance", () => {
      const result = matcher.match("resistance to earth 21 ohms", emptyJob());
      expect(result.supplyUpdates.earthElectrodeResistance).toBe("21");
    });
  });

  // ---- Circuit fields ----
  describe("circuit fields", () => {
    it("matches Zs value for circuit", () => {
      const result = matcher.match("circuit 1 Zs 0.60", emptyJob());
      expect(result.circuitUpdates["1"]?.measuredZsOhm).toBe("0.60");
    });
    it("matches R1+R2 value", () => {
      const result = matcher.match("circuit 1 R1 plus R2 is 0.87", emptyJob());
      expect(result.circuitUpdates["1"]?.r1R2Ohm).toBe("0.87");
    });
    it("matches IR live to earth", () => {
      const result = matcher.match("circuit 1 insulation resistance live to earth 299", emptyJob());
      expect(result.circuitUpdates["1"]?.irLiveEarthMohm).toBe("299");
    });
    it("matches IR greater than", () => {
      const result = matcher.match("circuit 1 insulation resistance greater than 200", emptyJob());
      expect(result.circuitUpdates["1"]?.irLiveEarthMohm).toBe(">200");
    });
    it("matches RCD time", () => {
      const result = matcher.match("circuit 1 RCD 20 ms", emptyJob());
      expect(result.circuitUpdates["1"]?.rcdTimeMs).toBe("20");
    });
    it("matches OCPD rating before device", () => {
      const result = matcher.match("circuit 1 32 amp MCB", emptyJob());
      expect(result.circuitUpdates["1"]?.ocpdRatingA).toBe("32");
    });
    it("matches OCPD rating after device", () => {
      const result = matcher.match("circuit 1 MCB rated 32 amp", emptyJob());
      expect(result.circuitUpdates["1"]?.ocpdRatingA).toBe("32");
    });
    it("matches OCPD type", () => {
      const result = matcher.match("circuit 1 type B", emptyJob());
      expect(result.circuitUpdates["1"]?.ocpdType).toBe("B");
    });
    it("matches polarity confirmed", () => {
      const result = matcher.match("circuit 1 polarity ok", emptyJob());
      expect(result.circuitUpdates["1"]?.polarityConfirmed).toBe("OK");
    });
    it("matches RCD button ok", () => {
      const result = matcher.match("circuit 1 test button ok", emptyJob());
      expect(result.circuitUpdates["1"]?.rcdButtonConfirmed).toBe("OK");
    });
    it("matches AFDD confirmed", () => {
      const result = matcher.match("circuit 1 AFDD ok", emptyJob());
      expect(result.circuitUpdates["1"]?.afddButtonConfirmed).toBe("OK");
    });
    it("matches cable size", () => {
      const result = matcher.match("circuit 1 cable size 2.5 mm", emptyJob());
      expect(result.circuitUpdates["1"]?.liveCsaMm2).toBe("2.5");
    });
    it("matches number of points", () => {
      const result = matcher.match("circuit 1 number of points 8", emptyJob());
      expect(result.circuitUpdates["1"]?.numberOfPoints).toBe("8");
    });
    it("matches wiring type", () => {
      const result = matcher.match("circuit 1 wiring type A", emptyJob());
      expect(result.circuitUpdates["1"]?.wiringType).toBe("A");
    });
    it("matches reference method", () => {
      const result = matcher.match("circuit 1 reference method A", emptyJob());
      expect(result.circuitUpdates["1"]?.refMethod).toBe("A");
    });
  });

  // ---- Ring circuit fields ----
  describe("ring circuit fields", () => {
    it("matches ring R1 (lives) for ring circuit", () => {
      const job = jobWithCircuits([{ ref: "1", designation: "Sockets" }]);
      const result = matcher.match("circuit 1 lives are 0.93", job);
      expect(result.circuitUpdates["1"]?.ringR1Ohm).toBe("0.93");
    });
    it("matches ring Rn (neutrals) for ring circuit", () => {
      const job = jobWithCircuits([{ ref: "1", designation: "Sockets" }]);
      const result = matcher.match("circuit 1 neutrals 0.91", job);
      expect(result.circuitUpdates["1"]?.ringRnOhm).toBe("0.91");
    });
    it("matches ring R2 (earths) for ring circuit", () => {
      const job = jobWithCircuits([{ ref: "1", designation: "Ring Main" }]);
      const result = matcher.match("circuit 1 earths 1.33", job);
      expect(result.circuitUpdates["1"]?.ringR2Ohm).toBe("1.33");
    });
    it("does NOT match ring fields for non-ring circuit", () => {
      const job = jobWithCircuits([{ ref: "1", designation: "Lighting" }]);
      const result = matcher.match("circuit 1 lives are 0.93", job);
      expect(result.circuitUpdates["1"]?.ringR1Ohm).toBeUndefined();
    });
  });

  // ---- IR postfix patterns ----
  describe("IR postfix patterns", () => {
    it("matches 'greater than 299 MΩ live to earth'", () => {
      const result = matcher.match("circuit 1 greater than 299 MΩ live to earth", emptyJob());
      expect(result.circuitUpdates["1"]?.irLiveEarthMohm).toBe(">299");
    });
    it("matches 'live to live 200'", () => {
      const result = matcher.match("circuit 1 live to live 200", emptyJob());
      expect(result.circuitUpdates["1"]?.irLiveLiveMohm).toBe("200");
    });
  });

  // ---- Board fields ----
  describe("board fields", () => {
    it("matches manufacturer Hager", () => {
      const result = matcher.match("the board is a Hager", emptyJob());
      expect(result.boardUpdates.manufacturer).toBe("Hager");
    });
    it("matches manufacturer BG as British General", () => {
      const result = matcher.match("it's a BG board", emptyJob());
      expect(result.boardUpdates.manufacturer).toBe("British General");
    });
    it("matches Zs at board", () => {
      const result = matcher.match("Zs at the board is 0.35", emptyJob());
      expect(result.boardUpdates.zsAtDb).toBe("0.35");
    });
  });

  // ---- Installation fields ----
  describe("installation fields", () => {
    it("matches client name", () => {
      // Note: the title (Mrs/Mr) is consumed by the regex but not captured
      const result = matcher.match("client name is Mrs Smith.", emptyJob());
      expect(result.installationUpdates.clientName).toBe("Smith");
    });
    it("matches premises description", () => {
      const result = matcher.match("it is a residential property", emptyJob());
      expect(result.installationUpdates.premisesDescription).toBe("Residential");
    });
    it("matches next inspection years", () => {
      const result = matcher.match("recommend 5 years", emptyJob());
      expect(result.installationUpdates.nextInspectionYears).toBe(5);
    });
  });

  // ---- New circuit detection ----
  describe("new circuit detection", () => {
    it("detects new circuit with designation", () => {
      const result = matcher.match("circuit 1 sockets", emptyJob());
      expect(result.newCircuits.length).toBe(1);
      expect(result.newCircuits[0].circuitRef).toBe("1");
      expect(result.newCircuits[0].designation).toBe("Sockets");
    });
    it("does not create duplicate circuit", () => {
      const job = jobWithCircuits([{ ref: "1", designation: "Sockets" }]);
      const result = matcher.match("circuit 1 sockets", job);
      expect(result.newCircuits.length).toBe(0);
    });
    it("detects kitchen lights designation", () => {
      const result = matcher.match("circuit 2 kitchen lights", emptyJob());
      expect(result.newCircuits.length).toBe(1);
      expect(result.newCircuits[0].designation).toBe("Kitchen Lighting");
    });
  });

  // ---- Sliding window ----
  describe("sliding window", () => {
    it("does not re-match already processed text", () => {
      matcher.match("Ze is 0.35", emptyJob());
      const result2 = matcher.match("Ze is 0.35", emptyJob());
      expect(result2.supplyUpdates.ze).toBeUndefined();
    });
    it("matches new text appended", () => {
      matcher.match("Ze is 0.35", emptyJob());
      const result2 = matcher.match("Ze is 0.35 PFC 2.5", emptyJob());
      expect(result2.supplyUpdates.pfc).toBe("2.5");
    });
  });

  // ---- Segmentation ----
  describe("circuit segmentation", () => {
    it("assigns fields to correct circuits", () => {
      const result = matcher.match("circuit 1 Zs 0.35 circuit 2 Zs 0.60", emptyJob());
      expect(result.circuitUpdates["1"]?.measuredZsOhm).toBe("0.35");
      expect(result.circuitUpdates["2"]?.measuredZsOhm).toBe("0.60");
    });
  });

  // ---- Designation resolution ----
  describe("designation resolution", () => {
    it("resolves 'sockets' to 'Sockets'", () => {
      const result = matcher.match("circuit 1 sockets", emptyJob());
      expect(result.newCircuits[0]?.designation).toBe("Sockets");
    });
    it("resolves 'ring main' to 'Sockets'", () => {
      const result = matcher.match("circuit 1 ring main", emptyJob());
      expect(result.newCircuits[0]?.designation).toBe("Sockets");
    });
    it("resolves 'upstairs sockets' to 'Upstairs Sockets'", () => {
      const result = matcher.match("circuit 3 upstairs sockets", emptyJob());
      expect(result.newCircuits[0]?.designation).toBe("Upstairs Sockets");
    });
  });

  // ---- Wiring type vs OCPD type ----
  describe("wiring type disambiguation", () => {
    it("does not set OCPD type when wiring type context present", () => {
      const result = matcher.match("circuit 1 wiring type A", emptyJob());
      expect(result.circuitUpdates["1"]?.wiringType).toBe("A");
      // OCPD type should not be set from "wiring type A"
      expect(result.circuitUpdates["1"]?.ocpdType).toBeUndefined();
    });
  });

  // ---- Earthing map ----
  describe("earthing map", () => {
    it("maps 'separate earth' to 'TN-S'", () => {
      const result = matcher.match("separate earth", emptyJob());
      expect(result.supplyUpdates.earthingArrangement).toBe("TN-S");
    });
    it("maps 'earth rod' to 'TT'", () => {
      const result = matcher.match("earth rod supply", emptyJob());
      expect(result.supplyUpdates.earthingArrangement).toBe("TT");
    });
  });

  // ---- Validation ranges ----
  describe("value validation ranges", () => {
    it("rejects Ze > 5.0", () => {
      const result = matcher.match("Ze is 10.0", emptyJob());
      expect(result.supplyUpdates.ze).toBeUndefined();
    });
    it("rejects PFC > 50.0", () => {
      const result = matcher.match("PFC 100", emptyJob());
      expect(result.supplyUpdates.pfc).toBeUndefined();
    });
  });
});
