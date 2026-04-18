/**
 * BS 7671 inspection schedule data.
 *
 * Ported verbatim from iOS `Sources/Utilities/Constants.swift`:
 *  - `eicrScheduleSections` → EICR_SCHEDULE (7 sections, ~90 items)
 *  - `eicScheduleItems`     → EIC_SCHEDULE (14 top-level items)
 *
 * Keep in sync with iOS. If an item ref moves or description changes, it
 * must change in both files — the PDF renderer indexes outcomes by ref.
 */

export type ScheduleItem = { ref: string; description: string };
export type ScheduleSection = { title: string; items: ScheduleItem[] };

export const EICR_SCHEDULE: ScheduleSection[] = [
  {
    title: '1. External condition of intake equipment (visual inspection only)',
    items: [
      {
        ref: '1.1',
        description:
          'Intake equipment — service cable, service head, earthing arrangement, meter tails, metering equipment, isolator (where present)',
      },
      { ref: '1.1.1', description: 'Person ordering work / duty holder notified' },
      { ref: '1.2', description: "Consumer's isolator (where present)" },
      { ref: '1.3', description: "Consumer's meter tails" },
    ],
  },
  {
    title: '2. Presence of adequate arrangements for other sources such as microgenerators',
    items: [
      {
        ref: '2.0',
        description:
          'Presence of adequate arrangements for other sources such as microgenerators (551.6; 551.7)',
      },
    ],
  },
  {
    title: '3. Earthing / bonding arrangements (411.3; Chap 54)',
    items: [
      {
        ref: '3.1',
        description:
          "Presence and condition of distributor's earthing arrangements (542.1.2.1; 542.1.2.2)",
      },
      {
        ref: '3.2',
        description:
          'Presence and condition of earth electrode connection where applicable (542.1.2.3)',
      },
      {
        ref: '3.3',
        description: 'Provision of earthing/bonding labels at all appropriate locations (514.13.1)',
      },
      {
        ref: '3.4',
        description: 'Confirmation of earthing conductor size (542.3; 543.1.1)',
      },
      {
        ref: '3.5',
        description: 'Accessibility and condition of earthing conductor at MET (543.3.2)',
      },
      {
        ref: '3.6',
        description: 'Confirmation of main protective bonding conductor sizes (544.1)',
      },
      {
        ref: '3.7',
        description:
          'Condition and accessibility of main protective bonding conductor connections (543.3.2; 544.1.2)',
      },
      {
        ref: '3.8',
        description:
          'Accessibility and condition of other protective bonding connections (543.3.1; 543.3.2)',
      },
    ],
  },
  {
    title: '4. Consumer unit(s) / distribution board(s)',
    items: [
      {
        ref: '4.1',
        description:
          'Adequacy of working space / accessibility to consumer unit / distribution board (132.12; 513.1)',
      },
      { ref: '4.2', description: 'Security of fixing (134.1.1)' },
      { ref: '4.3', description: 'Condition of enclosure(s) in terms of IP rating etc (416.2)' },
      {
        ref: '4.4',
        description: 'Condition of enclosure(s) in terms of fire rating etc (421.1.201; 526.5)',
      },
      {
        ref: '4.5',
        description: 'Enclosure not damaged / deteriorated so as to impair safety (651.2)',
      },
      {
        ref: '4.6',
        description: 'Presence of main linked switched (as required by 462.1.201)',
      },
      { ref: '4.7', description: 'Operation of main switch — functional check (643.10)' },
      {
        ref: '4.8',
        description:
          'Manual operation of circuit breakers and RCDs to prove disconnection (643.10)',
      },
      {
        ref: '4.9',
        description:
          'Correct identification of circuit details and protective devices (514.8.1; 514.9.1)',
      },
      {
        ref: '4.10',
        description:
          'Presence of RCD six-monthly test notice at or near consumer unit / distribution board (514.12.2)',
      },
      {
        ref: '4.11',
        description:
          'Presence of alternative supply warning notice at or near consumer unit / distribution board (514.15)',
      },
      {
        ref: '4.12',
        description: 'Presence of other required labelling (please specify) (Section 514)',
      },
      {
        ref: '4.13',
        description:
          'Compatibility of protective devices, bases and other components — correct type and rating (411.3.2; 411.4; 411.5; 411.6; Sections 432, 433)',
      },
      {
        ref: '4.14',
        description:
          'Single-pole switching or protective devices in line conductor only (132.14.1; 530.3.3)',
      },
      {
        ref: '4.15',
        description:
          'Protection against mechanical damage where cables enter consumer unit / distribution board (522.8.1; 522.8.5; 522.8.11)',
      },
      {
        ref: '4.16',
        description:
          'Protection against electromagnetic effects where cables enter consumer unit / distribution board / enclosures (521.5.1)',
      },
      {
        ref: '4.17',
        description:
          'RCD(s) provided for fault protection — includes RCBOs (411.4.204; 411.5.2; 531.2)',
      },
      {
        ref: '4.18',
        description:
          'RCD(s) provided for additional protection / requirements — includes RCBOs (411.3.3; 415.1)',
      },
      { ref: '4.19', description: 'Confirmation of indication that SPD is functional (651.4)' },
      {
        ref: '4.20',
        description:
          'Confirmation that ALL conductor connections, including connections to busbars, are correctly located in terminals and are tight and secure (526.1)',
      },
      {
        ref: '4.21',
        description:
          'Adequate arrangements where a generating set operates as a switched alternative to the public supply (551.6)',
      },
      {
        ref: '4.22',
        description:
          'Adequate arrangements where a generating set operates in parallel with the public supply (551.7)',
      },
    ],
  },
  {
    title: '5. Final circuits',
    items: [
      { ref: '5.1', description: 'Identification of conductors (514.3.1)' },
      {
        ref: '5.2',
        description: 'Cables correctly supported throughout their run (521.10.202; 522.8.5)',
      },
      { ref: '5.3', description: 'Condition of insulation of live parts (416.1)' },
      {
        ref: '5.4',
        description:
          'Non-sheathed cables protected by enclosure in conduit, ducting or trunking (521.10.1)',
      },
      {
        ref: '5.4.1',
        description: 'To include the integrity of conduit and trunking systems (metal and plastic)',
      },
      {
        ref: '5.5',
        description:
          'Adequacy of cables for current carrying capacity with regard for the type and nature of installation (Section 523)',
      },
      {
        ref: '5.6',
        description:
          'Coordination between conductors and overload protective devices (433.1; 533.2.1)',
      },
      {
        ref: '5.7',
        description:
          'Adequacy of protective devices — type and rated current for fault protection (411.3)',
      },
      {
        ref: '5.8',
        description:
          'Presence and adequacy of circuit protective conductors (411.3.1; Section 543)',
      },
      {
        ref: '5.9',
        description:
          'Wiring system(s) appropriate for the type and nature of the installation and external influences (Section 522)',
      },
      {
        ref: '5.10',
        description:
          'Concealed cables installed in prescribed zones (see Extent and limitations) (522.6.202)',
      },
      {
        ref: '5.11',
        description:
          'Cables concealed under floors, above ceilings or in walls / partitions, adequately protected against damage (522.6.204)',
      },
      {
        ref: '5.12',
        description:
          'Provision of additional requirements for protection by RCD not exceeding 30 mA:',
      },
      {
        ref: '5.12.1',
        description:
          'For all socket outlets of rating 32A or less, unless an exception is permitted (411.3.3)',
      },
      {
        ref: '5.12.2',
        description: 'For the supply of mobile equipment not exceeding 32A rating for use outdoors',
      },
      {
        ref: '5.12.3',
        description:
          'For cables concealed in walls at a depth of less than 50mm (522.6.202; 522.6.203)',
      },
      {
        ref: '5.12.4',
        description:
          'For final circuits supplying luminaires within domestic (household) premises (411.3.4)',
      },
      {
        ref: '5.13',
        description:
          'Provision of fire barriers, sealing arrangements and protection against thermal effects (Section 527)',
      },
      {
        ref: '5.14',
        description: 'Band II cables segregated / separated from Band I cables (528.1)',
      },
      {
        ref: '5.15',
        description: 'Cables segregated / separated from communications cabling (528.2)',
      },
      {
        ref: '5.16',
        description: 'Cables segregated / separated from non-electrical services (528.3)',
      },
      {
        ref: '5.17',
        description:
          'Termination of cables at enclosures — indicate extent of sampling in Extent of Limitations (Section 526):',
      },
      { ref: '5.17.1', description: 'Connections soundly made and under no undue strain (526.6)' },
      {
        ref: '5.17.2',
        description: 'No basic insulation of a conductor visible outside enclosure (526.8)',
      },
      { ref: '5.17.3', description: 'Connections of live conductors adequately enclosed (526.5)' },
      {
        ref: '5.17.4',
        description:
          'Adequately connected at point of entry to enclosure — glands, bushes etc. (522.8.5)',
      },
      {
        ref: '5.18',
        description:
          'Condition of accessories including socket-outlets, switches and joint boxes (651.2 (v))',
      },
      { ref: '5.19', description: 'Suitability of accessories for external influences (512.2)' },
      {
        ref: '5.20',
        description: 'Adequacy of working space / accessibility to equipment (132.12; 513.1)',
      },
      {
        ref: '5.21',
        description:
          'Single-pole switching or protective devices in line conductors only (132.14.1; 530.3.3)',
      },
    ],
  },
  {
    title: '6. Location(s) containing a bath or shower',
    items: [
      {
        ref: '6.1',
        description:
          'Additional protection for all low voltage (LV) circuits by RCD not exceeding 30mA (701.411.3.3)',
      },
      {
        ref: '6.2',
        description:
          'Where used as a protective measure, requirements for SELV or PELV met (701.414.4.5)',
      },
      {
        ref: '6.3',
        description: 'Shaver sockets comply with BS EN 61558-2-5 formerly BS 3535 (701.512.3)',
      },
      {
        ref: '6.4',
        description:
          'Presence of supplementary bonding conductors, unless not required by BS 7671:2018 (701.415.2)',
      },
      {
        ref: '6.5',
        description:
          'Low voltage (e.g. 230V) socket-outlets sited at least 2.5m from zone (701.512.3)',
      },
      {
        ref: '6.6',
        description:
          'Suitability of equipment for external influences for installed location in terms of IP rating (701.512.2)',
      },
      {
        ref: '6.7',
        description:
          'Suitability of accessories and control-gear etc. for a particular zone (701.512.3)',
      },
      {
        ref: '6.8',
        description:
          'Suitability of current using equipment for particular position within the location (701.55)',
      },
    ],
  },
  {
    title: '7. Other Part 7 special installations or locations',
    items: [
      { ref: '7.02', description: 'Swimming pools and other basins (Section 702)' },
      { ref: '7.03', description: 'Rooms and cabins containing sauna heaters (Section 703)' },
      { ref: '7.04', description: 'Construction and demolition site installations (Section 704)' },
      { ref: '7.05', description: 'Agricultural and horticultural (Section 705)' },
      { ref: '7.06', description: 'Conducting locations with restricted movement (Section 706)' },
      {
        ref: '7.08',
        description:
          'Electrical installations in caravan / camping parks and similar locations (Section 708)',
      },
      { ref: '7.09', description: 'Marinas and similar locations (Section 709)' },
      { ref: '7.10', description: 'Medical locations (Section 710)' },
      { ref: '7.11', description: 'Exhibitions, shows and stands (Section 711)' },
      { ref: '7.12', description: 'Solar photovoltaic (PV) power supply systems (Section 712)' },
      { ref: '7.14', description: 'Outdoor lighting installations (Section 714)' },
      { ref: '7.15', description: 'Extra-low voltage lighting installations (Section 715)' },
      { ref: '7.17', description: 'Mobile or transportable units (Section 717)' },
      {
        ref: '7.21',
        description: 'Electrical installations in caravans and motor caravans (Section 721)',
      },
      { ref: '7.22', description: 'Electric vehicle charging installations (Section 722)' },
      { ref: '7.29', description: 'Operating and maintenance gangways (Section 729)' },
      {
        ref: '7.30',
        description:
          'Onshore units of electrical connections for inland navigation vessels (Section 730)',
      },
      {
        ref: '7.40',
        description:
          'Temporary electrical installations for structures, amusement devices and booths at fairgrounds (Section 740)',
      },
      { ref: '7.53', description: 'Heating cables and embedded heating systems (Section 753)' },
    ],
  },
];

