/**
 * BS 7671 inspection-schedule item lists — verbatim ports of
 * `EICRHTMLTemplate.inspectionScheduleItems()` (EICR, Swift lines
 * 1882-1997) and `Constants.eicScheduleItems` (EIC, Constants.swift:
 * 416-431). Item refs, wording, and ordering are canon — do not edit
 * without an iOS-side change to mirror.
 */

export interface InspectionItem {
  ref: string;
  description?: string;
  isHeader: boolean;
}

function header(ref: string): InspectionItem {
  return { ref, isHeader: true };
}

function item(ref: string, description: string): InspectionItem {
  return { ref, description, isHeader: false };
}

export function inspectionScheduleItems(): InspectionItem[] {
  return [
    // Section 1
    header('1. External condition of intake equipment (visual inspection only)'),
    item(
      '1.1',
      "Intake equipment\n- Service cable\n- Service head\n- Earthing arrangement\n- Meter tails\n- Metering equipment\n- Isolator (where present)\nNOTE 1: Where inadequacies in the intake equipment are encountered, which may result in a dangerous or potentially dangerous situation, the person ordering the work and / or duty holder must be informed. It is strongly recommended that the person ordering the work informs the appropriate authority.\nNOTE 2: For this section only, where inadequacies are found, an 'X' should be put against the appropriate item and a comment made in the Observations section."
    ),
    item('1.1.1', 'Person ordering work / duty holder notified'),
    item('1.2', "Consumer's isolator (where present)"),
    item('1.3', "Consumer's meter tails"),

    // Section 2
    header(
      '2. Presence of adequate arrangements for other sources such as microgenerators (551.6; 551.7)'
    ),
    item(
      '2.0',
      'Presence of adequate arrangements for other sources such as microgenerators (551.6; 551.7)'
    ),

    // Section 3
    header('3. Earthing / bonding arrangements (411.3; Chap 54)'),
    item(
      '3.1',
      "Presence and condition of distributor's earthing arrangements (542.1.2.1; 542.1.2.2)"
    ),
    item(
      '3.2',
      'Presence and condition of earth electrode connection where applicable (542.1.2.3)'
    ),
    item('3.3', 'Provision of earthing/bonding labels at all appropriate locations (514.13.1)'),
    item('3.4', 'Confirmation of earthing conductor size (542.3; 543.1.1)'),
    item('3.5', 'Accessibility and condition of earthing conductor at MET (543.3.2)'),
    item('3.6', 'Confirmation of main protective bonding conductor sizes (544.1)'),
    item(
      '3.7',
      'Condition and accessibility of main protective bonding conductor connections (543.3.2; 544.1.2)'
    ),
    item(
      '3.8',
      'Accessibility and condition of other protective bonding connections (543.3.1; 543.3.2)'
    ),

    // Section 4
    header('4. Consumer unit(s) / distribution board(s)'),
    item(
      '4.1',
      'Adequacy of working space/accessibility to consumer unit/distribution board (132.12; 513.1)'
    ),
    item('4.2', 'Security of fixing (134.1.1)'),
    item('4.3', 'Condition of enclosure(s) in terms of IP rating etc (416.2)'),
    item('4.4', 'Condition of enclosure(s) in terms of fire rating etc (421.1.201; 526.5)'),
    item('4.5', 'Enclosure not damaged/deteriorated so as to impair safety (651.2)'),
    item('4.6', 'Presence of main linked switched (as required by 462.1.201)'),
    item('4.7', 'Operation of main switch (functional check) (643.10)'),
    item('4.8', 'Manual operation of circuit breakers and RCDs to prove disconnection (643.10)'),
    item(
      '4.9',
      'Correct identification of circuit details and protective devices (514.8.1; 514.9.1)'
    ),
    item(
      '4.10',
      'Presence of RCD six-monthly test notice at or near consumer unit/distribution board (514.12.2)'
    ),
    item(
      '4.11',
      'Presence of alternative supply warning notice at or near consumer unit/distribution board (514.15)'
    ),
    item('4.12', 'Presence of other required labelling (please specify) (Section 514)'),
    item(
      '4.13',
      'Compatibility of protective devices, bases and other components, correct type and rating (No signs of unacceptable thermal damage, arcing or overheating) (411.3.2; 411.4; 411.5; 411.6; Sections 432, 433)'
    ),
    item(
      '4.14',
      'Single-pole switching or protective devices in line conductor only (132.14.1; 530.3.3)'
    ),
    item(
      '4.15',
      'Protection against mechanical damage where cables enter consumer unit/distribution board (522.8.1; 522.8.5; 522.8.11)'
    ),
    item(
      '4.16',
      'Protection against electromagnetic effects where cables enter consumer unit/distribution board/enclosures (521.5.1)'
    ),
    item(
      '4.17',
      'RCD(s) provided for fault protection - includes RCBOs (411.4.204; 411.5.2; 531.2)'
    ),
    item(
      '4.18',
      'RCD(s) provided for additional protection / requirements - includes RCBOs (411.3.3; 415.1)'
    ),
    item('4.19', 'Confirmation of indication that SPD is functional (651.4)'),
    item(
      '4.20',
      'Confirmation that ALL conductor connections, including connections to busbars, are correctly located in terminals and are tight and secure (526.1)'
    ),
    item(
      '4.21',
      'Adequate arrangements where a generating set operates as a switched alternative to the public supply (551.6)'
    ),
    item(
      '4.22',
      'Adequate arrangements where a generating set operates in parallel with the public supply (551.7)'
    ),

    // Section 5
    header('5. Final circuits'),
    item('5.1', 'Identification of conductors (514.3.1)'),
    item('5.2', 'Cables correctly supported throughout their run (521.10.202; 522.8.5)'),
    item('5.3', 'Condition of insulation of live parts (416.1)'),
    item(
      '5.4',
      'Non sheathed cables protected by enclosure in conduit, ducting or trunking (521.10.1)'
    ),
    item('5.4.1', 'To include the integrity of conduit and trunking systems (metal and plastic)'),
    item(
      '5.5',
      'Adequacy of cables for current carrying capacity with regard for the type and nature of installation (Section 523)'
    ),
    item('5.6', 'Coordination between conductors and overload protective devices (433.1; 533.2.1)'),
    item(
      '5.7',
      'Adequacy of protective devices: type and rated current for fault protection (411.3)'
    ),
    item('5.8', 'Presence and adequacy of circuit protective conductors (411.3.1; Section 543)'),
    item(
      '5.9',
      'Wiring system(s) appropriate for the type and nature of the installation and external influences (Section 522)'
    ),
    item(
      '5.10',
      'Concealed cables installed in prescribed zones (see Extent and limitations) (522.6.202)'
    ),
    item(
      '5.11',
      'Cables concealed under floors, above ceilings or in walls/partitions, adequately protected against damage (see Extent and limitations) (522.6.204)'
    ),
    item('5.12', 'Provision of additional requirements for protection by RCD not exceeding 30 mA:'),
    item(
      '5.12.1',
      'For all socket outlets of rating 32A or less, unless an exception is permitted (411.3.3)'
    ),
    item('5.12.2', 'For the supply of mobile equipment not exceeding 32A rating for use outdoors'),
    item(
      '5.12.3',
      'For cables concealed in walls at a depth of less than 50mm (522.6.202; 522.6.203)'
    ),
    item(
      '5.12.4',
      'For final circuits supplying luminaires within domestic (household) premises (411.3.4)'
    ),
    item(
      '5.13',
      'Provision of fire barriers, sealing arrangements and protection against thermal effects (Section 527)'
    ),
    item('5.14', 'Band II cables segregated/separated from Band I cables (528.1)'),
    item('5.15', 'Cables segregated/separated from communications cabling (528.2)'),
    item('5.16', 'Cables segregated/separated from non-electrical services (528.3)'),
    item(
      '5.17',
      'Termination of cables at enclosures - indicate extent of sampling in Extent of Limitations of the report (Section 526):'
    ),
    item('5.17.1', 'Connections soundly made and under no undue strain (526.6)'),
    item('5.17.2', 'No basic insulation of a conductor visible outside enclosure (526.8)'),
    item('5.17.3', 'Connections of live conductors adequately enclosed (526.5)'),
    item(
      '5.17.4',
      'Adequately connected at point of entry to enclosure (glands, bushes etc.) (522.8.5)'
    ),
    item(
      '5.18',
      'Condition of accessories including socket-outlets, switches and joint boxes (651.2 (v))'
    ),
    item('5.19', 'Suitability of accessories for external influences (512.2)'),
    item('5.20', 'Adequacy of working space/accessibility to equipment (132.12; 513.1)'),
    item(
      '5.21',
      'Single-pole switching or protective devices in line conductors only (132.14.1; 530.3.3)'
    ),

    // Section 6
    header('6. Location(s) containing a bath or shower'),
    item(
      '6.1',
      'Additional protection for all low voltage (LV) circuits by RCD not exceeding 30mA (701.411.3.3)'
    ),
    item(
      '6.2',
      'Where used as a protective measure, requirements for SELV or PELV met (701.414.4.5)'
    ),
    item('6.3', 'Shaver sockets comply with BS EN 61558-2-5 formerly BS 3535 (701.512.3)'),
    item(
      '6.4',
      'Presence of supplementary bonding conductors, unless not required by BS 7671:2018 (701.415.2)'
    ),
    item(
      '6.5',
      'Low voltage (e.g. 230 volt) socket-outlets sited at least 2.5m from zone (701.512.3)'
    ),
    item(
      '6.6',
      'Suitability of equipment for external influences for installed location in terms of IP rating (701.512.2)'
    ),
    item(
      '6.7',
      'Suitability of accessories and control-gear etc. for a particular zone (701.512.3)'
    ),
    item(
      '6.8',
      'Suitability of current using equipment for particular position within the location (701.55)'
    ),

    // Section 7
    header('7. Other Part 7 special installations or locations'),
    item('7.02', 'Swimming pools and other basins (Section 702)'),
    item('7.03', 'Rooms and cabins containing sauna heaters (Section 703)'),
    item(
      '7.04',
      'Construction and demolition site installations. (BS 7375 should also be consulted within this special location. Findings which contravene BS 7375 may need to be reported separately). (Section 704)'
    ),
    item('7.05', 'Agricultural and horticultural (Section 705)'),
    item('7.06', 'Conducting locations with restricted movement (Section 706)'),
    item(
      '7.08',
      'Electrical installations in caravan / camping parks and similar locations (Section 708)'
    ),
    item('7.09', 'Marinas and similar locations (Section 709)'),
    item('7.10', 'Medical locations (Section 710)'),
    item(
      '7.11',
      'Exhibitions, shows and stands. (BS 7909 should also be consulted within this special location. Findings which contravene BS 7909 may need to be reported separately). (Section 711)'
    ),
    item('7.12', 'Solar photovoltaic (PV) power supply systems (Section 712)'),
    item('7.14', 'Outdoor lighting installations (Section 714)'),
    item('7.15', 'Extra-low voltage lighting installations (Section 715)'),
    item('7.17', 'Mobile or transportable units (Section 717)'),
    item('7.21', 'Electrical installations in caravans and motor caravans (Section 721)'),
    item('7.22', 'Electric vehicle charging installations (Section 722)'),
    item('7.29', 'Operating and maintenance gangways (Section 729)'),
    item(
      '7.30',
      'Onshore units of electrical connections for inland navigation vessels (Section 730)'
    ),
    item(
      '7.40',
      'Temporary electrical installations for structures, amusement devices and booths at fairgrounds, amusement parks and circuses. (BS 7909 should also be consulted within this special location. Findings which contravene BS 7909 may need to be reported separately). (Section 740)'
    ),
    item('7.53', 'Heating cables and embedded heating systems. (Section 753)'),
  ];
}

/** EIC schedule — `Constants.eicScheduleItems` (14 items). */
export const eicScheduleItems: { ref: string; description: string }[] = [
  { ref: '1.0', description: "Condition of consumer's intake equipment (Visual inspection only)" },
  { ref: '2.0', description: 'Parallel or switched alternative sources of supply' },
  { ref: '3.0', description: 'Protective measure: Automatic disconnection of supply' },
  { ref: '4.0', description: 'Basic protection' },
  { ref: '5.0', description: 'Protective measures other than ADS' },
  { ref: '6.0', description: 'Additional protection' },
  { ref: '7.0', description: 'Distribution equipment' },
  { ref: '8.0', description: 'Circuits (Distribution and final)' },
  { ref: '9.0', description: 'Isolation and switching' },
  { ref: '10.0', description: 'Current using equipment (permanently connected)' },
  { ref: '11.0', description: 'Identification and notices' },
  { ref: '12.0', description: 'Location(s) containing a bath or shower' },
  { ref: '13.0', description: 'Other special installations or locations' },
  { ref: '14.0', description: "Prosumer's low voltage electrical installation(s)" },
];
