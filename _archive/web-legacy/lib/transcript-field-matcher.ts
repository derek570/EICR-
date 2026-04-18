/**
 * TranscriptFieldMatcher — ported from CertMateUnified/Sources/Whisper/TranscriptFieldMatcher.swift
 *
 * Matches spoken transcript text against 40+ regex patterns to extract
 * structured EICR certificate fields. Uses sliding window (500 char, 200 overlap)
 * to avoid re-scanning already-processed text.
 */

import { normalise } from "./number-normaliser";
import type { JobDetail } from "./types";

// ============= Result Types =============

export interface SupplyUpdates {
  ze?: string;
  pfc?: string;
  earthingArrangement?: string;
  supplyPolarityConfirmed?: boolean;
  mainEarthCsa?: string;
  bondingCsa?: string;
  bondingWater?: string;
  bondingGas?: string;
  earthElectrodeType?: string;
  earthElectrodeResistance?: string;
}

export interface CircuitUpdates {
  measuredZsOhm?: string;
  r1R2Ohm?: string;
  ringR1Ohm?: string;
  ringRnOhm?: string;
  ringR2Ohm?: string;
  irLiveEarthMohm?: string;
  irLiveLiveMohm?: string;
  rcdTimeMs?: string;
  ocpdRatingA?: string;
  ocpdType?: string;
  polarityConfirmed?: string;
  rcdButtonConfirmed?: string;
  afddButtonConfirmed?: string;
  liveCsaMm2?: string;
  numberOfPoints?: string;
  wiringType?: string;
  refMethod?: string;
}

export interface BoardUpdates {
  manufacturer?: string;
  zsAtDb?: string;
}

export interface InstallationUpdates {
  clientName?: string;
  address?: string;
  premisesDescription?: string;
  nextInspectionYears?: number;
  clientPhone?: string;
  clientEmail?: string;
  reasonForReport?: string;
  occupierName?: string;
  dateOfPreviousInspection?: string;
  previousCertificateNumber?: string;
  estimatedAgeOfInstallation?: string;
  generalConditionOfInstallation?: string;
}

export interface NewCircuit {
  circuitRef: string;
  designation: string;
}

export interface RegexMatchResult {
  supplyUpdates: SupplyUpdates;
  circuitUpdates: Record<string, CircuitUpdates>;
  boardUpdates: BoardUpdates;
  installationUpdates: InstallationUpdates;
  newCircuits: NewCircuit[];
}

function emptyResult(): RegexMatchResult {
  return {
    supplyUpdates: {},
    circuitUpdates: {},
    boardUpdates: {},
    installationUpdates: {},
    newCircuits: [],
  };
}

function isCircuitUpdatesEmpty(u: CircuitUpdates): boolean {
  return (
    u.measuredZsOhm === undefined && u.r1R2Ohm === undefined &&
    u.ringR1Ohm === undefined && u.ringRnOhm === undefined &&
    u.ringR2Ohm === undefined && u.irLiveEarthMohm === undefined &&
    u.irLiveLiveMohm === undefined && u.rcdTimeMs === undefined &&
    u.ocpdRatingA === undefined && u.ocpdType === undefined &&
    u.polarityConfirmed === undefined && u.rcdButtonConfirmed === undefined &&
    u.afddButtonConfirmed === undefined && u.liveCsaMm2 === undefined &&
    u.numberOfPoints === undefined && u.wiringType === undefined &&
    u.refMethod === undefined
  );
}

// ============= Word Number Maps =============

const wordNumbers: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12",
};

const ordinalNumbers: Record<string, string> = {
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5",
  sixth: "6", seventh: "7", eighth: "8", ninth: "9", tenth: "10",
  eleventh: "11", twelfth: "12",
};

// ============= Designation Maps =============

const locationPrefixes = [
  "upstairs", "downstairs", "first floor", "second floor", "ground floor",
  "loft", "attic", "basement", "kitchen", "bathroom", "bedroom",
  "garage", "utility", "conservatory", "extension", "landing",
  "hallway", "lounge", "dining",
];

const designationMap: Record<string, string> = {};
for (const w of ["socket", "sockets", "ring", "ring main", "ring final", "socket ring"]) designationMap[w] = "Sockets";
for (const w of ["light", "lights", "lighting", "light circuit"]) designationMap[w] = "Lighting";
for (const w of ["cooker", "oven", "hob", "range"]) designationMap[w] = "Cooker";
for (const w of ["shower", "electric shower"]) designationMap[w] = "Shower";
for (const w of ["immersion", "immersion heater", "hot water"]) designationMap[w] = "Immersion";
for (const w of ["smoke detector", "smoke detectors", "smoke alarm", "smoke alarms", "fire alarm", "fire alarms"]) designationMap[w] = "Smoke Detectors";
designationMap["fridge freezer"] = "Fridge Freezer";
designationMap["fridge"] = "Fridge";
designationMap["freezer"] = "Freezer";
designationMap["dishwasher"] = "Dishwasher";
designationMap["washing machine"] = "Washing Machine";
designationMap["tumble dryer"] = "Tumble Dryer";
designationMap["boiler"] = "Boiler";
designationMap["towel rail"] = "Towel Rail";
designationMap["underfloor heating"] = "Underfloor Heating";
designationMap["garage"] = "Garage";
for (const w of ["shed", "outbuilding"]) designationMap[w] = "Outbuilding";
for (const w of ["outside light", "outside lights", "external light", "external lights"]) designationMap[w] = "External Lighting";
for (const w of ["alarm", "intruder alarm"]) designationMap[w] = "Intruder Alarm";
designationMap["cctv"] = "CCTV";
for (const w of ["ev charger", "car charger", "electric vehicle"]) designationMap[w] = "EV Charger";
designationMap["radial"] = "Radial";

