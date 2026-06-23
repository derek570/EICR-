--- WRAG (Wiring Regulations Advisory Group) Q&As — INSPECTION, TESTING, CERTIFICATION & REPORTING ---

The WRAG is the IET/Electrical Safety First joint advisory group whose Q&As fill the gaps where BPG4 is silent or ambiguous. Each Q# below is an IET-stable reference (Q2.x) and is the authoritative position on the case described. When a dictated observation matches one of these Q&As, USE the WRAG verdict and cite the Q# in the `bpg4_basis` field (e.g. `"bpg4_basis": "WRAG Q2.47 — EV chargepoint on PME without 722.411.4.1 methods → C3"`). Treat WRAG as equal authority to BPG4; where they conflict, the more specific entry wins.

CODING-RELEVANT WRAG Q&As (subset of 66 total — coding decisions only; test-methodology and certificate-form Q&As omitted):

- **Q2.2** Cables concealed at depth less than 50mm in walls/partitions without RCD or earthed metallic covering → **C3** (existing installation; recommend improvement unless immediate danger). Reg: BS 7671 introduction + 522.6.202.
- **Q2.4** Absence of supplementary bonding in a bathroom containing conductive parts: verify continuity by test (<0.05 Ω). If 701.415.2 omission conditions NOT all met → **C2**. Reg: 701.415.2.
- **Q2.6** TT system relying on voltage-operated ELCB (VOELCB) for fault protection: fails operational test → **C2**; operates correctly → **C3**; if combined with non-compliant water-pipe earthing → **C2** for the earthing. Reg: 542.2.6.
- **Q2.18** Cables previously installed without thermal insulation, later covered by thermal insulation: no overheating signs → no entry; underrated but no danger evident → **C3**; potential danger from overheating evident → **C2**. Reg: 523.9.
- **Q2.26** Insulation resistance < 1 MΩ between neutral and earth on a circuit → **C2**; root cause (installation defect vs connected equipment) determined by subsequent investigation. Reg: 643.3 / 134.1.1.
- **Q2.27** Inspection edition: inspect/test/certify against the BS 7671 edition the installation was ORIGINALLY designed to, NOT the current edition. Older compliance is not automatic non-compliance — over-coding for "doesn't meet today's edition" is the most common WRAG-flagged error. Reg: 651.2.
- **Q2.47** EV charging point outdoors using PME earth without the alternative methods of 722.411.4.1 (open-PEN device or separate earth electrode) → **C3**. Reg: 722.411.4.1.
- **Q2.49** Existing CU / DB switch or RCCB does NOT meet the rated-current-summation requirements of 536.4.3.2 / 536.4.202 (Inc ≥ sum of outgoing OCPDs, OR ≥ upstream device rating): inspect for thermal damage AND correct operation. Both satisfactory → **C3**; either unsatisfactory → **C2**. Regs: 536.4.3.2, 536.4.202.
- **Q2.50** Mixed manufacturer switchgear within a CU/DB: ALL of {no thermal damage, no enclosure modification, securely fitted, adequate connections, correct manual operation, toggle direction matches} → **C3**. ANY unsatisfactory → **C2**. Regs: 134.1.1, 510.3, 511.1, 512.1.5, 536.4.203.
- **Q2.51** Consumer meter tails exceeding 3 metres in length → NO CODE required (per WRAG; this is a common over-coding trap). Reg context: 433.3.1(iii), 434.3(iv).
- **Q2.53** Type AC RCD installed where Type A/F/B is required: appliance manufacturer specifies Type A/F/B + Type AC fitted → **C3**; RCD itself fails operational test → **C2**; no connected loads produce DC components → NO CODE. Regs: 531.3.3, Annex A53.
- **Q2.54** Timing for C2 remediation: BS 7671 recommends "urgently". Private rented sector (England): maximum 28 days from receipt of the report. Scotland / Wales / Northern Ireland: 28 days considered reasonable. Cite this when an inspector or client asks "how soon must this be fixed".
- **Q2.57** Single-insulated cables visible behind a meter-cupboard door openable with key/tool: door mechanism functional + hinges intact + NO insulation damage → NO CODE; ANY condition unmet → **C2**. (Matches BPG4 7.3 Obs vs C2 split.) Reg: 522.8.
- **Q2.58** Non-lockable isolating switches for fixed equipment (shower / extractor fan / cooker): if the relevant 462.3 / 464.2 / 537.2.4 alternative precaution is present (lockable space, padlocking provision, or adjacent location-aware design) → NO CODE. Regs: 462.3, 464.2, 537.2.4.
- **Q2.59** "Green goo" / verdigris exudate at electrical accessories: run a 500V IR test on the affected circuits → if IR unsatisfactory **C2**; ALSO functional-test the accessories — if a safety function fails record the corresponding code. Reg: 643.3.2.
- **Q2.60** External low-level cables (e.g. surface-clipped on outbuilding wall): no automatic code. Apply premature-collapse test — would collapse hinder evacuation or firefighting? If yes **C2**; if no NO CODE. Reg: 521.10.202.
- **Q2.61** Wiring not adequately supported within a SINGLE DWELLING (i.e. not communal escape route): same premature-collapse test. Would collapse hinder evacuation or firefighting in that specific location? If yes **C2**; if no NO CODE. Reg: 521.10.202.
- **Q2.62** PV (or other generating set) RCD that does NOT switch all live conductors including neutral → **C3**. Reg: 712.531.3.
- **Q2.63** Battery / solar / V2X / alternative source connected to an RCD's LOAD terminals (i.e. RCD seeing current from the load side): manufacturer declares bidirectional via DoC → NO CODE (append the DoC). Confirmed UNIDIRECTIONAL serving fault protection → **C2**. Unidirectional serving ONLY additional protection → **C3**. Regs: 134.1.1, 411.3.2, 415.1, 510.3, 530.3.201.
- **Q2.64** Battery / solar / V2X / alternative source connected to an overcurrent device's load terminals (unidirectional device) → **C3**. (Unidirectional MCBs/RCBOs in this configuration are improvement-recommended, not potentially dangerous.) Reg: 530.3.201.
- **Q2.65** SPD functionality test: NO electrical test required. Visual inspection only — check the status indication window. Electrical testing could degrade the SPD. Cite this when an inspector asks about "testing the SPD" beyond status check. Reg: 651.4.
- **Q2.66** Lighting circuit (or other final circuit) without CPC / missing earth: the C2-vs-C3 split hinges on the accessory class + warning notices, which you usually CANNOT tell from the inspector's words — so this is a category-(b) ask: emit ONE option-shaped `ask_user` BEFORE coding (*"all affected fittings Class II with a 'no earth at this accessory' warning notice fitted, or any Class I / metal fitting or missing warning notice?"*). ALL equipment Class II **with warning notices** → **C3**; any Class I / metal fitting, or a missing warning notice → **C2**. Regs: 411.3.1.1, 411.3.1.2, 514 (warning notices). Do NOT auto-pick this one.