export const EIC_SCHEDULE: ScheduleItem[] = [
  { ref: '1.0', description: "Condition of consumer's intake equipment (visual inspection only)" },
  { ref: '2.0', description: 'Parallel or switched alternative sources of supply' },
  { ref: '3.0', description: 'Protective measure: Automatic disconnection of supply' },
  { ref: '4.0', description: 'Basic protection' },
  { ref: '5.0', description: 'Protective measures other than ADS' },
  { ref: '6.0', description: 'Additional protection' },
  { ref: '7.0', description: 'Distribution equipment' },
  { ref: '8.0', description: 'Circuits (distribution and final)' },
  { ref: '9.0', description: 'Isolation and switching' },
  { ref: '10.0', description: 'Current using equipment (permanently connected)' },
  { ref: '11.0', description: 'Identification and notices' },
  { ref: '12.0', description: 'Location(s) containing a bath or shower' },
  { ref: '13.0', description: 'Other special installations or locations' },
  { ref: '14.0', description: "Prosumer's low voltage electrical installation(s)" },
];

/** Outcome codes for each schedule item. "—" means not yet answered. */
export type ScheduleOutcome = '✓' | '✗' | 'N/A' | 'LIM' | 'C1' | 'C2' | 'C3' | 'FI' | '—';

export const OUTCOME_OPTIONS: ScheduleOutcome[] = ['✓', '✗', 'N/A', 'LIM', 'C1', 'C2', 'C3', 'FI'];
