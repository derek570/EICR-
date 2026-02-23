// eicr-extraction-session.js
// Core multi-turn Sonnet conversation manager for EICR extraction.
// Maintains conversation history with prompt caching and custom compaction.

import Anthropic from '@anthropic-ai/sdk';
import { CostTracker } from './cost-tracker.js';

// Compaction threshold -- compact when conversation exceeds this many estimated tokens
const COMPACTION_THRESHOLD = 6000;

// System prompt -- adapted from ClaudeService.swift rollingExtractionSystemPrompt
// Must be >=1024 tokens for Sonnet 4.5 prompt caching
export const EICR_SYSTEM_PROMPT = `You are an EICR inspection assistant working live with an electrician. You receive transcript utterances as they speak during an electrical inspection. You have full context of everything said so far in this conversation.

For each new utterance, extract any EICR electrical readings and return them as structured JSON.

EXTRACTION RULES (CRITICAL — YOUR MAIN JOB IS ACCURACY):
- ALWAYS extract every test reading mentioned in the utterance. NEVER silently drop a value.
- If a reading has no circuit reference in the current utterance, return it with circuit: -1 AND ask which circuit. Do NOT skip it.
- Extract ONLY from the NEW utterance — you already know everything said before.
- Do NOT re-extract values that were confirmed in previous turns.
- If a reading seems incomplete (e.g., "Zs..." with no value), WAIT — the electrician may be mid-reading. Do NOT ask yet.

ACCURACY CHECKING (CRITICAL — ASK WHEN UNSURE):
- If you hear a NUMBER that looks like a reading but NO clear field name, ASK: "Was that [value] for Zs, insulation, or something else?" Extract it with confidence 0.3 and your best-guess field.
- If you hear a FIELD NAME but NO value follows, ASK: "What's the [field] reading?" Do NOT extract anything — wait for the value.
- If the transcript is garbled or the value doesn't make sense for the field (e.g., "Zs is 200" — likely insulation not Zs), ASK: "Did you say [field] is [value]? That sounds like it might be [other field]."
- Deepgram may mishear technical terms — if the text doesn't quite make sense but you can guess what was meant, extract your best interpretation AND ask to confirm. Better to ask than to silently store a wrong value.
- You are the LAST line of defence before values go on a safety certificate. When in doubt, ASK.

CIRCUIT ROUTING RULES:
- The electrician identifies circuits by number ("circuit 1", "number 3") or description ("ring final", "cooker", "downstairs sockets").
- Look ONLY at the current utterance to determine the circuit. If the utterance does NOT contain a circuit number or circuit name, set circuit to -1. There is NO "active circuit" — previous utterances do NOT set context for later ones.
- DO NOT infer the circuit from conversation history. DO NOT assume "they were just talking about circuit 3 so this must be circuit 3". Every utterance stands alone for circuit assignment.
- Example: Previous was "circuit 3 Zs 0.35", current is "insulation 200" → [{circuit: -1, field: "insulation_resistance_l_e", value: ">200"}] + ask which circuit. Same for "live to live lim" → circuit -1 + ask.
- If the current utterance explicitly says a circuit number or name, use it for all readings in that utterance.
- DESCRIPTION MATCHING: When the user refers to a circuit by description (e.g., "cooker", "kitchen sockets", "upstairs lights"), match it against the CIRCUIT SCHEDULE descriptions. A match is valid if the spoken description is a clear substring or synonym of a schedule entry (e.g., "cooker" matches "Cooker", "kitchen sockets" matches "Kitchen Ring Final", "lights" matches "Lighting"). Use the matched circuit number.
- If a description matches MULTIPLE circuits in the schedule (e.g., "sockets" matches both "Kitchen Sockets" and "Lounge Sockets"), set circuit to -1 and ask: "[description] — circuit [X], [Y], or [Z]?"
- If a description matches NO circuits in the schedule, set circuit to -1 and ask: "Which circuit number is [description]?"
- NEVER guess when there is genuine ambiguity — but a clear single match to the schedule IS a match, not a guess.
- Circuit 0 means supply/installation-level readings (Ze, PFC, earthing, address, client etc.) — NOT a real circuit. Supply readings do NOT need a circuit reference.
- CIRCUIT NAMING: If the user says "circuit N is [description]" (e.g., "circuit 2 is upstairs lighting"), return a circuit_updates entry with action "create" (if circuit N is not in the schedule) or "rename" (if it exists). Do NOT return this as an extracted_reading.
- CIRCUIT NAMING by description only: If user says "[description] circuit" without a number and it doesn't match any existing circuit, ask: "What circuit number is [description]?"
- CIRCUIT REASSIGNMENT: If a reading was previously extracted for one circuit and the user corrects it to a different circuit, include the corrected reading in extracted_readings AND add a field_clears entry for the old circuit. Example: Zs 0.83 was on circuit 2, user says "that's circuit 1" → extracted_readings: [{circuit:1, field:"zs", value:0.83}], field_clears: [{circuit:2, field:"zs"}].
- Confidence: 0.0-1.0. Skip readings below 0.5.
- For ring continuity: r1 and r2 are individual conductor resistances; r1_plus_r2 is the loop value
- Ring continuity (R1/Rn/R2/lives/neutrals/earths) ONLY applies to ring/socket circuits, NEVER lighting circuits.
  Ring data on a lighting circuit -> ask user to confirm the circuit number.
- "earths" in ring context = ring_continuity_r2, NOT insulation_resistance_l_e.
- "live to live"/"light to live" = insulation_resistance_l_l, NOT insulation_resistance_l_e.
- cable_size = LIVE conductor mm2 (not earth). "lives 2.5, earths 1.5" -> cable_size=2.5.
- "type B 32" = ocpd_type B + ocpd_rating 32. ocpd_type = B/C/D (MCB/RCBO type).
- "wiring type A"/"cable type A" = wiring_type (A-G). NOT ocpd_type.
- "ref method C"/"wiring method C" = ref_method (A-G). NOT ocpd_type.
- PFC (prospective fault current): normalise to kA (e.g., "1.2 kA" or "1200 amps" -> 1.2). "nought 88" = 0.88 kA (NOT 88). Range 0.1-20 kA.
- Insulation resistance: ">200" or ">999" are valid (meter reads off-scale). Always include > prefix for off-scale readings.
- "LIM" (limitation): A valid value for ANY test field. Means the reading could not be obtained or the meter is at its limit. Deepgram may transcribe as "lim", "limb", "limitation", "limited", "Lynn", or "Lym". Always normalise to "LIM" (uppercase). Extract with the appropriate field and circuit like any other reading. Do NOT treat as incomplete or unclear — it is a deliberate, meaningful result.
- "N/A" (not applicable): A valid value for ANY test field. Means the test was not performed or is not applicable to this circuit. Deepgram may transcribe as "NA", "N.A.", "not applicable", "not available". Always normalise to "N/A". Extract like any other reading.
- Decimal reconstruction: "nought point two seven" -> 0.27, "zero point three five" -> 0.35
- Streaming splits numbers: "0.3 0" = 0.30, "1.2 5" = 1.25. Reconstruct decimals from split speech.
- Cable size: "2.5mm" -> "2.5", "one point five" -> "1.5"
- Silently correct obvious mishearings ("nought point free" -> 0.3, "said he" -> CD)
- "smokes" = smoke detectors (common electrician shorthand). Use circuit_updates to rename the circuit to "Smoke Detectors", do NOT treat as number_of_points.
- Ignore customer conversation, background noise, and off-topic speech

COMMON SPEECH PATTERNS:
- "lives 200 earths 200" = insulation_resistance_l_l: ">200" AND insulation_resistance_l_e: ">200" (TWO readings)
- "IR 200 both ways" / "insulation 200 200" = both IR fields >200
- "lim on the loop" / "lim on continuity" = r1_plus_r2: "LIM" or zs: "LIM" (use context)
- "that's good" / "that's fine" / "pass" after a test = IGNORE, not a value
- "all good on polarity" = polarity: "correct"
- "type B 32" = TWO readings: ocpd_type: "B" AND ocpd_rating: 32
- "2.5 and 1.5" for cable = cable_size: "2.5" AND cable_size_earth: "1.5"
- "5 points" / "6 points on this" = number_of_points
- Numbers alone after a field name: "Zs... 0.35" = zs: 0.35, "Ze... 0.84" = ze: 0.84 (field from recent context OK within same utterance)

MULTI-FIELD EXTRACTION:
- Extract ALL values from a single utterance. If the user says "Zs 0.35, insulation 200, R1 plus R2 0.47", return THREE extracted_readings in one response.
- Each reading gets its own circuit assignment. If the utterance says "circuit 3" once, all readings in that utterance are for circuit 3.
- Common multi-field patterns: "type B 32" (2 fields), "2.5 and 1.5 cable" (2 fields), "lives and earths both 200" (2 fields), a string of test readings for one circuit.

BULK OPERATIONS:
- "All circuits are [value]" / "every circuit [field] is [value]" / "same for all": Return one extracted_reading PER circuit in the schedule with the same field and value. Use each circuit's actual number.
- "Circuits 1 through 4 are [value]": Return readings for circuits 1, 2, 3, 4 only.
- "Same as circuit 3" / "copy from circuit 3": Copy ALL filled fields from circuit 3 to the target circuit. Return individual readings for each copied field.

CIRCUIT FIELDS (per circuit):
- ocpd_type: MCB type letter (B, C, D)
- ocpd_rating: rating in amps (e.g., 6, 16, 20, 32, 40, 50)
- cable_size: live conductor mm2 (e.g., "2.5", "4.0", "6.0", "10.0")
- cable_size_earth: earth conductor mm2 (e.g., "1.5", "2.5")
- wiring_type: cable/wiring type (e.g., "Twin & Earth", "T&E", "SWA", "MICC", "FP200", "Flex", "Armoured"). NOT the reference method letter — that is ref_method.
- ref_method: BS7671 installation reference method code (e.g., "A", "B", "C", "100", "101", "102", "103"). NOT the cable/wiring type — that is wiring_type. "Method C" or "ref method C" = ref_method.
- circuit_description: what the circuit supplies (e.g., "Kitchen Sockets", "Upstairs Lighting")
- zs: earth fault loop impedance in ohms
- insulation_resistance_l_l: line-line in megohms
- insulation_resistance_l_e: line-earth in megohms
- r1_plus_r2: R1+R2 continuity loop in ohms
- ring_continuity_r1: ring end-to-end R1 in ohms
- ring_continuity_rn: ring end-to-end Rn in ohms
- r2: standalone R2 earth continuity reading in ohms (radial circuits). For RING circuits, use ring_continuity_r2 instead.
- ring_continuity_r2: ring circuit end-to-end R2/CPC resistance in ohms. Only for ring/socket circuits. "Earths" on a ring = this field.
- rcd_trip_time: RCD trip time in ms
- rcd_rating_a: RCD rating in mA (typically 30)
- polarity: "correct" or "reversed" or "OK"
- number_of_points: count of outlets/points on circuit
- rcd_button_confirmed: "OK" if test button works
- afdd_button_confirmed: "OK" if AFDD fitted and tested

SUPPLY FIELDS (circuit 0):
- ze: external earth fault loop impedance in ohms
- pfc: prospective fault current at origin in kA
- earthing_arrangement: "TN-S", "TN-C-S", "TT"
- main_earth_conductor_csa: mm2
- main_bonding_conductor_csa: mm2
- bonding_water: "Yes" if water bonding present
- bonding_gas: "Yes" if gas bonding present
- earth_electrode_type: rod|plate|tape|mat|other
- earth_electrode_resistance: RA in ohms
- supply_voltage: nominal voltage in volts (typically "230" or "240")
- supply_frequency: nominal frequency in Hz (typically "50")
- supply_polarity_confirmed: "Yes" if confirmed
- manufacturer: consumer unit manufacturer name
- zs_at_db: Zs at distribution board in ohms
- address: property address
- client_name: client/owner name
- client_phone: phone number
- client_email: email address
- reason_for_report: reason for inspection
- occupier_name: name of occupier if different from client
- date_of_previous_inspection: date string
- previous_certificate_number: reference number
- estimated_age_of_installation: years or description
- general_condition: overall condition assessment
- next_inspection_years: integer 1-10
- premises_description: Residential|Commercial|Industrial|Agricultural|Other

OUT-OF-RANGE THRESHOLDS (only flag values OUTSIDE these):
- IR (insulation_resistance_l_e, insulation_resistance_l_l): flag if < 0.5 megohms. Values like 2, 50, 100, 199 are NORMAL.
- R1+R2, R2: flag if > 10 ohms or < 0.01 ohms.
- Ring continuity (R1, Rn, R2): flag if > 5 ohms.
- RCD trip time: flag if > 500 ms.
- PFC: flag if > 20 kA or < 0.1 kA.
- Ze/Zs DEPEND ON EARTHING SYSTEM:
  If Earthing=TT in circuit schedule: Ze up to 200 ohms is NORMAL, Zs up to 1667 ohms is NORMAL. Do NOT flag.
  If Earthing=TN-S or TN-C-S: Ze flag if > 5 ohms, Zs flag if > 20 ohms.
  If Earthing is NOT SET and Ze > 5 or Zs > 20: generate a question with type "tt_confirmation",
  field "earthing_arrangement", question "Ze is [value] ohms -- is this a TT system?".

QUESTION STYLE:
- Ask SHORT conversational questions (max 15 words), like a friendly colleague
- You are checking ACCURACY — did you hear the value correctly? NOT giving advice on readings
- Good: "Was that 0.35 for circuit 3?" / "I heard 2.5 ohms — did I catch that right?"
- Good: "The insulation on circuit 5 — 0.5 or 5 megohms?"
- Bad: "That Zs value seems high" / "Please confirm the reading" / "That reading is unusual"
- Question types: "orphaned" (no circuit), "out_of_range" (unusual value — you may have misheard), "unclear" (ambiguous/garbled audio), "tt_confirmation" (high Ze/Zs with unknown earthing)
- When asking which circuit a reading belongs to, ALWAYS include heard_value with the actual value you heard. Example: { "question": "Which circuit is that 0.35 for?", "field": "zs", "circuit": -1, "heard_value": "0.35", "type": "orphaned" }
- Only ask when genuinely unsure — obvious mishearings (e.g. "free" → "three") should be silently corrected
- Do NOT ask about missing/incomplete fields — only about values actually spoken
- Do NOT comment on whether values are good/bad/acceptable — just check you heard correctly
- If a value is much higher or lower than typical (Zs > 2Ω, insulation < 1MΩ, RCD > 200ms), ask "did I catch that right?" — the electrician knows if the value is correct, you just need to check YOUR hearing
- If a reading looks INCOMPLETE (just "0", "nought", trailing off) set confidence LOW (0.1-0.3) instead of generating a question — the next utterance will likely complete it

CONFIRMATION MODE:
- When [CONFIRMATIONS ENABLED] in user message, add brief confirmations (under 5 words, confidence >= 0.8) to "confirmations" array: [{ "text": "Circuit 3, 0.35", "field": "zs", "circuit": 3 }]

OBSERVATIONS:
- When the electrician mentions an observation, defect, finding, or issue, extract it into the observations array.
- Trigger words: "observation", "finding", "defect", "issue", "noticed", "concern", "recommend"
- Codes: C1 (danger present), C2 (potentially dangerous), C3 (improvement recommended), FI (further investigation)
- They may say "C1", "code 1", "category 1", "C 1", "danger present" etc. Map to C1/C2/C3/FI.
- CODE ASSESSMENT: If the electrician does NOT state a code, assess severity yourself:
  - C1: Immediate danger to persons (exposed live parts, missing earthing on accessible metalwork, signs of arcing/fire)
  - C2: Potentially dangerous (deteriorated insulation, overloaded circuits, missing RCD protection where required, no main bonding)
  - C3: Does not comply with current standards but not immediately dangerous (no RCD test notice, poor labelling, non-fire-rated/combustible consumer unit enclosure — Reg 421.1.201, schedule 4.4, per GN3)
  - FI: Cannot determine condition without further investigation (inaccessible areas, suspected hidden defects)
- PROFESSIONAL REWRITE: Rewrite the observation in professional BS7671 language suitable for an official EICR certificate. Keep concise (1-2 sentences) and auditable. CRITICAL: Do NOT change the factual content. If the electrician says "no CPC", write "no CPC" — do NOT reinterpret as "CPC present but unused". Preserve the electrician's technical finding exactly; only improve grammar and formatting.
- REGULATION: Include the specific BS7671 regulation being breached (e.g., "Reg 411.3.3", "Reg 421.1.201", "Reg 544.1.1"). If multiple regulations apply, cite the most relevant one.
- SCHEDULE ITEM: Map to the EICR inspection schedule section using this reference:
  1.x - External intake equipment (service cable, earthing arrangement, meter tails)
  3.x - Earthing/bonding (3.1 distributor earthing, 3.2 electrode, 3.3 labels, 3.4-3.5 earthing conductor, 3.6-3.8 bonding)
  4.x - Consumer unit/distribution board (4.1 access, 4.2 fixing, 4.3 IP rating, 4.4 fire rating, 4.5 damage, 4.6-4.7 main switch, 4.8 MCB/RCD operation, 4.9 labelling, 4.10 RCD notice, 4.13 devices, 4.15-4.16 cable entry, 4.17-4.18 RCDs, 4.19 SPD, 4.20 connections)
  5.x - Final circuits (5.1 conductor ID, 5.2 cable support, 5.3 insulation, 5.5-5.7 cable sizing/protection, 5.8 CPCs, 5.12 RCD additional protection, 5.17 terminations, 5.18 accessories)
  6.x - Bath/shower locations (6.1 RCD, 6.4 supplementary bonding, 6.5 socket distance, 6.6-6.8 IP rating/zones)
  7.x - Special installations (swimming pools, EV charging, PV, etc.)
- item_location: Where in the property (e.g., "Kitchen", "First floor landing", "Consumer unit"). Extract if mentioned, otherwise null.
- If the description is unclear or too short, ask: "What's the observation?"
- Observations go in the "observations" array, NOT in extracted_readings
- Do NOT re-extract observations from previous turns

VALIDATION ALERTS:
- Only alert for genuine contradictions (e.g. ring continuity on lighting circuit). No alerts for incomplete readings or successful extractions.

Return ONLY valid JSON in this format:
{
  "extracted_readings": [
    { "circuit": <int>, "field": "<str>", "value": <number|string|boolean>, "unit": "<str|null>", "confidence": <0.0-1.0> }
  ],
  "circuit_updates": [
    { "circuit": <int>, "designation": "<str>", "action": "create|rename" }
  ],
  "field_clears": [
    { "circuit": <int>, "field": "<str>" }
  ],
  "observations": [
    { "code": "<C1|C2|C3|FI>", "observation_text": "<professional description>", "item_location": "<location or null>", "schedule_item": "<e.g. 4.4 or null>", "regulation": "<e.g. Reg 421.1.201 or null>" }
  ],
  "validation_alerts": [
    { "type": "<str>", "severity": "<info|warning|critical>", "message": "<str>" }
  ],
  "questions_for_user": [
    { "question": "<max 15 words>", "field": "<str|null>", "circuit": <int|null>, "heard_value": "<str|null>", "type": "<orphaned|out_of_range|unclear|tt_confirmation|circuit_disambiguation>" }
  ],
  "confirmations": [
    { "text": "Circuit 3, 0.35", "field": "zs", "circuit": 3 }
  ]
}`;

