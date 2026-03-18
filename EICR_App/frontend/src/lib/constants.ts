/**
 * Constants for EICR/EIC certificate editor
 * Based on BS7671 requirements
 */

// Earthing arrangements
export const EARTHING_ARRANGEMENTS = ["TN-S", "TN-C-S", "TT", "IT", "TN-C"];

// Live conductor configurations
export const LIVE_CONDUCTORS = [
  "AC - 1-phase (2 wire)",
  "AC - 1-phase (3 wire)",
  "AC - 3-phase (3 wire)",
  "AC - 3-phase (4 wire)",
  "DC - 2 pole",
  "DC - 3 pole",
];

// Voltage options
export const VOLTAGES = ["230", "400", "110", "N/A", "Other"];

// Frequency options
export const FREQUENCIES = ["50", "60", "N/A"];

// Number of supplies
export const NUMBER_OF_SUPPLIES = ["1", "2", "3", "4", "5", "N/A"];

// Premises description options
export const PREMISES_DESCRIPTIONS = [
  "Residential",
  "Commercial",
  "Industrial",
  "Agricultural",
  "Other",
];

// Next inspection interval options (years)
export const INSPECTION_INTERVALS = [1, 2, 3, 4, 5, 10];

// Inspection schedule outcome options
export const INSPECTION_OUTCOMES = ["tick", "N/A", "C1", "C2", "C3", "LIM"] as const;

export const INSTALLATION_TYPE_LABELS: Record<string, string> = {
  new_installation: "New installation",
  addition: "An addition to an existing installation",
  alteration: "An alteration to an existing installation",
};

// Full EICR inspection schedule organized by section
export const EICR_SCHEDULE_SECTIONS: Record<string, Record<string, string>> = {
  "1. External condition of intake equipment": {
    "1.1": "Intake equipment - Service cable, Service head, Earthing arrangement",
    "1.1.1": "Person ordering work / duty holder notified",
    "1.2": "Consumer's isolator (where present)",
    "1.3": "Consumer's meter tails",
  },
  "2. Presence of adequate arrangements for other sources": {
    "2.0": "Presence of adequate arrangements for other sources such as microgenerators",
  },
  "3. Earthing / bonding arrangements": {
    "3.1": "Presence and condition of distributor's earthing arrangements",
    "3.2": "Presence and condition of earth electrode connection",
    "3.3": "Provision of earthing/bonding labels at all appropriate locations",
    "3.4": "Confirmation of earthing conductor size",
    "3.5": "Accessibility and condition of earthing conductor at MET",
    "3.6": "Confirmation of main protective bonding conductor sizes",
    "3.7": "Condition and accessibility of main protective bonding connections",
    "3.8": "Accessibility and condition of other protective bonding connections",
  },
  "4. Consumer unit(s) / distribution board(s)": {
    "4.1": "Adequacy of working space/accessibility to consumer unit",
    "4.2": "Security of fixing",
    "4.3": "Condition of enclosure(s) in terms of IP rating",
    "4.4": "Condition of enclosure(s) in terms of fire rating",
    "4.5": "Enclosure not damaged/deteriorated so as to impair safety",
    "4.6": "Presence of main linked switch",
    "4.7": "Operation of main switch (functional check)",
    "4.8": "Manual operation of circuit breakers and RCDs",
    "4.9": "Correct identification of circuit details and protective devices",
    "4.10": "Presence of RCD six-monthly test notice",
    "4.11": "Presence of alternative supply warning notice",
    "4.12": "Presence of other required labelling",
    "4.13": "Compatibility of protective devices, bases and other components",
    "4.14": "Single-pole switching or protective devices in line conductor only",
    "4.15": "Protection against mechanical damage where cables enter",
    "4.16": "Protection against electromagnetic effects where cables enter",
    "4.17": "RCD(s) provided for fault protection",
    "4.18": "RCD(s) provided for additional protection",
    "4.19": "Confirmation of indication that SPD is functional",
    "4.20": "Confirmation that ALL conductor connections are secure",
    "4.21": "Adequate arrangements where generating set operates as switched alternative",
    "4.22": "Adequate arrangements where generating set operates in parallel",
  },
  "5. Final circuits": {
    "5.1": "Identification of conductors",
    "5.2": "Cables correctly supported throughout their run",
    "5.3": "Condition of insulation of live parts",
    "5.4": "Non sheathed cables protected by enclosure",
    "5.4.1": "Integrity of conduit and trunking systems",
    "5.5": "Adequacy of cables for current carrying capacity",
    "5.6": "Coordination between conductors and overload protective devices",
    "5.7": "Adequacy of protective devices for fault protection",
    "5.8": "Presence and adequacy of circuit protective conductors",
    "5.9": "Wiring system(s) appropriate for the installation",
    "5.10": "Concealed cables installed in prescribed zones",
    "5.11": "Cables concealed under floors/ceilings/walls adequately protected",
    "5.12": "Provision of additional protection by RCD not exceeding 30 mA",
    "5.12.1": "RCD for socket outlets 32A or less",
    "5.12.2": "RCD for mobile equipment outdoors",
    "5.12.3": "RCD for cables concealed in walls < 50mm",
    "5.12.4": "RCD for final circuits supplying luminaires (domestic)",
    "5.13": "Provision of fire barriers, sealing arrangements",
    "5.14": "Band II cables segregated from Band I cables",
    "5.15": "Cables segregated from communications cabling",
    "5.16": "Cables segregated from non-electrical services",
    "5.17": "Termination of cables at enclosures",
    "5.17.1": "Connections soundly made and under no undue strain",
    "5.17.2": "No basic insulation visible outside enclosure",
    "5.17.3": "Connections of live conductors adequately enclosed",
    "5.17.4": "Adequately connected at point of entry to enclosure",
    "5.18": "Condition of accessories including socket-outlets, switches",
    "5.19": "Suitability of accessories for external influences",
    "5.20": "Adequacy of working space/accessibility to equipment",
    "5.21": "Single-pole switching in line conductors only",
  },
  "6. Location(s) containing a bath or shower": {
    "6.1": "Additional protection for all LV circuits by RCD not exceeding 30mA",
    "6.2": "Requirements for SELV or PELV met",
    "6.3": "Shaver sockets comply with BS EN 61558-2-5",
    "6.4": "Presence of supplementary bonding conductors",
    "6.5": "LV socket-outlets sited at least 2.5m from zone",
    "6.6": "Suitability of equipment for IP rating",
    "6.7": "Suitability of accessories for a particular zone",
    "6.8": "Suitability of current using equipment for position",
  },
  "7. Other Part 7 special installations or locations": {
    "7.02": "Swimming pools and other basins",
    "7.03": "Rooms and cabins containing sauna heaters",
    "7.04": "Construction and demolition site installations",
    "7.05": "Agricultural and horticultural premises",
    "7.06": "Conducting locations with restricted movement",
    "7.08": "Electrical installations in caravan/camping parks",
    "7.09": "Marinas and similar locations",
    "7.10": "Medical locations",
    "7.11": "Exhibitions, shows and stands",
    "7.12": "Solar photovoltaic (PV) power supply systems",
    "7.14": "Outdoor lighting installations",
    "7.15": "Extra-low voltage lighting installations",
    "7.17": "Mobile or transportable units",
    "7.21": "Electrical installations in caravans and motor caravans",
    "7.22": "Electric vehicle charging installations",
    "7.29": "Operating and maintenance gangways",
    "7.30": "Onshore units of electrical connections for inland navigation",
    "7.40": "Temporary electrical installations for structures/amusements",
    "7.53": "Heating cables and embedded heating systems",
  },
};

