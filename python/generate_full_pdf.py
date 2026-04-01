#!/usr/bin/env python3
"""
Generate full EICR PDF from job output files.
Usage: python generate_full_pdf.py <output_dir>
"""

import sys
import json
import csv
from pathlib import Path
from datetime import datetime

from eicr_pdf_generator import generate_eicr_pdf


def load_json(filepath: Path) -> dict:
    """Load JSON file, return empty dict if not found."""
    if filepath.exists():
        with open(filepath, 'r') as f:
            return json.load(f)
    return {}


def load_csv(filepath: Path) -> list:
    """Load CSV file, return list of dicts."""
    if not filepath.exists():
        return []
    with open(filepath, 'r') as f:
        reader = csv.DictReader(f)
        return list(reader)


def load_inspector_profile(base_path: Path) -> dict:
    """Load the default or last selected inspector profile."""
    profiles_file = base_path / "config" / "inspector_profiles.json"
    if not profiles_file.exists():
        return {
            'name': '',
            'position': 'Qualified Supervisor',
            'organisation': '',
            'enrolment_number': '',
            'mft_serial_number': '',
            'signature_file': None,
        }

    with open(profiles_file, 'r') as f:
        profiles_data = json.load(f)

    profiles = profiles_data.get('profiles', [])
    if not profiles:
        return {
            'name': '',
            'position': 'Qualified Supervisor',
            'organisation': '',
            'enrolment_number': '',
            'mft_serial_number': '',
            'signature_file': None,
        }

    # Try to find last selected or default inspector
    last_selected = profiles_data.get('last_selected')

    # First try last selected
    if last_selected:
        for p in profiles:
            if p.get('id') == last_selected:
                sig_path = None
                if p.get('signature_file'):
                    sig_path = str(base_path / "assets" / "signatures" / p['signature_file'])
                return {
                    'name': p.get('name', ''),
                    'position': p.get('position', 'Qualified Supervisor'),
                    'organisation': p.get('organisation', ''),
                    'enrolment_number': p.get('enrolment_number', ''),
                    'mft_serial_number': p.get('mft_serial_number', ''),
                    'signature_file': sig_path,
                }

    # Then try default
    for p in profiles:
        if p.get('is_default'):
            sig_path = None
            if p.get('signature_file'):
                sig_path = str(base_path / "assets" / "signatures" / p['signature_file'])
            return {
                'name': p.get('name', ''),
                'position': p.get('position', 'Qualified Supervisor'),
                'organisation': p.get('organisation', ''),
                'enrolment_number': p.get('enrolment_number', ''),
                'mft_serial_number': p.get('mft_serial_number', ''),
                'signature_file': sig_path,
            }

    # Fall back to first profile
    p = profiles[0]
    sig_path = None
    if p.get('signature_file'):
        sig_path = str(base_path / "assets" / "signatures" / p['signature_file'])
    return {
        'name': p.get('name', ''),
        'position': p.get('position', 'Qualified Supervisor'),
        'organisation': p.get('organisation', ''),
        'enrolment_number': p.get('enrolment_number', ''),
        'mft_serial_number': p.get('mft_serial_number', ''),
        'signature_file': sig_path,
    }


def parse_float(value: str) -> float:
    """Parse a string to float, returning 0 if invalid."""
    if not value or value.strip() == '':
        return 0.0
    try:
        # Remove any units or special characters
        clean = value.replace('>', '').replace('<', '').replace('Ω', '').replace('ohm', '').strip()
        return float(clean)
    except (ValueError, TypeError):
        return 0.0