const COMPACTION_PROMPT = `You are summarizing an EICR electrical inspection recording session for continued extraction.

CRITICAL: You must preserve ALL confirmed readings exactly as extracted. This summary replaces the conversation history.

Output format -- return ONLY this JSON:
{
  "confirmed_readings": [
    { "circuit": <int>, "field": "<str>", "value": <number|string>, "unit": "<str|null>" }
  ],
  "pending_readings": [
    { "circuit": -1, "field": "<str>", "value": <number|string>, "unit": "<str|null>" }
  ],
  "observations_created": [
    { "code": "<C1|C2|C3|FI>", "observation_text": "<str>", "schedule_item": "<str|null>" }
  ],
  "active_circuit": <int|null>,
  "session_context": "<1-2 sentences about what the electrician is currently doing>",
  "questions_asked": ["<field:circuit pairs already asked about>"],
  "unresolved_values": [
    { "circuit": <int|null>, "field": "<str|null>", "heard_value": "<str>", "issue": "<str>" }
  ]
}

Rules:
- Every reading from extracted_readings across ALL turns MUST appear in confirmed_readings
- Readings with circuit: -1 (unassigned) go in pending_readings
- Every observation from observations arrays across ALL turns MUST appear in observations_created -- do NOT re-extract these
- active_circuit should be null (no active circuit tracking between utterances)
- session_context should capture what part of the inspection they are on
- questions_asked prevents re-asking the same questions
- unresolved_values captures anything flagged but not yet confirmed`;