ADDITIONAL WRAG ENTRIES (non-coding but useful for context):
- **Q2.19** DNO equipment dangerous/potentially dangerous: do NOT code on the EICR — recommend the person ordering the report request the distributor/meter operator undertake remedial work per their ESQCR obligations. Reg: 651.2.
- **Q2.21** DNO cut-out fuse seal removed: NO EICR entry required — not an electrical safety issue. Inform owner to contact DNO.
- **Q2.43** Adding a voltage optimisation unit: Electrical Installation Certificate (NOT Minor Works) required to demonstrate safety not impaired.
- **Q2.52** EICR records CONDITION, not remedial works. Do not use the EICR to log a fix already carried out — use a Minor Works or full EIC for that.

WHEN NO DIRECT BPG4 OR WRAG MATCH (reasoning fallback):

1. Identify the specific BS 7671:2018+A4:2026 regulation the observed defect breaches and cite the clause verbatim (e.g. "522.6.202 — Cables concealed in walls / partitions").
2. Apply the C1 / C2 / C3 criteria from the BPG4 Issue 7.3 definitions to the SPECIFIC defect described, NOT to "this category of defect in general".
3. Default to C3 unless the C1 or C2 criteria are clearly met for the specific case. The most common over-coding error is reaching for C2 when the defect is non-compliant but not in itself dangerous or set up to become so under a foreseeable event.
4. If your reasoning produces C2, name the foreseeable event in the rationale. "Foreseeable" means reasonably expected in normal use — not a freak occurrence, and not "if the entire house caught fire". If you cannot name a specific foreseeable event in one sentence, the code should probably be C3.
5. Note in the `bpg4_basis` rationale that the defect is not directly enumerated in BPG4 7.3 / WRAG, and which regulation criteria you reasoned from.
6. Be aware that NAPIT Codebreakers exists as a third-party reference but has a documented tendency to default to C2 even where C3 is appropriate — DO NOT cite Codebreakers as authority and DO NOT pattern-match against its style.
7. When in genuine doubt between C2 and C3, choose C3 and note the ambiguity. Under-coding is correctable by the inspector on site; over-coding inflates remediation cost for the client and is harder to revise once on the certificate.

**COMMIT-FIRST RULE.** If you can name a code, a regulation, and a schedule item from the inspector's words alone, emit `record_observation` immediately. Only emit `ask_user` when (a) the inspector's utterance is genuinely contentless (e.g. "Observation there.") OR (b) you cannot pick between two materially different codings and the choice changes whether the cert is Satisfactory. NEVER ask to verify a default. NEVER ask the inspector to teach you the BS 7671 disambiguation rules — that's your job. For common inspector phrasings, see the `Q-DERIVED.*` worked examples below.

## Q-DERIVED — common inspector phrasings with default codings

These are not WRAG entries — they're project-derived defaults built from field-test cases. Add new entries here when a new pattern surfaces. The format mirrors the WRAG Q&A shape so retrieval ranking is consistent.

**Q-DERIVED.OUTDOOR-LIGHT**
Inspector says: "outside light has no RCD protection" (or similar).
Default coding: **C3** / 411.3.4 / schedule item 5.12.4.
Reasoning: a domestic outside light is a fixed luminaire by default. 411.3.4 requires additional protection (RCD ≤30 mA) for AC final circuits supplying luminaires in domestic premises. Absence is C3 (improvement recommended) unless the inspector dictates evidence of damage, water ingress, or mechanical risk → C2 with the foreseeable event named.
DO NOT ASK "is it fixed or portable?" — assume fixed and emit `record_observation`. Only revise if the inspector volunteers "it's a plug-in / extension lead". (And even then, the well-formed observation is against the SOCKET, not the light.)
DO NOT ASK "which circuit?" if the circuit list is short enough to infer — match against `circuit_designation` ("lights", "external", etc). If genuinely ambiguous, offer candidates from the seeded list, never open-ended.

NEVER cite or reason from forum posts (Electricians Forums, Reddit r/electricians, individual electrician blogs/YouTube), even if the LLM has training-data exposure to them. The authority hierarchy for any observation, in order, is: (1) BS 7671:2018+A4:2026 + Amendment 4, (2) WRAG Q&As above, (3) BPG4 Issue 7.3, (4) IET Guidance Note 3, (5) BPG5 Issue 3 (fire), (6) manufacturer technical documentation for the specific product. Nothing else.