def map_circuit_fields(circuit: dict, ze: float = 0.0) -> dict:
    """Map CSV field names to PDF generator field names."""
    # Field mapping from CSV -> PDF generator
    field_map = {
        'num_points': 'number_of_points',
        'ref_method': 'reference_method',
        'live_csa_mm2': 'live_csa',
        'cpc_csa_mm2': 'cpc_csa',
        'max_disconnect_time_s': 'max_disconnection_time',
        'ocpd_breaking_capacity_ka': 'breaking_capacity',
        'ocpd_max_zs_ohm': 'max_zs',
        'ring_r1_ohm': 'r1_ohm',
        'ring_rn_ohm': 'rn_ohm',
        'ring_r2_ohm': 'r2_ohm',
        'r2_ohm': 'R2_ohm',
        'ir_test_voltage_v': 'test_voltage',
        'rcd_button_confirmed': 'rcd_test_button',
        'afdd_button_confirmed': 'afdd_test_button',
    }

    mapped = {}
    for key, value in circuit.items():
        # Use mapped name if exists, otherwise keep original
        new_key = field_map.get(key, key)
        # Only set if not already set with a non-empty value (prevents empty fields overwriting mapped values)
        if new_key not in mapped or not mapped[new_key]:
            mapped[new_key] = value
        # Also keep original key for compatibility
        if key not in mapped or not mapped[key]:
            mapped[key] = value

    # Default polarity to confirmed (ticked)
    if not mapped.get('polarity_confirmed') or mapped.get('polarity_confirmed') == '':
        mapped['polarity_confirmed'] = 'true'

    # Calculate Zs and R1+R2 if needed
    r1_r2 = parse_float(mapped.get('r1_r2_ohm', ''))
    measured_zs = parse_float(mapped.get('measured_zs_ohm', ''))

    # If Zs not measured but we have R1+R2 and Ze, calculate Zs = Ze + R1+R2
    if not measured_zs and r1_r2 > 0 and ze > 0:
        calculated_zs = ze + r1_r2
        mapped['measured_zs_ohm'] = f"{calculated_zs:.2f}"

    # If R1+R2 not provided but we have Zs and Ze, calculate R1+R2 = Zs - Ze
    if not r1_r2 and measured_zs > 0 and ze > 0:
        calculated_r1_r2 = measured_zs - ze
        if calculated_r1_r2 > 0:
            mapped['r1_r2_ohm'] = f"{calculated_r1_r2:.2f}"

    return mapped