export class EICRExtractionSession {
  constructor(apiKey, sessionId) {
    this.client = new Anthropic({ apiKey });
    this.sessionId = sessionId;
    this.conversationHistory = []; // Array of { role, content } messages
    this.costTracker = new CostTracker();
    this.extractedReadingsCount = 0;
    this.askedQuestions = [];
    this.extractedObservationTexts = []; // Track observations already sent to iOS for dedup
    this.turnCount = 0;
    this.circuitSchedule = '';
    this.circuitScheduleIncluded = false;
    this.isActive = false;
  }

  // Extract text from a message content (handles both string and content block array formats)
  static messageText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(b => b.text || '').join('');
    return '';
  }

  // Rough token estimate (4 chars per token)
  get conversationTokenEstimate() {
    return this.conversationHistory.reduce((sum, msg) => {
      return sum + Math.ceil(EICRExtractionSession.messageText(msg.content).length / 4);
    }, 0);
  }

  start(jobState) {
    this.isActive = true;
    this.costTracker.startRecording();
    if (jobState) {
      this.circuitSchedule = this.buildCircuitSchedule(jobState);
    }
    console.log(`[Session ${this.sessionId}] Started`);
  }

  pause() {
    this.costTracker.pauseRecording();
    console.log(`[Session ${this.sessionId}] Paused`);
  }

  resume() {
    this.costTracker.resumeRecording();
    console.log(`[Session ${this.sessionId}] Resumed`);
  }

  stop() {
    this.isActive = false;
    this.costTracker.stopRecording();
    const summary = this.costTracker.toSessionSummary();
    summary.extraction.readingsExtracted = this.extractedReadingsCount;
    summary.extraction.questionsAsked = this.askedQuestions.length;
    console.log(`[Session ${this.sessionId}] Stopped. Cost: $${summary.totalJobCost.toFixed(4)}`);
    return summary;
  }

  updateJobState(jobState) {
    this.circuitSchedule = this.buildCircuitSchedule(jobState);
    this.circuitScheduleIncluded = false; // Force re-send on next utterance
  }

  async extractFromUtterance(transcriptText, regexResults = [], options = {}) {
    // Check if compaction needed
    if (this.conversationTokenEstimate > COMPACTION_THRESHOLD) {
      await this.compact();
    }

    let userMessage = this.buildUserMessage(transcriptText, regexResults);
    if (options.confirmationsEnabled) {
      userMessage += '\n\n[CONFIRMATIONS ENABLED]';
    }

    // Build messages array with cache_control on latest user message
    const messages = [
      ...this.conversationHistory,
      {
        role: 'user',
        content: [{
          type: 'text',
          text: userMessage,
          cache_control: { type: 'ephemeral', ttl: '1h' }
        }]
      }
    ];

    // Add mid-conversation breakpoints if >20 blocks
    this.addMidConversationBreakpoints(messages);

    const response = await this.callWithRetry(messages);

    // Extract text response
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || !textBlock.text) {
      // Still push to conversation history to keep it in sync
      this.conversationHistory.push(
        { role: 'user', content: [{ type: 'text', text: userMessage }] },
        { role: 'assistant', content: [{ type: 'text', text: '{}' }] }
      );
      throw new Error('No text block in Sonnet response');
    }

    const rawText = textBlock.text;
    const EMPTY_RESULT = { extracted_readings: [], field_clears: [], circuit_updates: [], observations: [], validation_alerts: [], questions_for_user: [], confirmations: [] };
    let result;

    try {
      const resultJSON = this.extractJSON(rawText);
      const parsed = JSON.parse(resultJSON);
      // Validate expected array fields
      result = {
        extracted_readings: Array.isArray(parsed.extracted_readings) ? parsed.extracted_readings : [],
        field_clears: Array.isArray(parsed.field_clears) ? parsed.field_clears : [],
        circuit_updates: Array.isArray(parsed.circuit_updates) ? parsed.circuit_updates : [],
        observations: Array.isArray(parsed.observations) ? parsed.observations : [],
        validation_alerts: Array.isArray(parsed.validation_alerts) ? parsed.validation_alerts : [],
        questions_for_user: Array.isArray(parsed.questions_for_user) ? parsed.questions_for_user : [],
        confirmations: Array.isArray(parsed.confirmations) ? parsed.confirmations : []
      };
    } catch (parseError) {
      console.warn(`[Session ${this.sessionId}] Failed to parse Sonnet JSON: ${parseError.message}`);
      result = EMPTY_RESULT;
    }

    // ALWAYS push to conversation history (even on parse failure) to keep context in sync
    this.conversationHistory.push(
      { role: 'user', content: [{ type: 'text', text: userMessage }] },
      { role: 'assistant', content: [{ type: 'text', text: rawText }] }
    );

    // Track metrics
    this.turnCount++;
    this.extractedReadingsCount += result.extracted_readings.length;
    if (result.questions_for_user.length > 0) {
      const newQuestions = result.questions_for_user.map(q => `${q.field || 'unknown'}:${q.circuit || 'unknown'}`);
      this.askedQuestions.push(...newQuestions);
      // Cap at 30 entries
      while (this.askedQuestions.length > 30) {
        this.askedQuestions.shift();
      }
    }

    // Dedup observations: filter out any that match already-sent observations
    if (result.observations.length > 0) {
      result.observations = result.observations.filter(obs => {
        const text = (obs.observation_text || '').toLowerCase();
        if (!text) return false;
        const isDupe = this.extractedObservationTexts.some(prev => {
          // Check word overlap: >50% shared words = duplicate
          const prevWords = new Set(prev.split(/\s+/));
          const newWords = text.split(/\s+/);
          if (newWords.length === 0) return true;
          const overlap = newWords.filter(w => prevWords.has(w)).length;
          return overlap / newWords.length > 0.5;
        });
        if (isDupe) {
          console.log(`[Session ${this.sessionId}] Observation deduped (server): ${text.substring(0, 60)}`);
        } else {
          this.extractedObservationTexts.push(text);
        }
        return !isDupe;
      });
    }

    // Track token costs
    this.costTracker.addSonnetUsage(response.usage);

    return result;
  }

  async compact() {
    try {
      console.log(`[Session ${this.sessionId}] Compacting: ${this.turnCount} turns, ~${this.conversationTokenEstimate} tokens`);

      const compactionInput = this.conversationHistory.map((msg, i) => {
        const text = EICRExtractionSession.messageText(msg.content);
        return `[Turn ${Math.floor(i / 2) + 1} ${msg.role}]: ${text}`;
      }).join('\n\n');

      const compactionMessages = [{
        role: 'user',
        content: [{ type: 'text', text: `Summarize this EICR extraction conversation:\n\n${compactionInput}` }]
      }];

      const response = await this.callWithRetry(compactionMessages, 3, COMPACTION_PROMPT, 2048);

      const summaryText = response.content[0].text;
      const summary = JSON.parse(this.extractJSON(summaryText));

      // Validate
      const readingCount = (summary.confirmed_readings || []).length;
      if (readingCount < this.extractedReadingsCount * 0.8) {
        console.warn(`[Session ${this.sessionId}] Compaction may have lost data: expected ~${this.extractedReadingsCount}, got ${readingCount}`);
      }

      // Track compaction cost
      this.costTracker.addCompactionUsage(response.usage);

      // Replace conversation with compact summary
      const ackResponse = JSON.stringify({
        extracted_readings: [],
        validation_alerts: [],
        questions_for_user: []
      });

      // Clear askedQuestions on compaction (summary already includes questions_asked)
      this.askedQuestions = [];

      this.conversationHistory = [
        {
          role: 'user',
          content: [{
            type: 'text',
            text: `SESSION SUMMARY (compacted from ${this.turnCount} previous turns):\n${JSON.stringify(summary, null, 2)}\n\nContinue extracting from new transcript buffers. All readings in confirmed_readings are already saved -- do not re-extract them. All observations in observations_created are already saved -- do not re-extract them. REMINDER: There is NO active circuit. Each utterance stands alone -- if it does not contain a circuit reference, set circuit to -1.`
          }]
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: ackResponse }]
        }
      ];

      // Reset the circuit schedule flag so it gets re-sent after compaction
      this.circuitScheduleIncluded = false;

      console.log(`[Session ${this.sessionId}] Compacted to ~${this.conversationTokenEstimate} tokens`);
    } catch (error) {
      console.error(`[Session ${this.sessionId}] Compaction failed: ${error.message}. Continuing without compaction.`);
    }
  }

  async callWithRetry(messages, maxRetries = 3, systemPrompt = null, maxTokens = 1280) {
    const system = systemPrompt
      ? systemPrompt
      : [{
          type: 'text',
          text: EICR_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral', ttl: '1h' }
        }];

    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: maxTokens,
          system,
          messages
        });
      } catch (error) {
        lastError = error;
        if (error.status === 429 || error.status >= 500) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          console.warn(`[Session ${this.sessionId}] Sonnet error ${error.status}, retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw error; // Client errors -- don't retry
      }
    }
    throw lastError || new Error('Max retries exceeded');
  }

  addMidConversationBreakpoints(messages) {
    const blockCount = messages.length;
    if (blockCount <= 20) return;
    // Anthropic allows max 4 cache_control blocks total.
    // 1 is on the system prompt, 1 on the latest user message,
    // so we can place at most 2 mid-conversation breakpoints.
    // Collect all eligible positions, then keep only the last 2
    // (nearest the end) for best cache hit rates.
    const candidates = [];
    for (let i = 18; i < blockCount - 2; i += 18) {
      const msg = messages[i];
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        candidates.push(i);
      }
    }
    // Keep only the last 2 candidates
    const selected = candidates.slice(-2);
    for (const idx of selected) {
      const msg = messages[idx];
      const lastBlock = msg.content[msg.content.length - 1];
      if (!lastBlock.cache_control) {
        lastBlock.cache_control = { type: 'ephemeral', ttl: '1h' };
      }
    }
  }

  buildUserMessage(transcriptText, regexResults = []) {
    const parts = [];
    parts.push(`NEW utterance: ${transcriptText}`);
    if (regexResults && regexResults.length > 0) {
      parts.push(`Regex pre-filled fields (confirm or correct): ${JSON.stringify(regexResults)}`);
    }
    // Only include circuit schedule on first message and after job state updates
    if (this.circuitSchedule && !this.circuitScheduleIncluded) {
      parts.push(`CIRCUIT SCHEDULE (confirmed values -- do NOT question these):\n${this.circuitSchedule}`);
      this.circuitScheduleIncluded = true;
    }
    if (this.askedQuestions.length > 0) {
      parts.push(`Already asked (skip): ${this.askedQuestions.join('; ')}`);
    }
    if (this.extractedObservationTexts.length > 0) {
      parts.push(`Observations already created (do NOT re-extract): ${this.extractedObservationTexts.map(t => t.substring(0, 60)).join('; ')}`);
    }
    return parts.join('\n\n');
  }

  buildCircuitSchedule(jobState) {
    if (!jobState || !jobState.circuits) return '';
    const lines = [];
    for (const circuit of jobState.circuits) {
      const num = circuit.ref || circuit.circuitNumber || circuit.number || '?';
      const desc = circuit.designation || circuit.description || circuit.circuit_description || 'unnamed';
      const fields = [];

      // Derive circuit type from designation
      if (circuit.circuit_type) {
        fields.push(`${circuit.circuit_type}`);
      } else {
        const d = (desc || '').toLowerCase();
        if (d.includes('socket') || d.includes('ring')) fields.push('Ring');
        else if (d.includes('light')) fields.push('Lighting');
        else if (d.includes('cooker') || d.includes('shower') || d.includes('oven') || d.includes('hob')) fields.push('Radial');
      }

      // OCPD
      const ocpdType = circuit.ocpdType || circuit.ocpd_type;
      const ocpdRating = circuit.ocpdRatingA || circuit.ocpd_rating;
      if (ocpdType && ocpdRating) fields.push(`ocpd=${ocpdType}/${ocpdRating}A`);
      else if (ocpdType) fields.push(`ocpd=${ocpdType}`);
      else if (ocpdRating) fields.push(`${ocpdRating}A`);

      // Cable sizes
      const liveCsa = circuit.liveCsaMm2 || circuit.cable_size_live || circuit.cable_size;
      const earthCsa = circuit.cpcCsaMm2 || circuit.cable_size_earth;
      if (liveCsa && earthCsa) fields.push(`cable=${liveCsa}/${earthCsa}mm`);
      else if (liveCsa) fields.push(`cable=${liveCsa}mm`);

      // Wiring and ref method
      if (circuit.wiringType || circuit.wiring_type) fields.push(`wiring=${circuit.wiringType || circuit.wiring_type}`);
      if (circuit.refMethod || circuit.ref_method) fields.push(`ref=${circuit.refMethod || circuit.ref_method}`);

      // Test readings
      if (circuit.measuredZsOhm || circuit.zs) fields.push(`zs=${circuit.measuredZsOhm || circuit.zs}`);
      if (circuit.r1R2Ohm || circuit.r1_plus_r2) fields.push(`r1r2=${circuit.r1R2Ohm || circuit.r1_plus_r2}`);
      if (circuit.r2Ohm || circuit.r2) fields.push(`r2=${circuit.r2Ohm || circuit.r2}`);
      if (circuit.ringR1Ohm) fields.push(`ringR1=${circuit.ringR1Ohm}`);
      if (circuit.ringRnOhm) fields.push(`ringRn=${circuit.ringRnOhm}`);
      if (circuit.ringR2Ohm) fields.push(`ringR2=${circuit.ringR2Ohm}`);
      if (circuit.irLiveEarthMohm || circuit.insulation_resistance_l_e) fields.push(`irLE=${circuit.irLiveEarthMohm || circuit.insulation_resistance_l_e}`);
      if (circuit.irLiveLiveMohm || circuit.insulation_resistance_l_l) fields.push(`irLL=${circuit.irLiveLiveMohm || circuit.insulation_resistance_l_l}`);

      // Polarity
      if (circuit.polarityConfirmed || circuit.polarity) fields.push(`polarity=${circuit.polarityConfirmed || circuit.polarity}`);

      // RCD
      const rcdTime = circuit.rcdTimeMs || circuit.rcd_trip_time;
      const rcdRating = circuit.rcdRatingA || circuit.rcd_rating_a;
      if (rcdTime && rcdRating) fields.push(`rcd=${rcdTime}ms/${rcdRating}mA`);
      else if (rcdTime) fields.push(`rcd=${rcdTime}ms`);
      else if (rcdRating) fields.push(`rcd=${rcdRating}mA`);

      // RCD/AFDD buttons
      if (circuit.rcdButtonConfirmed) fields.push(`rcdBtn=OK`);
      if (circuit.afddButtonConfirmed) fields.push(`afddBtn=OK`);

      // Points
      if (circuit.numberOfPoints || circuit.number_of_points) fields.push(`points=${circuit.numberOfPoints || circuit.number_of_points}`);

      lines.push(`  Circuit ${num}: ${desc} [${fields.join(', ')}]`);
    }

    // Supply section
    if (jobState.supply) {
      const s = jobState.supply;
      const supplyFields = [];
      if (s.earthingArrangement || s.earthing_arrangement) supplyFields.push(`earthing=${s.earthingArrangement || s.earthing_arrangement}`);
      if (s.pfc || s.pfc_at_origin) supplyFields.push(`PFC=${s.pfc || s.pfc_at_origin}kA`);
      if (s.ze) supplyFields.push(`Ze=${s.ze}ohms`);
      if (s.zsAtDb || s.zs_at_db) supplyFields.push(`ZsDb=${s.zsAtDb || s.zs_at_db}`);
      if (s.earthingConductorCsa || s.main_earth_conductor_csa) supplyFields.push(`earthConductor=${s.earthingConductorCsa || s.main_earth_conductor_csa}mm2`);
      if (s.mainBondingCsa || s.main_bonding_conductor_csa) supplyFields.push(`bonding=${s.mainBondingCsa || s.main_bonding_conductor_csa}mm2`);
      if (s.bondingWater || s.bonding_water) supplyFields.push(`water=Yes`);
      if (s.bondingGas || s.bonding_gas) supplyFields.push(`gas=Yes`);
      if (s.earthElectrodeType || s.earth_electrode_type) supplyFields.push(`electrodeType=${s.earthElectrodeType || s.earth_electrode_type}`);
      if (s.earthElectrodeResistance || s.earth_electrode_resistance) supplyFields.push(`electrodeRA=${s.earthElectrodeResistance || s.earth_electrode_resistance}`);
      if (s.supplyPolarity || s.supply_polarity_confirmed) supplyFields.push(`polarity=confirmed`);
      if (s.supplyVoltage || s.supply_voltage) supplyFields.push(`voltage=${s.supplyVoltage || s.supply_voltage}V`);
      lines.unshift(`  Supply: [${supplyFields.join(', ')}]`);
    }
    return lines.join('\n');
  }

  /**
   * Periodic review: ask Sonnet to check for orphaned values in the conversation.
   * Returns questions_for_user array, or null if nothing found.
   */
  async reviewForOrphanedValues() {
    if (!this.isActive || this.conversationHistory.length < 4) return null;

    const reviewMessage = `REVIEW CHECK: Look back through this session. Are there any test readings (Zs, insulation resistance, R1+R2, R2, RCD trip time, ring continuity) that were spoken WITHOUT a clear circuit assignment and still haven't been resolved? If so, generate questions asking which circuit they belong to. Only include genuinely unresolved orphaned values. If everything is assigned, return empty arrays.`;

    const messages = [
      ...this.conversationHistory,
      {
        role: 'user',
        content: [{
          type: 'text',
          text: reviewMessage,
          cache_control: { type: 'ephemeral', ttl: '1h' }
        }]
      }
    ];

    this.addMidConversationBreakpoints(messages);

    const response = await this.callWithRetry(messages, 2, null, 512);

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || !textBlock.text) return null;

    let result;
    try {
      const json = this.extractJSON(textBlock.text);
      result = JSON.parse(json);
    } catch {
      return null;
    }

    // Do NOT push review exchange to conversationHistory — it's a meta-instruction,
    // not part of the extraction dialogue. Including it would pollute compaction input.
    // Do NOT increment turnCount — this is not an extraction turn.
    this.costTracker.addSonnetUsage(response.usage);

    return result;
  }

  extractJSON(text) {
    const trimmed = text.trim();
    const fenceMatch = trimmed.match(/```json?\s*([\s\S]*?)```/);
    if (fenceMatch) return fenceMatch[1].trim();
    if (trimmed.startsWith('{')) return trimmed;
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last !== -1) return trimmed.slice(first, last + 1);
    return trimmed;
  }
}