function resolveDesignation(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (designationMap[lower]) return designationMap[lower];
  for (const prefix of locationPrefixes) {
    if (lower.startsWith(prefix + " ")) {
      const base = lower.slice(prefix.length + 1).trim();
      if (designationMap[base]) {
        return capitalize(prefix) + " " + designationMap[base];
      }
    }
  }
  return capitalize(raw);
}

function capitalize(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

const earthingMap: Record<string, string> = {
  "tn-c-s": "TN-C-S", "tn c s": "TN-C-S", "tncs": "TN-C-S",
  "pme": "TN-C-S", "combined neutral": "TN-C-S",
  "tn-c": "TN-C", "tn c": "TN-C", "tnc": "TN-C",
  "tn-s": "TN-S", "tn s": "TN-S", "tns": "TN-S",
  "separate earth": "TN-S", "lead sheath": "TN-S",
  "tt": "TT", "earth rod": "TT",
};

const stopWords = new Set([
  "is", "the", "a", "an", "at", "in", "on", "to", "of", "and",
  "are", "was", "it", "my", "our", "for", "mr", "mrs", "miss", "dr",
  "that", "this", "its", "his", "her", "not", "but", "or", "so",
  "be", "if", "as", "do", "no", "up", "he", "she", "we", "me",
]);

function isValidMultiWordValue(value: string, minLength = 2): boolean {
  if (value.length < minLength) return false;
  return !stopWords.has(value.toLowerCase());
}

// ============= Regex Helpers =============

function hasMatch(pattern: RegExp, text: string): boolean {
  const re = new RegExp(pattern.source, pattern.flags);
  return re.test(text);
}

function lastCapture(pattern: RegExp, text: string, group = 1): string | undefined {
  const re = new RegExp(pattern.source, pattern.flags);
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m;
    if (!re.global) break;
  }
  if (!last) return undefined;
  const targetGroup = group < last.length ? group : 0;
  return last[targetGroup] ?? undefined;
}

function allMatches(pattern: RegExp, text: string): RegExpExecArray[] {
  const re = new RegExp(pattern.source, pattern.flags);
  const results: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push(m);
    if (!re.global) break;
  }
  return results;
}

function isRingCircuit(designation?: string): boolean {
  if (!designation) return false;
  const lower = designation.toLowerCase().trim();
  if (!lower) return false;
  const ringKeywords = ["socket", "sockets", "ring", "ring main", "ring final", "ringmain", "continuity"];
  return ringKeywords.some((kw) => lower.includes(kw));
}

// ============= Compiled Patterns =============