// EIC Inspection Schedule Items (simplified 14-item version for new installations)
export const EIC_SCHEDULE_ITEMS: Record<string, string> = {
  "1.0": "Condition of consumer's intake equipment (Visual inspection only)",
  "2.0": "Parallel or switched alternative sources of supply",
  "3.0": "Protective measure: Automatic disconnection of supply",
  "4.0": "Basic protection",
  "5.0": "Protective measures other than ADS",
  "6.0": "Additional protection",
  "7.0": "Distribution equipment",
  "8.0": "Circuits (Distribution and final)",
  "9.0": "Isolation and switching",
  "10.0": "Current using equipment (permanently connected)",
  "11.0": "Identification and notices",
  "12.0": "Location(s) containing a bath or shower",
  "13.0": "Other special installations or locations",
  "14.0": "Prosumer's low voltage electrical installation(s)",
};

// Supply Protective Device BS/EN options
export const SPD_BS_EN_OPTIONS = ["Select...", "LIM", "UNKNOWN", "88", "88-2", "88-3", "88-5", "1361-I", "1361-II", "3036-S1A", "3036-S2A", "3036-S4A", "60898-B", "60898-C", "60898-D", "61009-B", "61009-C", "61009-D", "60947-2", "62423-F", "62423-B", "4293", "5419", "N/A", "Other"];

// Short circuit capacity options (kA)
export const SHORT_CIRCUIT_CAPACITY = ["Select...", "1", "3", "6", "10", "16", "25", "33", "50", "LIM", "UNKNOWN", "N/A", "Other"];

// SPD rated current options (A)
export const SPD_RATED_CURRENT = ["Select...", "60", "80", "100", "125", "160", "200", "300", "400", "500", "600", "800", "1000", "1200", "LIM", "UNKNOWN", "N/A", "Other"];

// Main switch BS/EN options
export const MAIN_SWITCH_BS_EN = ["Select...", "60947-3", "61008 RCD", "60947-2 MCCB", "3036 (S-E)", "1361 type 1", "4293 RCD", "88 type gG", "88 type mG", "88 type aM", "5419 isolator", "1361 type 2", "60947-2 ACB", "60898 type B", "61009 type B", "3871 type 2", "3871 type 3", "3871 type B", "3871 type C", "1362", "60947 type B", "60947 type C", "60947-2 type D", "3871 type 1", "3871 type 4", "3871 type D", "LIM", "UNKNOWN", "N/A", "Other"];

// Number of poles options
export const NUMBER_OF_POLES = ["Select...", "1", "2", "3", "4", "LIM", "UNKNOWN", "N/A", "Other"];

// Voltage ratings options (V)
export const VOLTAGE_RATINGS = ["Select...", "230", "240", "400", "415", "440", "LIM", "UNKNOWN", "N/A", "Other"];

// Main switch current ratings (A)
export const MAIN_SWITCH_CURRENT = ["Select...", "40", "63", "80", "100", "125", "160", "200", "250", "LIM", "UNKNOWN", "N/A", "Other"];

// Conductor materials
export const CONDUCTOR_MATERIALS = ["Select...", "Copper", "Aluminium", "Steel", "N/A", "LIM", "Other"];

// Conductor CSA options (mm²)
export const CONDUCTOR_CSA = ["Select...", "6", "10", "16", "25", "35", "50", "70", "95", "120", "150", "185", "240", "N/A", "Other"];

// Bonding CSA options (mm²)
export const BONDING_CSA = ["Select...", "2.5", "4", "6", "10", "16", "25", "50", "N/A", "Other"];

// RCD operating current options (mA)
export const RCD_OPERATING_CURRENT = ["Select...", "10", "30", "100", "300", "500", "1000", "N/A", "N/V", "LIM", "Other"];