def generate_full_certificate(output_dir: str) -> str:
    """Generate full EICR certificate from job output files."""
    out_path = Path(output_dir)

    # Determine base path (project root) for loading inspector profiles
    # output_dir is typically /path/to/EICR_Automation/OUTPUT/job_name
    base_path = out_path.parent.parent

    # Load inspector profile
    inspector = load_inspector_profile(base_path)

    # Load all data files
    installation = load_json(out_path / "installation_details.json")
    board = load_json(out_path / "board_details.json")
    observations = load_json(out_path / "observations.json")
    circuits_raw = load_csv(out_path / "test_results.csv")

    # Default Zs at DB to Ze if not explicitly set
    # (Ze and Zs at DB are the same unless stated differently)
    ze_value = board.get('ze', '')
    zs_at_db_value = board.get('zs_at_db', '')
    if ze_value and not zs_at_db_value:
        board['zs_at_db'] = ze_value
    elif zs_at_db_value and not ze_value:
        board['ze'] = zs_at_db_value

    # Get Ze (external loop impedance) for Zs/R1+R2 calculations
    ze = parse_float(board.get('ze', '') or board.get('zs_at_db', ''))

    # Map CSV field names to PDF generator field names and calculate Zs/R1+R2
    circuits = [map_circuit_fields(c, ze) for c in circuits_raw]

    # Ensure observations is a list
    if isinstance(observations, dict):
        observations = observations.get('observations', [])

    # Build the data structure for PDF generator
    address = installation.get('address', '')
    client_name = installation.get('client_name', '')
    postcode = installation.get('postcode', '')

    # Parse address for street/town/postcode if not provided separately
    full_address = address
    if postcode and postcode not in address:
        full_address = f"{address}, {postcode}"

    # Default inspection schedule items to N/A for domestic installations
    default_na_items = {
        # Section 2 - Microgenerators (usually not present)
        '2.0': 'N/A',
        # Section 3 - Earth electrode (only for TT systems)
        '3.2': 'N/A',
        # Section 4 - Alternative supply / generators
        '4.11': 'N/A',
        '4.21': 'N/A',
        '4.22': 'N/A',
        # Section 5 - Special items often N/A for domestic
        '5.4': 'N/A',
        '5.4.1': 'N/A',
        '5.10': 'LIM',
        '5.11': 'LIM',
        # '5.12.2': ticked by default (mobile equipment outdoors)
        '5.12.3': 'LIM',
        '5.13': 'N/A',
        '5.14': 'N/A',
        '5.15': 'N/A',
        '5.16': 'N/A',
        # '5.17': ticked by default (termination of cables at enclosures)
        # Section 6 - Special locations (set to N/A, change if applicable)
        '6.1': 'N/A',
        '6.2': 'N/A',
        '6.3': 'N/A',
        '6.4': 'N/A',
        # Section 7 - Other Part 7 special installations (all N/A by default)
        '7.02': 'N/A',
        '7.03': 'N/A',
        '7.04': 'N/A',
        '7.05': 'N/A',
        '7.06': 'N/A',
        '7.08': 'N/A',
        '7.09': 'N/A',
        '7.10': 'N/A',
        '7.11': 'N/A',
        '7.12': 'N/A',
        '7.14': 'N/A',
        '7.15': 'N/A',
        '7.17': 'N/A',
        '7.21': 'N/A',
        '7.22': 'N/A',
        '7.29': 'N/A',
        '7.30': 'N/A',
        '7.40': 'N/A',
        '7.53': 'N/A',
    }

    data = {
        'certificate_number': f"EICR-{datetime.now().strftime('%Y%m%d')}-001",
        'client': {
            'name': client_name,
            'address': full_address,
        },
        'installation': {
            'address': full_address,
            'postcode': postcode,
            'description': 'Domestic Electrical Installation',
            'occupier': client_name,
        },
        'extent_and_limitations': {
            'extent': board.get('extent') or 'Fixed electrical wiring installation.\n20% of accessories opened',
            'agreed_limitations': board.get('agreed_limitations') or 'No loft spaces entered. No lifting of floors. HVAC control cables not tested. No testing of heating controls. No destructive inspections, readily visible accessories only.',
            'agreed_with': board.get('agreed_with') or 'Occupier',
            'operational_limitations': board.get('operational_limitations') or '',
        },
        'supply_characteristics': {
            'earthing_arrangement': board.get('earthing_arrangement', 'TN-C-S'),
            'live_conductors': board.get('live_conductors', 'AC - 1-phase (2 wire)'),
            # Nature of Supply Parameters
            'nominal_voltage_u': board.get('nominal_voltage_u', '230'),
            'nominal_voltage_uo': board.get('nominal_voltage_uo', '230'),
            'nominal_frequency': board.get('nominal_frequency', '50'),
            'supply_polarity_confirmed': True,
            'prospective_fault_current': board.get('ipf_at_db', ''),
            'earth_loop_impedance_ze': board.get('ze', '') or board.get('zs_at_db', ''),
            'number_of_supplies': board.get('number_of_supplies', '1'),
            # Supply Protective Device (default LIM - Limited Information)
            'supply_protective_device': {
                'bs_en': board.get('spd_bs_en', 'LIM'),
                'type': board.get('spd_type_supply', 'LIM'),
                'short_circuit_capacity': board.get('spd_short_circuit', 'LIM'),
                'rated_current': board.get('spd_rated_current', 'LIM'),
            },
        },
        'particulars_of_installation': {
            'means_of_earthing': {
                # TN-S and TN-C-S use distributor facility; TT uses earth electrode
                'distributor_facility': board.get('earthing_arrangement', 'TN-C-S') in ['TN-S', 'TN-C-S', 'TN-C'],
                'earth_electrode': board.get('earthing_arrangement', 'TN-C-S') == 'TT',
            },
            'earth_electrode': {
                'type': 'N/A' if board.get('earthing_arrangement', 'TN-C-S') != 'TT' else '',
                'resistance_to_earth': 'N/A' if board.get('earthing_arrangement', 'TN-C-S') != 'TT' else '',
                'location': 'N/A' if board.get('earthing_arrangement', 'TN-C-S') != 'TT' else '',
            },
            'main_switch': {
                'type_bs_en': board.get('main_switch_bs_en', '60947-3'),
                'number_of_poles': board.get('main_switch_poles', '2'),
                'voltage_rating': board.get('voltage_rating', '230'),
                'rated_current': board.get('rated_current', '100'),
                'fuse_device_setting': board.get('fuse_device_setting', 'N/A'),
                'conductor_material': board.get('tails_material', 'Cu'),
                'conductor_csa': board.get('tails_csa', '25'),
            },
            'earthing_conductor': {
                'conductor_material': board.get('earthing_conductor_material', 'Cu'),
                'conductor_csa': board.get('earthing_conductor_csa', '16'),
                'continuity': True,
            },
            'main_protective_bonding': {
                'conductor_material': board.get('bonding_conductor_material', 'Cu'),
                'conductor_csa': board.get('bonding_conductor_csa', '10'),
                'continuity': True,
            },
            'bonding_of_extraneous_parts': {
                'water': True,
                'gas': True,
                'oil': False,
                'steel': False,
                'lightning': False,
                'other': board.get('other_bonding', ''),
            },
        },
        'distribution_board': {
            'name': board.get('name', 'DB-1'),
            'location': board.get('location', ''),
            'manufacturer': board.get('manufacturer', ''),
            'type': board.get('type', ''),
            'supplied_from': board.get('supplied_from', ''),
            'zs_at_db': board.get('zs_at_db', ''),
            'ipf_at_db': board.get('ipf_at_db', ''),
            'main_switch_bs_en': board.get('main_switch_bs_en', '60947-3'),
            'voltage_rating': board.get('voltage_rating', '230'),
            'rated_current': board.get('rated_current', '100'),
            'ipf_rating': board.get('ipf_rating', ''),
            'rcd_rating': board.get('rcd_rating', ''),
            'spd_type': board.get('spd_type', ''),
            'spd_status': board.get('spd_status', ''),
            'notes': board.get('notes', ''),
        },
        'boards': [{
            'name': board.get('name', 'DB-1'),
            'location': board.get('location', ''),
            'manufacturer': board.get('manufacturer', ''),
            'type': board.get('type', ''),
            'supplied_from': board.get('supplied_from', ''),
            'zs_at_db': board.get('zs_at_db', ''),
            'ipf_at_db': board.get('ipf_at_db', ''),
            'main_switch_bs_en': board.get('main_switch_bs_en', '60947-3'),
            'voltage_rating': board.get('voltage_rating', '230'),
            'rated_current': board.get('rated_current', '100'),
            'ipf_rating': board.get('ipf_rating', ''),
            'rcd_rating': board.get('rcd_rating', ''),
            'spd_type': board.get('spd_type', ''),
            'spd_status': board.get('spd_status', ''),
            'notes': board.get('notes', ''),
        }],
        'observations': observations if isinstance(observations, list) else [],
        'circuits': circuits,
        'inspection_schedule': {
            'items': default_na_items,
            'default_code': 'tick',
        },
        'inspector': {
            'name': inspector.get('name', ''),
            'position': inspector.get('position', 'Qualified Supervisor'),
            'organisation': inspector.get('organisation', ''),
            'enrolment_number': inspector.get('enrolment_number', ''),
            'mft_serial_number': inspector.get('mft_serial_number', ''),
            'signature_file': inspector.get('signature_file'),
        },
        'test_date': datetime.now().strftime('%d %b %Y'),
        'next_inspection_date': '',
        # Job path for resolving photo paths
        'job_path': str(out_path),
    }

    # Generate PDF
    pdf_path = str(out_path / "eicr_certificate.pdf")
    generate_eicr_pdf(data, pdf_path)

    return pdf_path


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python generate_full_pdf.py <output_dir>")
        sys.exit(1)

    output_dir = sys.argv[1]
    try:
        pdf_path = generate_full_certificate(output_dir)
        print(f"Generated: {pdf_path}")
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