const circuitRefPattern = /\b(?:(?:circuit|way)\s*(?:number\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+circuit)\b/gi;
const designationPattern = /\b((?:(?:upstairs|downstairs|first\s+floor|second\s+floor|ground\s+floor|loft|attic|basement|kitchen|bathroom|bedroom|garage|utility|conservatory|extension|landing|hallway|lounge|dining)\s+)?(?:ring\s+main|ring\s+final|ring|radial|lighting|lights?|sockets?|cooker|oven|hob|range|shower|electric\s+shower|immersion\s+heater|immersion|hot\s+water|smoke\s+detectors?|smoke\s+alarms?|fire\s+alarms?|fridge\s+freezer|fridge|freezer|dishwasher|washing\s+machine|tumble\s+dryer|boiler|towel\s+rail|underfloor\s+heating|garage|shed|outbuilding|outside\s+lights?|external\s+lights?|alarm|intruder\s+alarm|cctv|ev\s+charger|car\s+charger|electric\s+vehicle))\b/gi;
const zePattern = /\b(?:ze|z\s+e|external\s+(?:earth\s+)?(?:loop\s+)?impedance|external\s+loop)[,;:\s]+(?:is\s+|of\s+|=\s*|reading\s+)?(\d+\.?\d*)/gi;
const pfcPattern = /\b(?:pfc|pscc|prospective\s+(?:fault\s+)?(?:short\s+circuit\s+)?current)\s+(?:is\s+|of\s+|=\s*|reading\s+(?:is\s+)?)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)\s*(?:k?a|amps?)?/gi;
const earthingPattern = /\b(tn[-\s]?c[-\s]?s|tn[-\s]?c|tn[-\s]?s|tt|pme|combined\s+neutral|separate\s+earth|lead\s+sheath|earth\s+rod)/gi;
const supplyPolarityPattern = /\b(?:supply\s+)?polarity\s+(?:is\s+)?(?:confirmed|ok|pass|correct)/gi;
const mainEarthCsaPattern = /\b(?:main\s+earth(?:ing)?(?:\s+conductor)?|earth(?:ing)?\s+conductor)\s+(?:is\s+|=\s*)?(\d+\.?\d*)\s*(?:mm|mil)/gi;
const bondingCsaPattern = /\b(?:main\s+)?bonding(?:\s+conductor)?\s+(?:is\s+|=\s*)?(\d+\.?\d*)\s*(?:mm|mil)/gi;
const bondingCombinedPattern = /\bbonding?\s+(?:to\s+)?(?:the\s+)?(?:water\s+and\s+(?:to\s+)?(?:the\s+)?gas|gas\s+and\s+(?:to\s+)?(?:the\s+)?water)/gi;
const bondingWaterPattern = /\b(?:bonding?\s+(?:to\s+)?(?:the\s+)?water|water\s+bonding?\s*(?:is\s+)?(?:confirmed|ok|yes|done|pass|present|installed))/gi;
const bondingGasPattern = /\b(?:bonding?\s+(?:to\s+)?(?:the\s+)?gas|gas\s+bonding?\s*(?:is\s+)?(?:confirmed|ok|yes|done|pass|present|installed))/gi;
const bondingCombinedGapPattern = /\bbonding\b.{0,50}\bto\s+(?:the\s+)?(?:water\s+and\s+(?:to\s+)?(?:the\s+)?gas|gas\s+and\s+(?:to\s+)?(?:the\s+)?water)/gi;
const bondingWaterGapPattern = /\bbonding\b.{0,50}\bto\s+(?:the\s+)?water\b/gi;
const bondingGasGapPattern = /\bbonding\b.{0,50}\bto\s+(?:the\s+)?gas\b/gi;
const earthElectrodeTypePattern = /\b(?:earth\s+)?electrode\s+(?:type\s+(?:is\s+)?)?(?:is\s+)?(?:a\s+)?(rod|plate|tape|mat|other)\b/gi;
const earthRodShortPattern = /\bearth\s+rod\b/gi;
const earthElectrodeResistancePattern = /\b(?:resistance\s+(?:to\s+)?earth|earth\s+(?:electrode\s+)?resistance|r\s*a(?:\s+value)?)\s+(?:is\s+|of\s+|=\s*)?(\d+\.?\d*)\s*(?:ohms?|\u03A9)?/gi;
const zsExcludePattern = /\bzs\s+(?:at|of)\s+(?:the\s+)?(?:board|db|distribution|cu|fuse)/gi;
const zsPattern = /\bzs\s+(?:is\s+|of\s+|=\s*)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const zsFlexPattern = /\bzs\s+(?:for\s+|at\s+|on\s+)?(?:\w+\s+){0,5}(?:is\s+|reading\s+(?:is\s+)?)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const r1r2Pattern = /\br\s*1\s*(?:\+|plus|and)\s*r\s*2\s+(?:(?:for\s+circuit\s+\d+\s+(?:is\s+)?)?(?:is\s+)?)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const r1r2FlexPattern = /\br\s*1\s*(?:\+|plus|and)\s*r\s*2\s+(?:for\s+|on\s+)?(?:\w+[.,;:\s]+){0,5}(?:is\s+|reading\s+(?:is\s+)?)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const ringR1Pattern = /\b(?:ring\s+)?r\s*1\s+(?:is\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const explicitRingR1Pattern = /\bring\s+r\s*1\s+(?:is\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const ringRnPattern = /\b(?:rn|neutrals?|nuts)\s+(?:(?:is|are)\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const ringR2Pattern = /\b(?:ring\s+)?r\s*2\s+(?:is\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const explicitRingR2Pattern = /\bring\s+r\s*2\s+(?:is\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const ringLivesPattern = /\blives?\s+(?:(?:is|are)\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const ringNeutralsPattern = /\b(?:neutrals?|nuts)\s+(?:(?:is|are)\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const ringEarthsPattern = /\bearths?\s+(?:(?:is|are)\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)(?:\s*(?:ohms?|\u03A9))?/gi;
const irLiveEarthPattern = /\b(?:ir|insulation\s+resistance|inssy|megger|megging|(?:live|light)\s+(?:to\s+)?earth|l[-\u2013]?e|l2[eh])\s+(?:(?:is|was|reads?)\s+)?(?:also\s+)?(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)(?:\s*(?:mega?\s*ohms?|M\u03A9|grooms?|meg))?/gi;
const irGreaterPattern = /\b(?:ir|insulation\s+resistance|inssy|megger|megging|(?:live|light)\s+(?:to\s+)?earth|l[-\u2013]?e|l2[eh])\s+(?:(?:is|was|reads?)\s+)?(?:also\s+)?(?:greater\s+than|more\s+than|>|over)\s+(\d+\.?\d*)/gi;
const irBridgingPattern = /\b(?:ir|insulation\s+resistance|inssy|megger)\s+(?:.*?circuit\s+\d+.*?)(?:(?:is|was|reads?)\s+)?(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)/gi;
const irLiveLivePattern = /\b(?:live\s+to\s+(?:lives?|neutral)|l[-\u2013]l)\s+(?:(?:is|are)\s+)?(?:also\s+)?(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)/gi;
const irLLGreaterPattern = /\b(?:live\s+to\s+(?:lives?|neutral)|l[-\u2013]l)\s+(?:(?:is|are)\s+)?(?:also\s+)?(?:greater\s+than|more\s+than|>|over)\s+(\d+\.?\d*)/gi;
const irLiveEarthPostfixPattern = /(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)\s*(?:mega?\s*ohms?|M\u03A9|grooms?|rooms?)?\s+(?:live|light)\s+to\s+earth/gi;
const irLEPostfixGreaterPattern = /(?:greater\s+than|more\s+than|>|over)\s+(\d+\.?\d*)\s*(?:mega?\s*ohms?|M\u03A9|grooms?|rooms?)?\s+(?:live|light)\s+to\s+earth/gi;
const irLiveLivePostfixPattern = /(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)\s*(?:mega?\s*ohms?|M\u03A9|grooms?|rooms?)?\s+live\s+to\s+(?:lives?|neutral)/gi;
const irLLPostfixGreaterPattern = /(?:greater\s+than|more\s+than|>|over)\s+(\d+\.?\d*)\s*(?:mega?\s*ohms?|M\u03A9|grooms?|rooms?)?\s+live\s+to\s+(?:lives?|neutral)/gi;
const testVoltagePattern = /\b(?:test\s+)?voltage\s+(?:is\s+|of\s+|=\s*)?(\d+)/gi;
const rcdTimePattern = /\brcd\s+(?:trip\s+(?:time\s+)?)?(?:is\s+)?(\d+\.?\d*)\s*(?:ms|milliseconds?)?/gi;
const ocpdRatingBeforePattern = /\b(\d+)\s*(?:amp|a)\s+(?:mcb|rcbo|rccb|breaker|circuit\s+breaker|miniature\s+circuit\s+breaker)/gi;
const ocpdRatingAfterPattern = /\b(?:mcb|rcbo|rccb|breaker|circuit\s+breaker|miniature\s+circuit\s+breaker)\s+(?:is\s+|rated?\s+(?:at\s+)?)?(\d+)\s*(?:amp|a)?/gi;
const ocpdTypePattern = /\btype\s+(?:is\s+)?([a-d])\b/gi;
const wiringOrRefBeforeTypePattern = /\b(?:wir\w+|worrying|cable|ref\w*|reference|installation)\s+type\s+(?:is\s+)?[a-g]\b/gi;
const ocpdDevicePattern = /\b(mcb|rcbo|rccb)\b/gi;
const wiringTypePattern = /\b(?:wir(?:ing|rying|ring)|worrying|cable)\s+type\s+(?:is\s+)?([a-g])\b/gi;
const refMethodPattern = /\b(?:ref(?:erence)?\s+method|(?:wir(?:ing|rying|ring)|worrying)\s+method|installation\s+method)\s+(?:is\s+)?([a-g])\b/gi;
const polarityPattern = /\b(?:correct\s+)?polarity\s+(?:is\s+)?(?:ok|confirmed|pass|correct)/gi;
const rcdButtonPattern = /\b(?:rcd\s+)?(?:test\s+)?button\s+(?:is\s+)?(?:ok|works|confirmed|pass)/gi;
const afddPattern = /\bafdd\s+(?:(?:test\s+)?button\s+)?(?:is\s+)?(?:ok|works|confirmed|fitted)/gi;
const cableSizePattern = /\b(?:cable\s+size|size\s+of\s+(?:the\s+)?cable)\s+(?:is\s+)?(\d+\.?\d*)\s*(?:mm|mil)?\s*(?:squared|sq)?/gi;
const numberOfPointsPattern = /\b(?:number\s+(?:of\s+)?points|points)[,;:\s]+(?:is\s+|are\s+)?(\d+)/gi;
const numberOfPointsFlexPattern = /\b(?:number\s+(?:of\s+)?points)\s+(?:for\s+|on\s+)?(?:\w+\s+){0,5}[,;:\s]+(?:is\s+|are\s+)?(\d+)/gi;
const numberOfPointsReversePattern = /\b(\d+)\s+points\b/gi;
const manufacturerPattern = /\b(hager|mk|wylex|crabtree|bg|british\s+general|schneider|square\s+d|eaton)\b/gi;
const zsAtBoardPattern = /\bzs\s+(?:at\s+(?:the\s+)?)?(?:board|db|distribution|cu|fuse\s*board)\s+(?:is\s+)?(\d+\.?\d*)/gi;
const clientPattern = /\b(?:client|customer|tenant|occupier|owner|homeowner|landlord)(?:\s+name)?\s+(?:is\s+|name\s+is\s+)?(?:mrs?\s+|miss\s+|dr\s+)?(.+?)(?:\.|,|$)/gim;
const addressPattern = /\b(?:address|property\s+at|located\s+at|premises\s+(?:is\s+)?(?:at\s+)?)\s+(?:is\s+|at\s+)?(\d+[\.\s]+\w[\w\s,\.]+?)(?:,\s*(?:next|recommend|client|customer|earthing|ze|pfc)|supplies|supply|$)/gim;
const premisesPattern = /\b(residential|commercial|industrial|domestic|agricultural)\b/gi;
const nextInspectionPattern = /\b(?:next\s+inspection|recommend)\s+(?:in\s+)?(\d+)\s*years?/gi;
const clientPhonePattern = /\b(?:client|customer)\s+(?:phone|number|tel|telephone|mobile)\s+(?:is\s+|number\s+)?[:\s]\s*(.+?)$/gim;
const clientEmailPattern = /\b(?:client|customer)\s+(?:email|e-mail)\s+(?:is\s+|address\s+)?[:\s]\s*(.+?)$/gim;
const occupierNamePattern = /\b(?:occupier|occupant|tenant|resident)\s+(?:name\s+)?(?:is\s+)?[:\s]\s*(.+?)(?:\.|,|$)/gim;
const reasonForReportPattern = /\b(?:reason|purpose)\s+(?:for|of)\s+(?:the\s+)?(?:report|inspection|eicr|test)\s+(?:is\s+)?[:\s]\s*(.+?)$/gim;
const dateOfPreviousInspectionPattern = /\b(?:previous|last|prior)\s+(?:inspection|test|eicr)\s+(?:date\s+|was\s+)?[:\s]\s*(.+?)$/gim;
const previousCertificateNumberPattern = /\b(?:previous|last|prior)\s+(?:certificate|cert)\s+(?:number|ref|reference)\s*[:\s]\s*(.+?)$/gim;
const estimatedAgePattern = /\b(?:estimated|installation)\s+(?:age|years?\s+old)\s*(?:is\s+|of\s+installation\s+)?[:\s]\s*(.+?)$/gim;
const generalConditionPattern = /\b(?:general\s+condition|overall\s+condition|condition\s+of\s+(?:the\s+)?installation)\s*(?:is\s+)?[:\s]\s*(.+?)$/gim;

// ============= Matcher Class =============

export class TranscriptFieldMatcher {
  private lastProcessedOffset = 0;
  activeCircuitRef: string | undefined;

  reset(): void {
    this.lastProcessedOffset = 0;
    this.activeCircuitRef = undefined;
  }

  match(transcript: string, existingJob: JobDetail): RegexMatchResult {
    const newChars = transcript.length - this.lastProcessedOffset;
    if (newChars <= 0) return emptyResult();
    if (!transcript.trim()) return emptyResult();

    const windowStart = Math.max(0, this.lastProcessedOffset - 200);
    const window = transcript.slice(windowStart);

    this.lastProcessedOffset = transcript.length;

    // Normalise the window
    const normalized = normalise(window);

    this.updateActiveCircuitRef(normalized);

    const result = emptyResult();

    this.detectNewCircuits(normalized, existingJob, result);
    this.matchSupplyFields(normalized, result);
    this.matchBoardFields(normalized, result);
    this.matchInstallationFields(normalized, result);
    this.matchCircuitFieldsBySegment(normalized, existingJob, result);

    return result;
  }

  // ---- Active Circuit Detection ----

  private updateActiveCircuitRef(text: string): void {
    const matches = allMatches(circuitRefPattern, text);
    const last = matches[matches.length - 1];
    if (last) {
      const newRef = this.extractCircuitRef(last);
      if (newRef && newRef !== this.activeCircuitRef) {
        this.activeCircuitRef = newRef;
      }
    }
  }

  private extractCircuitRef(match: RegExpExecArray): string | undefined {
    if (match[1]) {
      const raw = match[1].toLowerCase();
      return wordNumbers[raw] ?? raw;
    }
    if (match[2]) {
      const raw = match[2].toLowerCase();
      return ordinalNumbers[raw] ?? raw;
    }
    return undefined;
  }

  // ---- New Circuit Detection ----

  private detectNewCircuits(text: string, existingJob: JobDetail, result: RegexMatchResult): void {
    const refMatches = allMatches(circuitRefPattern, text);
    const desigMatches = allMatches(designationPattern, text);

    for (const refMatch of refMatches) {
      const circuitRef = this.extractCircuitRef(refMatch);
      if (!circuitRef) continue;

      const refEnd = refMatch.index + refMatch[0].length;
      for (const desigMatch of desigMatches) {
        const dist = Math.abs(desigMatch.index - refEnd);
        if (dist >= 80) continue;

        const rawDesig = desigMatch[1];
        if (!rawDesig) continue;
        const designation = resolveDesignation(rawDesig);

        const exists = existingJob.circuits.some((c) => c.circuit_ref === circuitRef);
        const alreadyQueued = result.newCircuits.some((c) => c.circuitRef === circuitRef);
        if (!exists && !alreadyQueued) {
          result.newCircuits.push({ circuitRef, designation });
        }

        this.activeCircuitRef = circuitRef;
        break;
      }
    }
  }

  // ---- Circuit Field Segmentation ----

  private matchCircuitFieldsBySegment(text: string, existingJob: JobDetail, result: RegexMatchResult): void {
    const refMatches = allMatches(circuitRefPattern, text).map((m) => ({
      ref: this.extractCircuitRef(m),
      index: m.index,
      length: m[0].length,
    })).filter((m) => m.ref !== undefined) as Array<{ ref: string; index: number; length: number }>;

    if (refMatches.length === 0) {
      if (this.activeCircuitRef) {
        this.matchCircuitFields(text, existingJob, this.activeCircuitRef, result);
      }
      return;
    }

    // Text before first circuit ref
    if (refMatches[0].index > 0 && this.activeCircuitRef) {
      const preText = text.slice(0, refMatches[0].index);
      if (preText.trim()) {
        this.matchCircuitFields(preText, existingJob, this.activeCircuitRef, result);
      }
    }

    for (let i = 0; i < refMatches.length; i++) {
      const { ref, index, length } = refMatches[i];
      const segStart = index + length;
      const segEnd = i + 1 < refMatches.length ? refMatches[i + 1].index : text.length;
      if (segEnd <= segStart) continue;
      const segText = text.slice(segStart, segEnd);
      this.matchCircuitFields(segText, existingJob, ref, result);
    }
  }

  // ---- Supply Fields ----

  private matchSupplyFields(text: string, result: RegexMatchResult): void {
    const zeVal = lastCapture(zePattern, text);
    if (zeVal) {
      const num = parseFloat(zeVal);
      if (num >= 0.01 && num <= 5.0) result.supplyUpdates.ze = zeVal;
    }

    const pfcVal = lastCapture(pfcPattern, text);
    if (pfcVal) {
      const num = parseFloat(pfcVal);
      if (num >= 0.1 && num <= 50.0) result.supplyUpdates.pfc = pfcVal;
    }

    const earthVal = lastCapture(earthingPattern, text, 0);
    if (earthVal) {
      result.supplyUpdates.earthingArrangement = earthingMap[earthVal.toLowerCase()] ?? earthVal.toUpperCase();
    }

    if (hasMatch(supplyPolarityPattern, text)) {
      result.supplyUpdates.supplyPolarityConfirmed = true;
    }

    const earthCsaVal = lastCapture(mainEarthCsaPattern, text);
    if (earthCsaVal) {
      const num = parseFloat(earthCsaVal);
      if (num >= 1.0 && num <= 50.0) result.supplyUpdates.mainEarthCsa = earthCsaVal;
    }

    const bondCsaVal = lastCapture(bondingCsaPattern, text);
    if (bondCsaVal) {
      const num = parseFloat(bondCsaVal);
      if (num >= 1.0 && num <= 50.0) result.supplyUpdates.bondingCsa = bondCsaVal;
    }

    if (hasMatch(bondingCombinedPattern, text) || hasMatch(bondingCombinedGapPattern, text)) {
      result.supplyUpdates.bondingWater = "Yes";
      result.supplyUpdates.bondingGas = "Yes";
    } else {
      if (hasMatch(bondingWaterPattern, text) || hasMatch(bondingWaterGapPattern, text)) {
        result.supplyUpdates.bondingWater = "Yes";
      }
      if (hasMatch(bondingGasPattern, text) || hasMatch(bondingGasGapPattern, text)) {
        result.supplyUpdates.bondingGas = "Yes";
      }
    }

    const electrodeType = lastCapture(earthElectrodeTypePattern, text);
    if (electrodeType) {
      result.supplyUpdates.earthElectrodeType = electrodeType.toLowerCase();
    } else if (hasMatch(earthRodShortPattern, text)) {
      result.supplyUpdates.earthElectrodeType = "rod";
    }

    const electrodeRes = lastCapture(earthElectrodeResistancePattern, text);
    if (electrodeRes) {
      const num = parseFloat(electrodeRes);
      if (num >= 0.1 && num <= 1000) result.supplyUpdates.earthElectrodeResistance = electrodeRes;
    }
  }

  // ---- Circuit Fields ----

  private matchCircuitFields(text: string, existingJob: JobDetail, circuitRef: string, result: RegexMatchResult): void {
    const circuit = existingJob.circuits.find((c) => c.circuit_ref === circuitRef);
    const updates: CircuitUpdates = result.circuitUpdates[circuitRef] ?? {};

    if (!hasMatch(zsExcludePattern, text)) {
      const zsVal = lastCapture(zsPattern, text) ?? lastCapture(zsFlexPattern, text);
      if (zsVal) {
        const num = parseFloat(zsVal);
        if (num >= 0.01 && num <= 20.0) updates.measuredZsOhm = zsVal;
      }
    }

    const r1r2Val = lastCapture(r1r2Pattern, text) ?? lastCapture(r1r2FlexPattern, text);
    if (r1r2Val) {
      const num = parseFloat(r1r2Val);
      if (num >= 0.01 && num <= 10.0) updates.r1R2Ohm = r1r2Val;
    }

    const isRing = isRingCircuit(circuit?.circuit_designation);

    if (!updates.r1R2Ohm) {
      const r1Val = lastCapture(ringR1Pattern, text);
      if (r1Val) {
        const num = parseFloat(r1Val);
        if (num >= 0.01 && num <= 10.0) updates.r1R2Ohm = r1Val;
      }
    }

    if (isRing) {
      const rnVal = lastCapture(ringRnPattern, text);
      if (rnVal) {
        const num = parseFloat(rnVal);
        if (num >= 0.01 && num <= 10.0) updates.ringRnOhm = rnVal;
      }
    }

    if (!updates.r1R2Ohm) {
      const r2Val = lastCapture(ringR2Pattern, text);
      if (r2Val) {
        const num = parseFloat(r2Val);
        if (num >= 0.01 && num <= 10.0) updates.r1R2Ohm = r2Val;
      }
    }

    if (isRing) {
      if (!updates.ringR1Ohm) {
        const v = lastCapture(explicitRingR1Pattern, text);
        if (v && parseFloat(v) >= 0.01 && parseFloat(v) <= 10.0) updates.ringR1Ohm = v;
      }
      if (!updates.ringR1Ohm) {
        const v = lastCapture(ringLivesPattern, text);
        if (v && parseFloat(v) >= 0.01 && parseFloat(v) <= 10.0) updates.ringR1Ohm = v;
      }
      if (!updates.ringRnOhm) {
        const v = lastCapture(ringNeutralsPattern, text);
        if (v && parseFloat(v) >= 0.01 && parseFloat(v) <= 10.0) updates.ringRnOhm = v;
      }
      if (!updates.ringR2Ohm) {
        const v = lastCapture(explicitRingR2Pattern, text);
        if (v && parseFloat(v) >= 0.01 && parseFloat(v) <= 10.0) updates.ringR2Ohm = v;
      }
      if (!updates.ringR2Ohm) {
        const v = lastCapture(ringEarthsPattern, text);
        if (v && parseFloat(v) >= 0.01 && parseFloat(v) <= 10.0) updates.ringR2Ohm = v;
      }
    }

    const hasTestVolt = hasMatch(testVoltagePattern, text);

    if (!hasTestVolt) {
      const postfixVal = lastCapture(irLiveEarthPostfixPattern, text);
      if (postfixVal) {
        const isGreater = hasMatch(irLEPostfixGreaterPattern, text);
        updates.irLiveEarthMohm = isGreater ? `>${postfixVal}` : postfixVal;
      }
    }
    if (!updates.irLiveEarthMohm) {
      const irVal = lastCapture(irLiveEarthPattern, text) ?? lastCapture(irBridgingPattern, text);
      if (irVal) {
        const isGreater = hasMatch(irGreaterPattern, text);
        updates.irLiveEarthMohm = isGreater ? `>${irVal}` : irVal;
      }
    }

    if (!hasTestVolt) {
      const postfixVal = lastCapture(irLiveLivePostfixPattern, text);
      if (postfixVal) {
        const isGreater = hasMatch(irLLPostfixGreaterPattern, text);
        updates.irLiveLiveMohm = isGreater ? `>${postfixVal}` : postfixVal;
      }
    }
    if (!updates.irLiveLiveMohm) {
      const llVal = lastCapture(irLiveLivePattern, text);
      if (llVal) {
        const isGreater = hasMatch(irLLGreaterPattern, text);
        updates.irLiveLiveMohm = isGreater ? `>${llVal}` : llVal;
      }
    }

    const rcdVal = lastCapture(rcdTimePattern, text);
    if (rcdVal) {
      const num = parseFloat(rcdVal);
      if (num >= 1 && num <= 1000) updates.rcdTimeMs = rcdVal;
    }

    const ocpdBefore = lastCapture(ocpdRatingBeforePattern, text);
    const ocpdAfter = lastCapture(ocpdRatingAfterPattern, text);
    if (ocpdBefore) updates.ocpdRatingA = ocpdBefore;
    else if (ocpdAfter) updates.ocpdRatingA = ocpdAfter;

    const wiringVal = lastCapture(wiringTypePattern, text, 1);
    if (wiringVal) updates.wiringType = wiringVal.toUpperCase();
    const refVal = lastCapture(refMethodPattern, text, 1);
    if (refVal) updates.refMethod = refVal.toUpperCase();

    const typeVal = lastCapture(ocpdTypePattern, text);
    if (typeVal) {
      if (!hasMatch(wiringOrRefBeforeTypePattern, text)) {
        updates.ocpdType = typeVal.toUpperCase();
      }
    } else {
      const deviceVal = lastCapture(ocpdDevicePattern, text, 0);
      if (deviceVal) updates.ocpdType = deviceVal.toUpperCase();
    }

    if (hasMatch(polarityPattern, text)) updates.polarityConfirmed = "OK";
    if (hasMatch(rcdButtonPattern, text)) updates.rcdButtonConfirmed = "OK";
    if (hasMatch(afddPattern, text)) updates.afddButtonConfirmed = "OK";

    const cableVal = lastCapture(cableSizePattern, text);
    if (cableVal) updates.liveCsaMm2 = cableVal;

    const pointsVal = lastCapture(numberOfPointsPattern, text) ?? lastCapture(numberOfPointsFlexPattern, text) ?? lastCapture(numberOfPointsReversePattern, text);
    if (pointsVal) {
      const num = parseInt(pointsVal, 10);
      if (num >= 1 && num <= 50) updates.numberOfPoints = pointsVal;
    }

    if (!isCircuitUpdatesEmpty(updates)) {
      result.circuitUpdates[circuitRef] = updates;
    }
  }

  // ---- Board Fields ----

  private matchBoardFields(text: string, result: RegexMatchResult): void {
    const mfgVal = lastCapture(manufacturerPattern, text, 0);
    if (mfgVal) {
      const lower = mfgVal.toLowerCase();
      if (lower === "bg" || lower === "british general") {
        result.boardUpdates.manufacturer = "British General";
      } else if (lower === "square d") {
        result.boardUpdates.manufacturer = "Square D";
      } else {
        result.boardUpdates.manufacturer = capitalize(mfgVal);
      }
    }

    const zsVal = lastCapture(zsAtBoardPattern, text);
    if (zsVal) {
      const num = parseFloat(zsVal);
      if (num >= 0.01 && num <= 20.0) result.boardUpdates.zsAtDb = zsVal;
    }
  }

  // ---- Installation Fields ----

  private matchInstallationFields(text: string, result: RegexMatchResult): void {
    const clientVal = lastCapture(clientPattern, text);
    if (clientVal) {
      const trimmed = clientVal.trim();
      if (trimmed.length <= 100 && isValidMultiWordValue(trimmed, 2)) {
        result.installationUpdates.clientName = trimmed;
      }
    }

    const addrVal = lastCapture(addressPattern, text);
    if (addrVal) {
      const trimmed = addrVal.trim();
      if (trimmed.length <= 200 && isValidMultiWordValue(trimmed, 5)) {
        result.installationUpdates.address = trimmed;
      }
    }

    const premisesVal = lastCapture(premisesPattern, text, 0);
    if (premisesVal) {
      result.installationUpdates.premisesDescription = capitalize(premisesVal);
    }

    const nextVal = lastCapture(nextInspectionPattern, text);
    if (nextVal) {
      const years = parseInt(nextVal, 10);
      if (years >= 1 && years <= 10) result.installationUpdates.nextInspectionYears = years;
    }

    const phoneVal = lastCapture(clientPhonePattern, text);
    if (phoneVal) {
      const trimmed = phoneVal.trim();
      if (trimmed.length >= 6 && trimmed.length <= 20) result.installationUpdates.clientPhone = trimmed;
    }

    const emailVal = lastCapture(clientEmailPattern, text);
    if (emailVal) {
      const trimmed = emailVal.trim();
      if (trimmed.includes("@") && trimmed.length <= 100) result.installationUpdates.clientEmail = trimmed;
    }

    const occupierVal = lastCapture(occupierNamePattern, text);
    if (occupierVal) {
      const trimmed = occupierVal.trim();
      if (trimmed.length <= 100 && isValidMultiWordValue(trimmed, 2)) result.installationUpdates.occupierName = trimmed;
    }

    const reasonVal = lastCapture(reasonForReportPattern, text);
    if (reasonVal) {
      const trimmed = reasonVal.trim();
      if (trimmed.length >= 3 && trimmed.length <= 200) result.installationUpdates.reasonForReport = trimmed;
    }

    const prevDateVal = lastCapture(dateOfPreviousInspectionPattern, text);
    if (prevDateVal) {
      const trimmed = prevDateVal.trim();
      if (trimmed.length >= 4 && trimmed.length <= 50) result.installationUpdates.dateOfPreviousInspection = trimmed;
    }

    const prevCertVal = lastCapture(previousCertificateNumberPattern, text);
    if (prevCertVal) {
      const trimmed = prevCertVal.trim();
      if (trimmed.length >= 2 && trimmed.length <= 50) result.installationUpdates.previousCertificateNumber = trimmed;
    }

    const ageVal = lastCapture(estimatedAgePattern, text);
    if (ageVal) {
      const trimmed = ageVal.trim();
      if (trimmed.length <= 50) result.installationUpdates.estimatedAgeOfInstallation = trimmed;
    }

    const conditionVal = lastCapture(generalConditionPattern, text);
    if (conditionVal) {
      const trimmed = conditionVal.trim();
      if (trimmed.length >= 3 && trimmed.length <= 500) result.installationUpdates.generalConditionOfInstallation = trimmed;
    }
  }
}
