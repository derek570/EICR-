#!/usr/bin/env python3
"""
EICR PDF Generator - Creates professional EICR certificates matching Tradecert format.
"""

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm, cm
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    Image, PageBreak, KeepTogether, ListFlowable, ListItem, Flowable,
    BaseDocTemplate, PageTemplate, Frame, NextPageTemplate
)
from reportlab.pdfgen import canvas
from datetime import datetime
from pathlib import Path
import json
import csv
import os


# Tradecert-style color palette - red headers with professional backgrounds
RED_HEADER = colors.HexColor('#CC0000')        # Tradecert red for headers
HEADER_ACCENT = colors.HexColor('#B80000')     # Darker red accent
LIGHT_GRAY = colors.HexColor('#F0F0F0')        # Light gray for label backgrounds
LIGHT_BLUE = colors.HexColor('#E8F4F8')        # Light blue tint for data cells
LIGHT_CREAM = colors.HexColor('#FFFEF5')       # Cream for alternating rows
BORDER_GRAY = colors.HexColor('#CCCCCC')       # Border color
GREEN_CHECK = colors.HexColor('#228B22')       # Forest green for ticks
RED_C1 = colors.HexColor('#CC0000')            # Red for C1
ORANGE_C2 = colors.HexColor('#FF8C00')         # Dark orange for C2
BLUE_C3 = colors.HexColor('#0066CC')           # Blue for C3
YELLOW_FI = colors.HexColor('#FFD700')         # Gold/yellow for FI
GRAY_NA = colors.HexColor('#808080')           # Gray for N/A
TEXT_DARK = colors.HexColor('#000000')         # Black text
TEXT_SECONDARY = colors.HexColor('#333333')    # Dark gray text

# Alias for compatibility
HEADER_NAVY = RED_HEADER
PURPLE_FI = YELLOW_FI


# Full inspection schedule items from BS7671 - matching Tradecert format exactly
INSPECTION_SCHEDULE_ITEMS = [
    # Section 1: External condition of intake equipment
    ("1. External condition of intake equipment (visual inspection only)", None, True),
    ("1.1", "Intake equipment - Service cable, Service head, Earthing arrangement, Meter tails, Metering equipment, Isolator (where present)", False),
    ("1.1.1", "Person ordering work / duty holder notified", False),
    ("1.2", "Consumer's isolator (where present)", False),
    ("1.3", "Consumer's meter tails", False),

    # Section 2: Presence of adequate arrangements
    ("2. Presence of adequate arrangements for other sources such as microgenerators (551.6; 551.7)", None, True),
    ("2.0", "Presence of adequate arrangements for other sources such as microgenerators (551.6; 551.7)", False),

    # Section 3: Earthing/bonding arrangements
    ("3. Earthing / bonding arrangements (411.3; Chap 54)", None, True),
    ("3.1", "Presence and condition of distributor's earthing arrangements (542.1.2.1; 542.1.2.2)", False),
    ("3.2", "Presence and condition of earth electrode connection where applicable (542.1.2.3)", False),
    ("3.3", "Provision of earthing/bonding labels at all appropriate locations (514.13.1)", False),
    ("3.4", "Confirmation of earthing conductor size (542.3; 543.1.1)", False),
    ("3.5", "Accessibility and condition of earthing conductor at MET (543.3.2)", False),
    ("3.6", "Confirmation of main protective bonding conductor sizes (544.1)", False),
    ("3.7", "Condition and accessibility of main protective bonding conductor connections (543.3.2; 544.1.2)", False),
    ("3.8", "Accessibility and condition of other protective bonding connections (543.3.1; 543.3.2)", False),

    # Section 4: Consumer unit(s) / distribution board(s)
    ("4. Consumer unit(s) / distribution board(s)", None, True),
    ("4.1", "Adequacy of working space/accessibility to consumer unit/distribution board (132.12; 513.1)", False),
    ("4.2", "Security of fixing (134.1.1)", False),
    ("4.3", "Condition of enclosure(s) in terms of IP rating etc (416.2)", False),
    ("4.4", "Condition of enclosure(s) in terms of fire rating etc (421.1.201; 526.5)", False),
    ("4.5", "Enclosure not damaged/deteriorated so as to impair safety (651.2)", False),
    ("4.6", "Presence of main linked switch (as required by 462.1.201)", False),
    ("4.7", "Operation of main switch (functional check) (643.10)", False),
    ("4.8", "Manual operation of circuit breakers and RCDs to prove disconnection (643.10)", False),
    ("4.9", "Correct identification of circuit details and protective devices (514.8.1; 514.9.1)", False),
    ("4.10", "Presence of RCD six-monthly test notice at or near consumer unit/distribution board (514.12.2)", False),
    ("4.11", "Presence of alternative supply warning notice at or near consumer unit/distribution board (514.15)", False),
    ("4.12", "Presence of other required labelling (please specify) (Section 514)", False),
    ("4.13", "Compatibility of protective devices, bases and other components, correct type and rating (No signs of unacceptable thermal damage, arcing or overheating) (411.3.2; 411.4; 411.5; 411.6; Sections 432, 433)", False),
    ("4.14", "Single-pole switching or protective devices in line conductor only (132.14.1; 530.3.3)", False),
    ("4.15", "Protection against mechanical damage where cables enter consumer unit/distribution board (522.8.1; 522.8.5; 522.8.11)", False),
    ("4.16", "Protection against electromagnetic effects where cables enter consumer unit/distribution board/enclosures (521.5.1)", False),
    ("4.17", "RCD(s) provided for fault protection - includes RCBOs (411.4.204; 411.5.2; 531.2)", False),
    ("4.18", "RCD(s) provided for additional protection / requirements - includes RCBOs (411.3.3; 415.1)", False),
    ("4.19", "Confirmation of indication that SPD is functional (651.4)", False),
    ("4.20", "Confirmation that ALL conductor connections, including connections to busbars, are correctly located in terminals and are tight and secure (526.1)", False),
    ("4.21", "Adequate arrangements where a generating set operates as a switched alternative to the public supply (551.6)", False),
    ("4.22", "Adequate arrangements where a generating set operates in parallel with the public supply (551.7)", False),

    # Section 5: Final circuits
    ("5. Final circuits", None, True),
    ("5.1", "Identification of conductors (514.3.1)", False),
    ("5.2", "Cables correctly supported throughout their run (521.10.202; 522.8.5)", False),
    ("5.3", "Condition of insulation of live parts (416.1)", False),
    ("5.4", "Non sheathed cables protected by enclosure in conduit, ducting or trunking (521.10.1)", False),
    ("5.4.1", "To include the integrity of conduit and trunking systems (metal and plastic)", False),
    ("5.5", "Adequacy of cables for current carrying capacity with regard for the type and nature of installation (Section 523)", False),
    ("5.6", "Coordination between conductors and overload protective devices (433.1; 533.2.1)", False),
    ("5.7", "Adequacy of protective devices: type and rated current for fault protection (411.3)", False),
    ("5.8", "Presence and adequacy of circuit protective conductors (411.3.1; Section 543)", False),
    ("5.9", "Wiring system(s) appropriate for the type and nature of the installation and external influences (Section 522)", False),
    ("5.10", "Concealed cables installed in prescribed zones (see Extent and limitations) (522.6.202)", False),
    ("5.11", "Cables concealed under floors, above ceilings or in walls/partitions, adequately protected against damage (see Extent and limitations) (522.6.204)", False),
    ("5.12", "Provision of additional requirements for protection by RCD not exceeding 30 mA:", False),
    ("5.12.1", "For all socket outlets of rating 32A or less, unless an exception is permitted (411.3.3)", False),
    ("5.12.2", "For the supply of mobile equipment not exceeding 32A rating for use outdoors", False),
    ("5.12.3", "For cables concealed in walls at a depth of less than 50mm (522.6.202; 522.6.203)", False),
    ("5.12.4", "For final circuits supplying luminaires within domestic (household) premises (411.3.4)", False),
    ("5.13", "Provision of fire barriers, sealing arrangements and protection against thermal effects (Section 527)", False),
    ("5.14", "Band II cables segregated/separated from Band I cables (528.1)", False),
    ("5.15", "Cables segregated/separated from communications cabling (528.2)", False),
    ("5.16", "Cables segregated/separated from non-electrical services (528.3)", False),
    ("5.17", "Termination of cables at enclosures - indicate extent of sampling in Extent of Limitations of the report (Section 526):", False),
    ("5.17.1", "Connections soundly made and under no undue strain (526.6)", False),
    ("5.17.2", "No basic insulation of a conductor visible outside enclosure (526.8)", False),
    ("5.17.3", "Connections of live conductors adequately enclosed (526.5)", False),
    ("5.17.4", "Adequately connected at point of entry to enclosure (glands, bushes etc.) (522.8.5)", False),
    ("5.18", "Condition of accessories including socket-outlets, switches and joint boxes (651.2 (v))", False),
    ("5.19", "Suitability of accessories for external influences (512.2)", False),
    ("5.20", "Adequacy of working space/accessibility to equipment (132.12; 513.1)", False),
    ("5.21", "Single-pole switching or protective devices in line conductors only (132.14.1; 530.3.3)", False),

    # Section 6: Locations containing a bath or shower
    ("6. Location(s) containing a bath or shower", None, True),
    ("6.1", "Additional protection for all low voltage (LV) circuits by RCD not exceeding 30mA (701.411.3.3)", False),
    ("6.2", "Where used as a protective measure, requirements for SELV or PELV met (701.414.4.5)", False),
    ("6.3", "Shaver sockets comply with BS EN 61558-2-5 formerly BS 3535 (701.512.3)", False),
    ("6.4", "Presence of supplementary bonding conductors, unless not required by BS 7671:2018 (701.415.2)", False),
    ("6.5", "Low voltage (e.g. 230 volt) socket-outlets sited at least 2.5m from zone (701.512.3)", False),
    ("6.6", "Suitability of equipment for external influences for installed location in terms of IP rating (701.512.2)", False),
    ("6.7", "Suitability of accessories and control-gear etc. for a particular zone (701.512.3)", False),
    ("6.8", "Suitability of current using equipment for particular position within the location (701.55)", False),

    # Section 7: Other Part 7 special installations or locations
    ("7. Other Part 7 special installations or locations", None, True),
    ("7.02", "Swimming pools and other basins (Section 702)", False),
    ("7.03", "Rooms and cabins containing sauna heaters (Section 703)", False),
    ("7.04", "Construction and demolition site installations. (BS 7375 should also be consulted within this special location. Findings which contravene BS 7375 may need to be reported separately). (Section 704)", False),
    ("7.05", "Agricultural and horticultural premises (Section 705)", False),
    ("7.06", "Conducting locations with restricted movement (Section 706)", False),
    ("7.08", "Electrical installations in caravan / camping parks and similar locations (Section 708)", False),
    ("7.09", "Marinas and similar locations (Section 709)", False),
    ("7.10", "Medical locations (Section 710)", False),
    ("7.11", "Exhibitions, shows and stands. (BS 7909 should also be consulted within this special location. Findings which contravene BS 7909 may need to be reported separately). (Section 711)", False),
    ("7.12", "Solar photovoltaic (PV) power supply systems (Section 712)", False),
    ("7.14", "Outdoor lighting installations (Section 714)", False),
    ("7.15", "Extra-low voltage lighting installations (Section 715)", False),
    ("7.17", "Mobile or transportable units (Section 717)", False),
    ("7.21", "Electrical installations in caravans and motor caravans (Section 721)", False),
    ("7.22", "Electric vehicle charging installations (Section 722)", False),
    ("7.29", "Operating and maintenance gangways (Section 729)", False),
    ("7.30", "Onshore units of electrical connections for inland navigation vessels (Section 730)", False),
    ("7.40", "Temporary electrical installations for structures, amusement devices and booths at fairgrounds, amusement parks and circuses. (BS 7909 should also be consulted within this special location. Findings which contravene BS 7909 may need to be reported separately). (Section 740)", False),
    ("7.53", "Heating cables and embedded heating systems (Section 753)", False),
]


class EICRPDFGenerator:
    """Generate EICR PDF certificates matching the Tradecert format."""

    def __init__(self, output_path: str, data: dict):
        self.output_path = output_path
        self.data = data
        self.styles = getSampleStyleSheet()
        self._setup_styles()
        self.page_width, self.page_height = A4
        self.margin = 15 * mm
        self.content_width = self.page_width - 2 * self.margin

        # Logo paths
        self.logo_path = data.get('logo_path', '/Users/Derek/Desktop/Logo_small (1).jpg')
        self.niceic_logo_path = data.get('niceic_logo_path', '/Users/Derek/Desktop/logo_web (1).png')

        # Signature path
        self.signature_path = data.get('signature_path', None)

        # Company info
        self.company = data.get('company', {
            'name': 'Beckley Electrical Ltd',
            'address': '1 MacArthur Close, Tilehurst, Reading, RG30 4XW',
            'phone': '01184674152',
            'website': 'www.beckleyelectrical.co.uk',
            'enrolment': 'D604458'
        })

        # Inspector info
        self.inspector = data.get('inspector', {
            'name': 'Derek Beckley',
            'position': 'Manager'
        })

        # Certificate number
        self.cert_number = data.get('certificate_number', f"EICR-{datetime.now().strftime('%Y%m%d')}-XXXX")

    def _setup_styles(self):
        """Setup custom paragraph styles with professional typography."""
        # Header style for section bars
        self.styles.add(ParagraphStyle(
            name='RedHeader',
            parent=self.styles['Heading2'],
            textColor=colors.white,
            fontSize=10,
            leading=14,
            spaceBefore=0,
            spaceAfter=0,
            fontName='Helvetica-Bold',
        ))

        # Field label style - used for form labels
        self.styles.add(ParagraphStyle(
            name='FieldLabel',
            parent=self.styles['Normal'],
            fontSize=8,
            textColor=TEXT_SECONDARY,
            leading=10,
        ))

        # Field value style - used for form values
        self.styles.add(ParagraphStyle(
            name='FieldValue',
            parent=self.styles['Normal'],
            fontSize=9,
            fontName='Helvetica-Bold',
            textColor=TEXT_DARK,
            leading=11,
        ))

        # Small text for descriptive content
        self.styles.add(ParagraphStyle(
            name='SmallText',
            parent=self.styles['Normal'],
            fontSize=8,
            leading=11,
            textColor=TEXT_DARK,
        ))

        # Tiny text for fine print and dense information
        self.styles.add(ParagraphStyle(
            name='TinyText',
            parent=self.styles['Normal'],
            fontSize=7,
            leading=9,
            textColor=TEXT_DARK,
        ))

        # Title text for major headers
        self.styles.add(ParagraphStyle(
            name='TitleText',
            parent=self.styles['Heading1'],
            fontSize=16,
            fontName='Helvetica-Bold',
            textColor=HEADER_NAVY,
            spaceAfter=6,
        ))

        # Table cell style
        self.styles.add(ParagraphStyle(
            name='TableCell',
            parent=self.styles['Normal'],
            fontSize=8,
            leading=11,
            textColor=TEXT_DARK,
        ))

    def _create_header_bar(self, text: str) -> Table:
        """Create a Tradecert-style red header bar with white text."""
        data = [[Paragraph(f'<font color="white"><b>{text}</b></font>', self.styles['RedHeader'])]]
        table = Table(data, colWidths=[self.content_width])
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ]))
        return table

    def _get_outcome_cell(self, outcome: str) -> Table:
        """Get a formatted circular outcome badge for inspection schedule."""
        color_map = {
            'tick': GREEN_CHECK, '✓': GREEN_CHECK,
            'C1': RED_C1, 'C2': ORANGE_C2, 'C3': BLUE_C3,
            'FI': PURPLE_FI, 'LIM': colors.HexColor('#6C757D'),
            'NV': colors.HexColor('#ADB5BD'), 'N/A': GRAY_NA
        }

        display_text = '✓' if outcome in ['tick', '✓'] else outcome
        bg_color = color_map.get(outcome, GRAY_NA)

        # Create circular badge using a small table with rounded appearance
        badge_style = ParagraphStyle(
            'badge',
            fontSize=7 if len(display_text) > 2 else 9,
            alignment=TA_CENTER,
            textColor=colors.white,
            fontName='Helvetica-Bold'
        )

        badge_data = [[Paragraph(f'<b>{display_text}</b>', badge_style)]]
        badge_table = Table(badge_data, colWidths=[28], rowHeights=[20])
        badge_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), bg_color),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 2),
            ('RIGHTPADDING', (0, 0), (-1, -1), 2),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('ROUNDEDCORNERS', [10, 10, 10, 10]),
        ]))
        return badge_table

    def _create_code_badge(self, code: str, size: int = 24) -> Table:
        """Create a circular code badge for observations section."""
        color_map = {
            'C1': RED_C1, 'C2': ORANGE_C2, 'C3': BLUE_C3, 'FI': PURPLE_FI
        }
        bg_color = color_map.get(code, GRAY_NA)

        badge_style = ParagraphStyle(
            'code_badge',
            fontSize=10,
            alignment=TA_CENTER,
            textColor=colors.white,
            fontName='Helvetica-Bold'
        )

        badge_data = [[Paragraph(f'<b>{code}</b>', badge_style)]]
        badge_table = Table(badge_data, colWidths=[size], rowHeights=[size])
        badge_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), bg_color),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('ROUNDEDCORNERS', [size//2, size//2, size//2, size//2]),
        ]))
        return badge_table

    def _add_header_footer(self, canvas, doc):
        """Add header with logos and footer with page numbers."""
        from reportlab.lib.utils import ImageReader
        canvas.saveState()

        # Header with logos - positioned at top of each page
        logo_y = self.page_height - 22*mm

        # Company logo (left side)
        logo_drawn = False
        try:
            logo_path = Path(self.logo_path)
            if logo_path.exists():
                # Use ImageReader to handle paths with special characters
                img = ImageReader(str(logo_path))
                canvas.drawImage(img, 15*mm, logo_y,
                               width=55*mm, height=18*mm, preserveAspectRatio=True, mask='auto')
                logo_drawn = True
        except Exception as e:
            pass

        if not logo_drawn:
            # Draw company name if logo fails
            canvas.setFont('Helvetica-Bold', 14)
            canvas.drawString(15*mm, logo_y + 5*mm, self.company['name'])

        # Certificate number in header (right side)
        canvas.setFont('Helvetica-Bold', 9)
        canvas.drawRightString(self.page_width - 15*mm, logo_y + 10*mm, self.cert_number)

        # Company details under certificate number
        canvas.setFont('Helvetica', 7)
        canvas.drawRightString(self.page_width - 15*mm, logo_y + 5*mm, self.company['name'])
        canvas.drawRightString(self.page_width - 15*mm, logo_y, self.company.get('phone', ''))

        # Footer
        canvas.setFont('Helvetica', 7)
        page_num = canvas.getPageNumber()
        canvas.drawString(15*mm, 10*mm,
                         "Report produced by Tradecert based on the model form from BS7671:2018+A3:2024 (18th Edition).")
        canvas.drawRightString(self.page_width - 15*mm, 10*mm, f"Page {page_num}")

        canvas.restoreState()

    def _build_title_header(self) -> list:
        """Build the title section with logos."""
        elements = []
        elements.append(Spacer(1, 15*mm))  # Space for logos

        # Title
        elements.append(Paragraph(
            "<b>ELECTRICAL INSTALLATION CONDITION REPORT</b>",
            self.styles['TitleText']
        ))
        elements.append(Paragraph(
            "Requirements for electrical installations (BS7671:2018+A3:2024 18th edition)",
            self.styles['SmallText']
        ))
        elements.append(Paragraph(f"Certificate number: {self.cert_number}", self.styles['SmallText']))
        elements.append(Spacer(1, 5))

        return elements

    def _build_page1(self) -> list:
        """Build page 1: Client details, installation details, extent, summary."""
        elements = self._build_title_header()

        # Client Details
        elements.append(self._create_header_bar("DETAILS OF CLIENT OR PERSON ORDERING REPORT"))
        client = self.data.get('client', {})
        client_data = [
            [Paragraph('<b>Client:</b>', self.styles['TableCell']),
             Paragraph(client.get('name', ''), self.styles['TableCell']), '', ''],
            [Paragraph('<b>Address:</b>', self.styles['TableCell']),
             Paragraph(client.get('address', ''), self.styles['TableCell']), '', ''],
            [Paragraph('<b>Phone:</b>', self.styles['TableCell']),
             Paragraph(client.get('phone', ''), self.styles['TableCell']),
             Paragraph('<b>Email:</b>', self.styles['TableCell']),
             Paragraph(client.get('email', ''), self.styles['TableCell'])],
        ]
        client_table = Table(client_data, colWidths=[45, 220, 35, 150])
        client_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (0, -1), LIGHT_GRAY),
            ('BACKGROUND', (2, 2), (2, 2), LIGHT_GRAY),
            ('BACKGROUND', (1, 0), (1, -1), LIGHT_BLUE),
            ('BACKGROUND', (3, 2), (3, 2), LIGHT_BLUE),
            ('SPAN', (1, 0), (3, 0)),
            ('SPAN', (1, 1), (3, 1)),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ]))
        elements.append(client_table)
        elements.append(Spacer(1, 8))

        # Reason for Report
        elements.append(self._create_header_bar("REASON FOR PRODUCING THIS REPORT"))
        inspection_date = self.data.get('inspection_date', datetime.now().strftime('%d %b %Y'))
        reason_data = [
            [Paragraph('<b>Reason:</b>', self.styles['TableCell']),
             Paragraph(self.data.get('reason', ''), self.styles['TableCell']),
             Paragraph('<b>Date inspection carried out:</b>', self.styles['TableCell']),
             Paragraph(inspection_date, self.styles['TableCell'])],
        ]
        reason_table = Table(reason_data, colWidths=[45, 200, 110, 95])
        reason_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (0, 0), LIGHT_GRAY),
            ('BACKGROUND', (2, 0), (2, 0), LIGHT_GRAY),
            ('BACKGROUND', (1, 0), (1, 0), LIGHT_BLUE),
            ('BACKGROUND', (3, 0), (3, 0), LIGHT_BLUE),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ]))
        elements.append(reason_table)
        elements.append(Spacer(1, 8))

        # Installation Details
        elements.append(self._create_header_bar("DETAILS OF THE INSTALLATION WHICH IS THE SUBJECT OF THIS REPORT"))
        installation = self.data.get('installation_details', {})
        inst_data = [
            [Paragraph('<b>Occupier name:</b>', self.styles['TableCell']),
             Paragraph(client.get('name', ''), self.styles['TableCell']), '', ''],
            [Paragraph('<b>Installation address:</b>', self.styles['TableCell']),
             Paragraph(installation.get('address', client.get('address', '')), self.styles['TableCell']), '', ''],
            [Paragraph('<b>Description of premises:</b>', self.styles['TableCell']),
             Paragraph(installation.get('description', 'Residential'), self.styles['TableCell']), '', ''],
            [Paragraph('<b>Installation records available:</b>', self.styles['TableCell']),
             Paragraph('Yes' if installation.get('records_available') else 'No', self.styles['TableCell']), '', ''],
            [Paragraph('<b>Date of previous inspection:</b>', self.styles['TableCell']),
             Paragraph(installation.get('previous_date', ''), self.styles['TableCell']),
             Paragraph('<b>Previous certificate number:</b>', self.styles['TableCell']),
             Paragraph(installation.get('previous_cert', ''), self.styles['TableCell'])],
            [Paragraph('<b>Evidence of additions/alterations:</b>', self.styles['TableCell']),
             Paragraph('Yes' if installation.get('additions_alterations') else 'No', self.styles['TableCell']), '', ''],
            [Paragraph('<b>Estimated age of installation:</b>', self.styles['TableCell']),
             Paragraph(f"{installation.get('age', '')} years", self.styles['TableCell']), '', ''],
        ]
        inst_table = Table(inst_data, colWidths=[110, 160, 100, 80])
        inst_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (0, -1), LIGHT_GRAY),
            ('BACKGROUND', (2, 4), (2, 4), LIGHT_GRAY),
            ('BACKGROUND', (1, 0), (-1, -1), LIGHT_BLUE),
            ('SPAN', (1, 0), (3, 0)),
            ('SPAN', (1, 1), (3, 1)),
            ('SPAN', (1, 2), (3, 2)),
            ('SPAN', (1, 3), (3, 3)),
            ('SPAN', (1, 5), (3, 5)),
            ('SPAN', (1, 6), (3, 6)),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ]))
        elements.append(inst_table)
        elements.append(Spacer(1, 8))

        # Extent and Limitations
        elements.append(self._create_header_bar("EXTENT AND LIMITATIONS OF INSPECTION AND TESTING"))
        extent = self.data.get('extent_and_limitations', {})

        # Extent field with box
        elements.append(Paragraph("<b>Extent of the electrical installation covered by this report:</b>",
                                  self.styles['TableCell']))
        extent_box = Table([[Paragraph(extent.get('extent', ''), self.styles['TableCell'])]],
                          colWidths=[self.content_width - 10])
        extent_box.setStyle(TableStyle([
            ('BOX', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (-1, -1), LIGHT_BLUE),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
            ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ]))
        elements.append(extent_box)
        elements.append(Spacer(1, 8))

        # Agreed limitations field with box
        elements.append(Paragraph("<b>Agreed limitations including the reasons:</b>", self.styles['TableCell']))
        limit_box = Table([[Paragraph(extent.get('agreed_limitations', ''), self.styles['TableCell'])]],
                         colWidths=[self.content_width - 10])
        limit_box.setStyle(TableStyle([
            ('BOX', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (-1, -1), LIGHT_BLUE),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
            ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ]))
        elements.append(limit_box)
        elements.append(Spacer(1, 8))

        # Agreed with field
        agreed_data = [[
            Paragraph('<b>Agreed with:</b>', self.styles['TableCell']),
            Paragraph(extent.get('agreed_with', ''), self.styles['TableCell'])
        ]]
        agreed_table = Table(agreed_data, colWidths=[70, self.content_width - 80])
        agreed_table.setStyle(TableStyle([
            ('BOX', (1, 0), (1, 0), 0.75, BORDER_GRAY),
            ('BACKGROUND', (1, 0), (1, 0), LIGHT_BLUE),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]))
        elements.append(agreed_table)
        elements.append(Spacer(1, 5))

        # Operational limitations field with box
        elements.append(Paragraph("<b>Operational limitations including the reasons:</b>", self.styles['TableCell']))
        op_limit_box = Table([[Paragraph(extent.get('operational_limitations', '') or ' ', self.styles['TableCell'])]],
                            colWidths=[self.content_width - 10], rowHeights=[30])
        op_limit_box.setStyle(TableStyle([
            ('BOX', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (-1, -1), LIGHT_BLUE),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
            ('RIGHTPADDING', (0, 0), (-1, -1), 6),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ]))
        elements.append(op_limit_box)
        elements.append(Spacer(1, 5))

        # Disclaimer text
        elements.append(Paragraph(
            "The inspection and testing in this report and accompanying schedules have been carried out in accordance "
            "with BS7671:2018+A3:2024 (18th Edition). It should be noted that cables concealed within trunking and "
            "conduits, under floors, in roof spaces, and generally within the fabric of the building or underground, "
            "have not been inspected unless specifically agreed between the client and inspector prior to the inspection. "
            "An inspection should be made within an accessible roof space housing other electrical equipment.",
            self.styles['TinyText']
        ))
        elements.append(Spacer(1, 8))

        # Summary
        elements.append(self._create_header_bar("SUMMARY OF THE CONDITION OF THE INSTALLATION"))
        observations = self.data.get('observations', [])
        c1_count = sum(1 for o in observations if o.get('code') == 'C1')
        c2_count = sum(1 for o in observations if o.get('code') == 'C2')

        if c1_count > 0 or c2_count > 0:
            assessment = "UNSATISFACTORY"
            assessment_color = RED_C1
        else:
            assessment = "SATISFACTORY"
            assessment_color = GREEN_CHECK

        summary_data = [[
            Paragraph("Overall assessment of the installation in<br/>terms of its suitability for continued use*",
                      self.styles['TableCell']),
            Paragraph(f"<b><font size='16' color='{assessment_color}'>{assessment}</font></b>",
                      ParagraphStyle('assess', alignment=TA_CENTER, fontSize=16)),
            Paragraph("*An unsatisfactory assessment indicates that dangerous (Code C1) and/or potentially "
                      "dangerous (Code C2) conditions have been identified.", self.styles['TinyText'])
        ]]
        summary_table = Table(summary_data, colWidths=[150, 150, 150])
        summary_table.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (0, 0), LIGHT_GRAY),
            ('BACKGROUND', (1, 0), (1, 0), LIGHT_BLUE),
            ('BACKGROUND', (2, 0), (2, 0), LIGHT_GRAY),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
            ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ]))
        elements.append(summary_table)
        elements.append(Spacer(1, 5))

        # Recommendations
        elements.append(self._create_header_bar("RECOMMENDATIONS"))
        elements.append(Paragraph(
            "Where the overall assessment of the suitability of the installation for continued use above is stated "
            "as UNSATISFACTORY, I/we recommend that any observations classified as 'Danger present' (code C1) or "
            "'Potentially dangerous' (code C2) are acted upon as a matter of urgency. Investigation without delay is "
            "recommended for observations identified as 'Further investigation required' (code FI). Observations "
            "classified as 'Improvement recommended' (code C3) should be given due consideration.",
            self.styles['TinyText']
        ))
        elements.append(Spacer(1, 3))
        next_date = self.data.get('next_inspection_date',
                                   (datetime.now().replace(year=datetime.now().year + 5)).strftime('%d %b %Y'))
        elements.append(Paragraph(
            f"<b>Subject to the necessary remedial action being taken, I/we recommend that the installation is "
            f"further inspected and tested by:</b> {next_date}",
            self.styles['TableCell']
        ))

        return elements

    def _build_page2(self) -> list:
        """Build page 2: Observations and recommendations."""
        elements = []
        elements.append(PageBreak())
        elements.append(Spacer(1, 10*mm))

        elements.append(Paragraph("<b>OBSERVATIONS AND RECOMMENDATIONS</b>", self.styles['TitleText']))
        elements.append(Paragraph(
            "One of the following codes, as appropriate, has been allocated to each of the observations made above "
            "to indicate to responsible for the installation the degree of urgency for remedial action.",
            self.styles['TinyText']
        ))
        elements.append(Spacer(1, 5))

        # Code summary boxes
        observations = self.data.get('observations', [])
        c1_count = sum(1 for o in observations if o.get('code') == 'C1')
        c2_count = sum(1 for o in observations if o.get('code') == 'C2')
        c3_count = sum(1 for o in observations if o.get('code') == 'C3')
        fi_count = sum(1 for o in observations if o.get('code') == 'FI')

        # Code summary boxes with circular badges
        code_data = [[
            self._create_code_badge('C1', 28),
            Paragraph(f"<b>{c1_count} item{'s' if c1_count != 1 else ''}</b><br/>"
                     f"<font size='6'>Danger present, risk of injury<br/>(Immediate remedial action required)</font>",
                     self.styles['TableCell']),
            self._create_code_badge('C2', 28),
            Paragraph(f"<b>{c2_count} item{'s' if c2_count != 1 else ''}</b><br/>"
                     f"<font size='6'>Potentially dangerous (Urgent remedial<br/>action required)</font>",
                     self.styles['TableCell']),
            self._create_code_badge('C3', 28),
            Paragraph(f"<b>{c3_count} item{'s' if c3_count != 1 else ''}</b><br/>"
                     f"<font size='6'>Improvement recommended<br/>(Non-urgent remedial action)</font>",
                     self.styles['TableCell']),
            self._create_code_badge('FI', 28),
            Paragraph(f"<b>{fi_count} item{'s' if fi_count != 1 else ''}</b><br/>"
                     f"<font size='6'>Further investigation required without<br/>delay</font>",
                     self.styles['TableCell']),
        ]]
        code_table = Table(code_data, colWidths=[32, 80, 32, 85, 32, 85, 32, 75])
        code_table.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('BOX', (0, 0), (1, 0), 0.5, colors.lightgrey),
            ('BOX', (2, 0), (3, 0), 0.5, colors.lightgrey),
            ('BOX', (4, 0), (5, 0), 0.5, colors.lightgrey),
            ('BOX', (6, 0), (7, 0), 0.5, colors.lightgrey),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ]))
        elements.append(code_table)
        elements.append(Spacer(1, 10))

        # Observations table
        if observations:
            elements.append(Paragraph("✓ <b>The following observations and recommendations have been made:</b>",
                                      self.styles['TableCell']))
            elements.append(Spacer(1, 5))

            obs_header = [
                Paragraph('<font color="white"><b>No.</b></font>', self.styles['TableCell']),
                Paragraph('<font color="white"><b>Schedule</b></font>', self.styles['TableCell']),
                Paragraph('<font color="white"><b>Observation</b></font>', self.styles['TableCell']),
                Paragraph('<font color="white"><b>Code</b></font>', self.styles['TableCell']),
            ]

            obs_data = [obs_header]
            job_path = self.data.get('job_path', '')
            for i, obs in enumerate(observations, 1):
                code = obs.get('code', 'FI')
                # Get regulation references
                regs = obs.get('regs', [])
                regs_text = ', '.join(regs) if regs else ''
                # Get schedule item
                schedule_item = obs.get('schedule_item', '')
                # Build observation text with regulation reference
                obs_text = f"<b>{obs.get('title', '')}</b><br/>{obs.get('text', '')}"
                if regs_text:
                    obs_text += f"<br/><i>Regulation: {regs_text}</i>"

                # Build observation cell with inline photo if present
                obs_cell_elements = [Paragraph(obs_text, self.styles['TableCell'])]

                # Add photo inline if present and not already shown
                if obs.get('photo') and job_path:
                    photo_rel_path = obs['photo']
                    photo_full_path = Path(job_path) / photo_rel_path

                    # Track which photos we've already shown
                    if not hasattr(self, '_shown_photos'):
                        self._shown_photos = set()

                    if photo_rel_path not in self._shown_photos and photo_full_path.exists():
                        try:
                            # Show photo inline - moderate size
                            obs_photo = Image(str(photo_full_path), width=70*mm, height=50*mm)
                            obs_cell_elements.append(Spacer(1, 3))
                            obs_cell_elements.append(obs_photo)
                            self._shown_photos.add(photo_rel_path)
                        except Exception:
                            pass
                    elif photo_rel_path in self._shown_photos:
                        # Photo already shown above
                        obs_cell_elements.append(Paragraph("<i>(See photo above)</i>", self.styles['TinyText']))

                obs_cell = obs_cell_elements if len(obs_cell_elements) == 1 else obs_cell_elements

                obs_data.append([
                    Paragraph(str(i), self.styles['TableCell']),
                    Paragraph(schedule_item, self.styles['TableCell']),
                    obs_cell,
                    self._get_outcome_cell(code)
                ])

            obs_table = Table(obs_data, colWidths=[25, 45, 340, 40])
            obs_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), RED_HEADER),
                ('ALIGN', (0, 0), (0, -1), 'CENTER'),
                ('ALIGN', (1, 0), (1, -1), 'CENTER'),
                ('ALIGN', (3, 0), (3, -1), 'CENTER'),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
                ('TOPPADDING', (0, 0), (-1, -1), 4),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
                ('LEFTPADDING', (0, 0), (-1, -1), 3),
                ('RIGHTPADDING', (0, 0), (-1, -1), 3),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [LIGHT_BLUE, LIGHT_CREAM]),
            ]))
            elements.append(obs_table)
        else:
            elements.append(Paragraph("No observations recorded.", self.styles['TableCell']))

        return elements

    def _build_page3(self) -> list:
        """Build page 3: Declaration, Supply characteristics, Particulars."""
        elements = []
        elements.append(PageBreak())
        elements.append(Spacer(1, 10*mm))

        # General Condition
        elements.append(self._create_header_bar("GENERAL CONDITION OF THE INSTALLATION"))
        elements.append(Paragraph("<b>General Condition of the Installation:</b>", self.styles['TableCell']))
        elements.append(Paragraph(self.data.get('general_condition', ''), self.styles['TableCell']))
        elements.append(Spacer(1, 5))

        # Declaration
        elements.append(self._create_header_bar("DECLARATION"))
        elements.append(Paragraph(
            "I/We, being the person(s) responsible for the inspection and testing of the electrical installation "
            "(as indicated by my/our signatures below), particulars of which are described above, having exercised "
            "reasonable skill and care when carrying out the inspection and testing, hereby declare that the "
            "information in this report, including the observations and the attached schedules, provides an accurate "
            "assessment of the condition of the electrical installation taking into account the stated extent and "
            "limitations in this report.",
            self.styles['TinyText']
        ))
        elements.append(Spacer(1, 3))

        # Company details table
        company_data = [
            [Paragraph('<b>Trading title:</b>', self.styles['TableCell']),
             Paragraph(self.company['name'], self.styles['TableCell']),
             Paragraph('<b>Enrolment number:</b>', self.styles['TableCell']),
             Paragraph(self.company['enrolment'], self.styles['TableCell'])],
            [Paragraph('<b>Address:</b>', self.styles['TableCell']),
             Paragraph(self.company['address'], self.styles['TableCell']), '', ''],
            [Paragraph('<b>Website:</b>', self.styles['TableCell']),
             Paragraph(self.company['website'], self.styles['TableCell']),
             Paragraph('<b>Phone:</b>', self.styles['TableCell']),
             Paragraph(self.company['phone'], self.styles['TableCell'])],
        ]
        company_table = Table(company_data, colWidths=[60, 200, 70, 120])
        company_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (0, -1), LIGHT_GRAY),
            ('BACKGROUND', (2, 0), (2, 0), LIGHT_GRAY),
            ('BACKGROUND', (2, 2), (2, 2), LIGHT_GRAY),
            ('BACKGROUND', (1, 0), (1, -1), LIGHT_BLUE),
            ('BACKGROUND', (3, 0), (3, 0), LIGHT_BLUE),
            ('BACKGROUND', (3, 2), (3, 2), LIGHT_BLUE),
            ('SPAN', (1, 1), (3, 1)),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ]))
        elements.append(company_table)
        elements.append(Spacer(1, 3))

        # Signature section
        inspection_date = self.data.get('inspection_date', datetime.now().strftime('%d %b %Y'))

        # Try to load signature image
        sig_img = ""
        if self.signature_path and Path(self.signature_path).exists():
            try:
                sig_img = Image(self.signature_path, width=30*mm, height=10*mm)
            except:
                sig_img = ""

        sig_data = [
            [Paragraph('<b>Inspected and Tested by</b>', self.styles['TableCell']), '', '', '', ''],
            [Paragraph('<b>Name:</b>', self.styles['TableCell']),
             Paragraph(self.inspector['name'], self.styles['TableCell']),
             Paragraph('<b>Position:</b>', self.styles['TableCell']),
             Paragraph(self.inspector['position'], self.styles['TableCell']), ''],
            [Paragraph('<b>Signature:</b>', self.styles['TableCell']),
             sig_img if sig_img else '',
             Paragraph('<b>Date:</b>', self.styles['TableCell']),
             Paragraph(inspection_date, self.styles['TableCell']), ''],
            [Paragraph('<b>Report authorised by</b>', self.styles['TableCell']), '', '', '', ''],
            [Paragraph('<b>Name:</b>', self.styles['TableCell']),
             Paragraph(self.inspector['name'], self.styles['TableCell']),
             Paragraph('<b>Position:</b>', self.styles['TableCell']),
             Paragraph(self.inspector['position'], self.styles['TableCell']), ''],
            [Paragraph('<b>Signature:</b>', self.styles['TableCell']),
             sig_img if sig_img else '',
             Paragraph('<b>Date:</b>', self.styles['TableCell']),
             Paragraph(inspection_date, self.styles['TableCell']), ''],
        ]
        sig_table = Table(sig_data, colWidths=[60, 120, 55, 80, 80])
        sig_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('GRID', (0, 1), (-1, 2), 0.5, BORDER_GRAY),
            ('GRID', (0, 4), (-1, 5), 0.5, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (-1, 0), LIGHT_GRAY),
            ('BACKGROUND', (0, 3), (-1, 3), LIGHT_GRAY),
            ('SPAN', (0, 0), (-1, 0)),
            ('SPAN', (0, 3), (-1, 3)),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
            ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ]))
        elements.append(sig_table)
        elements.append(Spacer(1, 5))

        # Supply Characteristics
        elements.append(self._create_header_bar("SUPPLY CHARACTERISTICS AND EARTHING ARRANGEMENTS"))
        supply = self.data.get('supply_characteristics', {})

        supply_row1 = [[
            Paragraph('<b>Earthing arrangement:</b>', self.styles['TableCell']),
            Paragraph(supply.get('earthing_arrangement', ''), self.styles['TableCell']),
            Paragraph('<b>Number and type of live conductors:</b>', self.styles['TableCell']),
            Paragraph(supply.get('live_conductors', ''), self.styles['TableCell']),
        ]]
        supply_table1 = Table(supply_row1, colWidths=[85, 80, 130, 155])
        supply_table1.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (0, 0), LIGHT_GRAY),
            ('BACKGROUND', (2, 0), (2, 0), LIGHT_GRAY),
            ('BACKGROUND', (1, 0), (1, 0), LIGHT_BLUE),
            ('BACKGROUND', (3, 0), (3, 0), LIGHT_BLUE),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(supply_table1)

        elements.append(Paragraph("<b>Nature of Supply Parameters</b>", self.styles['TableCell']))
        polarity_tick = "✓" if supply.get('supply_polarity_confirmed') else ""
        params_data = [[
            Paragraph(f"Nominal voltage (U): <b>{supply.get('nominal_voltage_u', '')}</b> V", self.styles['TinyText']),
            Paragraph(f"Uo: <b>{supply.get('nominal_voltage_uo', '')}</b> V", self.styles['TinyText']),
            Paragraph(f"Nominal frequency: <b>{supply.get('nominal_frequency', '')}</b> Hz", self.styles['TinyText']),
            Paragraph(f"Supply polarity confirmed: <b>{polarity_tick}</b>", self.styles['TinyText']),
        ], [
            Paragraph(f"Prospective fault current: <b>{supply.get('prospective_fault_current', '')}</b> kA", self.styles['TinyText']),
            Paragraph(f"Earth loop impedance (Ze): <b>{supply.get('earth_loop_impedance_ze', '')}</b> ohm", self.styles['TinyText']),
            Paragraph(f"Number of supplies: <b>{supply.get('number_of_supplies', '')}</b>", self.styles['TinyText']),
            '',
        ]]
        params_table = Table(params_data, colWidths=[115, 105, 120, 110])
        params_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 7),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (-1, -1), LIGHT_BLUE),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(params_table)

        spd = supply.get('supply_protective_device', {})
        elements.append(Paragraph("<b>Supply Protective Device</b>", self.styles['TableCell']))
        spd_data = [[
            Paragraph(f"BS (EN): <b>{spd.get('bs_en', '')}</b>", self.styles['TinyText']),
            Paragraph(f"Type: <b>{spd.get('type', '')}</b>", self.styles['TinyText']),
            Paragraph(f"Short circuit capacity: <b>{spd.get('short_circuit_capacity', '')}</b> kA", self.styles['TinyText']),
            Paragraph(f"Rated current: <b>{spd.get('rated_current', '')}</b> A", self.styles['TinyText']),
        ]]
        spd_table = Table(spd_data, colWidths=[100, 100, 150, 100])
        spd_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 7),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (-1, -1), LIGHT_BLUE),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(spd_table)
        elements.append(Spacer(1, 5))

        # Particulars of Installation
        elements.append(self._create_header_bar("PARTICULARS OF INSTALLATION REFERRED TO IN THE REPORT"))
        particulars = self.data.get('particulars_of_installation', {})
        means = particulars.get('means_of_earthing', {})

        distributor_tick = "✓" if means.get('distributor_facility') else ""
        electrode_tick = "✓" if means.get('earth_electrode') else ""

        means_data = [[
            Paragraph('<b>Means of earthing</b>', self.styles['TableCell']),
            Paragraph(f"{distributor_tick} Distributors facility", self.styles['TinyText']),
            Paragraph(f"{electrode_tick} Earth electrode", self.styles['TinyText']),
            Paragraph('<b>Details of installation earth electrode (where applicable)</b>', self.styles['TableCell']),
        ]]
        means_table = Table(means_data, colWidths=[80, 100, 80, 190])
        means_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 7),
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('BACKGROUND', (0, 0), (0, 0), LIGHT_GRAY),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(means_table)

        ee = particulars.get('earth_electrode', {})
        ee_data = [[
            Paragraph(f"Type: <b>{ee.get('type', 'N/A')}</b>", self.styles['TinyText']),
            Paragraph(f"Resistance to earth: <b>{ee.get('resistance_to_earth', 'N/A')}</b> ohm", self.styles['TinyText']),
            Paragraph(f"Location: <b>{ee.get('location', 'N/A')}</b>", self.styles['TinyText']),
        ]]
        ee_table = Table(ee_data, colWidths=[150, 150, 150])
        ee_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 7),
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(ee_table)

        ms = particulars.get('main_switch', {})
        elements.append(Paragraph("<b>Main switch / switch fuse / circuit breaker / RCD</b>", self.styles['TableCell']))
        ms_data = [[
            Paragraph(f"Type BS(EN): <b>{ms.get('type_bs_en', '')}</b>", self.styles['TinyText']),
            Paragraph(f"Number of poles: <b>{ms.get('number_of_poles', '')}</b>", self.styles['TinyText']),
            Paragraph(f"Voltage rating: <b>{ms.get('voltage_rating', '')}</b> V", self.styles['TinyText']),
            Paragraph(f"Rated current: <b>{ms.get('rated_current', '')}</b> A", self.styles['TinyText']),
        ], [
            Paragraph(f"Fuse device setting: <b>{ms.get('fuse_device_setting', 'N/A')}</b> A", self.styles['TinyText']),
            Paragraph(f"Conductor material: <b>{ms.get('conductor_material', '')}</b>", self.styles['TinyText']),
            Paragraph(f"Conductor CSA: <b>{ms.get('conductor_csa', '')}</b> mm²", self.styles['TinyText']),
            '',
        ]]
        ms_table = Table(ms_data, colWidths=[115, 115, 110, 110])
        ms_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 7),
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(ms_table)

        # Earthing and bonding conductors
        ec = particulars.get('earthing_conductor', {})
        mpb = particulars.get('main_protective_bonding', {})
        ec_tick = "✓" if ec.get('continuity') else ""
        mpb_tick = "✓" if mpb.get('continuity') else ""

        bond_data = [
            [Paragraph('<b>Earthing conductor</b>', self.styles['TinyText']),
             Paragraph(f"Conductor material: <b>{ec.get('conductor_material', '')}</b>", self.styles['TinyText']),
             Paragraph(f"Conductor CSA: <b>{ec.get('conductor_csa', '')}</b> mm²", self.styles['TinyText']),
             Paragraph(f"Continuity: <b>{ec_tick}</b>", self.styles['TinyText'])],
            [Paragraph('<b>Main protective bonding</b>', self.styles['TinyText']),
             Paragraph(f"Conductor material: <b>{mpb.get('conductor_material', '')}</b>", self.styles['TinyText']),
             Paragraph(f"Conductor CSA: <b>{mpb.get('conductor_csa', '')}</b> mm²", self.styles['TinyText']),
             Paragraph(f"Continuity: <b>{mpb_tick}</b>", self.styles['TinyText'])],
        ]
        bond_table = Table(bond_data, colWidths=[110, 130, 100, 110])
        bond_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 7),
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (0, -1), LIGHT_GRAY),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(bond_table)

        # Bonding of extraneous parts
        bonding = particulars.get('bonding_of_extraneous_parts', {})
        elements.append(Paragraph("<b>Bonding of extraneous conductive parts</b>", self.styles['TableCell']))
        water_tick = "✓" if bonding.get('water') else ""
        gas_tick = "✓" if bonding.get('gas') else ""
        oil_tick = "✓" if bonding.get('oil') else ""
        steel_tick = "✓" if bonding.get('steel') else ""
        lightning_tick = "✓" if bonding.get('lightning') else ""

        bonding_data = [[
            Paragraph(f"Water: <b>{water_tick}</b>", self.styles['TinyText']),
            Paragraph(f"Gas: <b>{gas_tick}</b>", self.styles['TinyText']),
            Paragraph(f"Oil: <b>{oil_tick}</b>", self.styles['TinyText']),
            Paragraph(f"Steel: <b>{steel_tick}</b>", self.styles['TinyText']),
            Paragraph(f"Lightning: <b>{lightning_tick}</b>", self.styles['TinyText']),
        ]]
        bonding_table = Table(bonding_data, colWidths=[90, 90, 90, 90, 90])
        bonding_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 7),
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(bonding_table)
        elements.append(Paragraph(f"<b>Other:</b> {bonding.get('other', 'N/A')}", self.styles['TinyText']))

        return elements

    def _build_inspection_schedule(self) -> list:
        """Build inspection schedule pages with all items from sections 1-7."""
        elements = []
        elements.append(PageBreak())
        elements.append(Spacer(1, 10*mm))

        elements.append(Paragraph("<b>SCHEDULE OF INSPECTIONS</b>", self.styles['TitleText']))
        elements.append(Paragraph(
            "Methods of protection against electric shock - Loss of supply, etc.",
            self.styles['SmallText']
        ))
        elements.append(Spacer(1, 3))

        # Legend
        legend_data = [[
            Paragraph('<b>✓</b>', ParagraphStyle('tick', fontSize=10, alignment=TA_CENTER, textColor=GREEN_CHECK)),
            Paragraph('Acceptable', self.styles['TinyText']),
            Paragraph('<b>C1</b>', ParagraphStyle('c1', fontSize=8, alignment=TA_CENTER, textColor=colors.red)),
            Paragraph('<b>C2</b>', ParagraphStyle('c2', fontSize=8, alignment=TA_CENTER, textColor=ORANGE_C2)),
            Paragraph('Unacceptable', self.styles['TinyText']),
            Paragraph('<b>C3</b>', ParagraphStyle('c3', fontSize=8, alignment=TA_CENTER, textColor=BLUE_C3)),
            Paragraph('Improvement', self.styles['TinyText']),
            Paragraph('<b>LIM</b>', ParagraphStyle('lim', fontSize=8, alignment=TA_CENTER, textColor=GRAY_NA)),
            Paragraph('Limitation', self.styles['TinyText']),
            Paragraph('<b>N/A</b>', ParagraphStyle('na', fontSize=8, alignment=TA_CENTER, textColor=GRAY_NA)),
            Paragraph('Not applicable', self.styles['TinyText']),
        ]]
        legend_table = Table(legend_data, colWidths=[20, 45, 20, 20, 50, 20, 50, 20, 45, 20, 50])
        legend_table.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('FONTSIZE', (0, 0), (-1, -1), 6),
        ]))
        elements.append(legend_table)
        elements.append(Spacer(1, 5))

        # Build observation mapping - link observations to schedule items
        observation_map = {}
        for obs in self.data.get('observations', []):
            schedule_item = obs.get('schedule_item')
            if schedule_item:
                observation_map[schedule_item] = obs.get('code', 'FI')

        # Get inspection items from data (manual overrides)
        schedule = self.data.get('inspection_schedule', {})
        items = schedule.get('items', {})
        default_code = schedule.get('default_code', 'tick')

        # Build table rows - one row per item
        table_data = []

        # Header row
        header = [
            Paragraph('<font color="white"><b>Item</b></font>', self.styles['TableCell']),
            Paragraph('<font color="white"><b>Description</b></font>', self.styles['TableCell']),
            Paragraph('<font color="white"><b>Outcome</b></font>', self.styles['TableCell']),
        ]
        table_data.append(header)

        section_header_rows = []  # Track which rows are section headers

        for idx, (item_no, description, is_section_header) in enumerate(INSPECTION_SCHEDULE_ITEMS):
            row_idx = idx + 1  # +1 for header row

            if is_section_header:
                # Section header row - spans all columns
                section_header_rows.append(row_idx)
                table_data.append([
                    Paragraph(f'<b>{item_no}</b>', self.styles['TableCell']),
                    '',
                    ''
                ])
            else:
                # Regular item row
                # Priority: 1) observation linked to this item, 2) manual override, 3) default
                if item_no in observation_map:
                    outcome = observation_map[item_no]
                elif item_no in items:
                    outcome = items[item_no]
                else:
                    outcome = default_code

                table_data.append([
                    Paragraph(f'<b>{item_no}</b>', self.styles['TinyText']),
                    Paragraph(description, self.styles['TinyText']),
                    self._get_outcome_cell(outcome)
                ])

        # Create table with proper column widths
        insp_table = Table(table_data, colWidths=[40, 365, 45])

        # Build style
        style_commands = [
            ('BACKGROUND', (0, 0), (-1, 0), RED_HEADER),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('ALIGN', (0, 0), (0, -1), 'CENTER'),
            ('ALIGN', (2, 0), (2, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('FONTSIZE', (0, 0), (-1, -1), 7),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('LEFTPADDING', (0, 0), (-1, -1), 3),
            ('RIGHTPADDING', (0, 0), (-1, -1), 3),
        ]

        # Add section header styling (gray background, span columns)
        for row_idx in section_header_rows:
            style_commands.append(('BACKGROUND', (0, row_idx), (-1, row_idx), LIGHT_GRAY))
            style_commands.append(('SPAN', (0, row_idx), (-1, row_idx)))

        insp_table.setStyle(TableStyle(style_commands))
        elements.append(insp_table)

        # Signature at end of inspection schedule
        elements.append(Spacer(1, 10))
        inspection_date = self.data.get('inspection_date', datetime.now().strftime('%d %b %Y'))
        sig_text = f"<b>Inspected by:</b> {self.inspector['name']}  <b>Position:</b> {self.inspector['position']}  <b>Date:</b> {inspection_date}"
        elements.append(Paragraph(sig_text, self.styles['TableCell']))

        return elements

    def _build_circuit_schedule(self) -> list:
        """Build distribution board and circuit schedule page."""
        elements = []
        elements.append(PageBreak())
        elements.append(Spacer(1, 10*mm))

        board = self.data.get('distribution_board', {})
        elements.append(Paragraph(f"<b>Distribution Board - {board.get('name', 'DB-1')}</b>", self.styles['TitleText']))

        elements.append(self._create_header_bar(f"{board.get('name', 'DB-1')} - Board Details"))

        polarity_tick = "✓" if board.get('polarity_confirmed', True) else ""
        board_data = [
            [Paragraph('<b>Location:</b>', self.styles['TinyText']),
             Paragraph(board.get('location', ''), self.styles['TinyText']),
             Paragraph('<b>Manufacturer:</b>', self.styles['TinyText']),
             Paragraph(board.get('manufacturer', ''), self.styles['TinyText']),
             Paragraph('<b>Supplied from:</b>', self.styles['TinyText']),
             Paragraph(board.get('supplied_from', ''), self.styles['TinyText']),
             Paragraph(f'<b>Polarity confirmed:</b> {polarity_tick}', self.styles['TinyText']),
             Paragraph(f"<b>Phases:</b> {board.get('phases', '1')}", self.styles['TinyText'])],
        ]
        board_table = Table(board_data, colWidths=[45, 60, 55, 75, 55, 55, 70, 45])
        board_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 6),
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('BACKGROUND', (0, 0), (-1, -1), colors.white),
        ]))
        elements.append(board_table)

        # Circuit schedule - Full columns
        circuits = self.data.get('circuits', [])
        elements.append(Spacer(1, 5))

        # Circuit details section header
        elements.append(self._create_header_bar("Schedule of Circuit Details and Test Results"))

        # Row 1: Circuit reference and cable details
        circuit_header_row1 = [
            Paragraph('<font color="white" size="4">Cct<br/>ref</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Circuit designation</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Wiring<br/>type</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Ref<br/>method</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">No. of<br/>points</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Live<br/>CSA<br/>mm²</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">CPC<br/>CSA<br/>mm²</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Max<br/>disc<br/>time</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">OCPD<br/>BS(EN)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">OCPD<br/>Type</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">OCPD<br/>Rating<br/>(A)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Max<br/>Zs<br/>(Ω)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">RCD<br/>BS(EN)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">RCD<br/>Type</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">RCD<br/>IΔn<br/>(mA)</font>', self.styles['TinyText']),
        ]

        circuit_data_row1 = [circuit_header_row1]
        for circuit in circuits:
            circuit_data_row1.append([
                Paragraph(str(circuit.get('circuit_ref', '')), self.styles['TinyText']),
                Paragraph(circuit.get('circuit_designation', ''), self.styles['TinyText']),
                Paragraph(circuit.get('wiring_type', ''), self.styles['TinyText']),
                Paragraph(circuit.get('reference_method', ''), self.styles['TinyText']),
                Paragraph(str(circuit.get('number_of_points', '')), self.styles['TinyText']),
                Paragraph(circuit.get('live_csa', ''), self.styles['TinyText']),
                Paragraph(circuit.get('cpc_csa', ''), self.styles['TinyText']),
                Paragraph(circuit.get('max_disconnection_time', ''), self.styles['TinyText']),
                Paragraph(circuit.get('ocpd_bs_en', ''), self.styles['TinyText']),
                Paragraph(circuit.get('ocpd_type', ''), self.styles['TinyText']),
                Paragraph(circuit.get('ocpd_rating_a', ''), self.styles['TinyText']),
                Paragraph(circuit.get('max_zs', ''), self.styles['TinyText']),
                Paragraph(circuit.get('rcd_bs_en', ''), self.styles['TinyText']),
                Paragraph(circuit.get('rcd_type', ''), self.styles['TinyText']),
                Paragraph(circuit.get('rcd_operating_current_ma', ''), self.styles['TinyText']),
            ])

        # Add empty rows if no circuits
        if not circuits:
            for _ in range(10):
                circuit_data_row1.append([''] * 15)

        # Widened designation (col 1) from 70→85pt; reclaimed from: col 2 (25→22), col 8 (28→24), col 11 (24→20), col 12 (28→24)
        circuit_table1 = Table(circuit_data_row1, colWidths=[18, 85, 22, 22, 20, 20, 20, 22, 24, 22, 24, 20, 24, 22, 22])
        circuit_table1.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), RED_HEADER),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('ALIGN', (1, 0), (1, -1), 'LEFT'),
            ('FONTSIZE', (0, 0), (-1, -1), 5),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [LIGHT_BLUE, LIGHT_CREAM]),
        ]))
        elements.append(circuit_table1)
        elements.append(Spacer(1, 5))

        # Row 2: Test results
        elements.append(self._create_header_bar("Test Results"))

        circuit_header_row2 = [
            Paragraph('<font color="white" size="4">Cct<br/>ref</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">r1<br/>(Ω)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">rn<br/>(Ω)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">r2<br/>(Ω)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">R1+R2<br/>(Ω)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">R2<br/>(Ω)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Ring<br/>cont.</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">IR<br/>L-N<br/>(MΩ)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">IR<br/>L-E<br/>(MΩ)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">IR<br/>N-E<br/>(MΩ)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Polarity<br/>✓</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Max Zs<br/>(Ω)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Meas Zs<br/>(Ω)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">RCD<br/>time<br/>(ms)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">RCD<br/>test<br/>btn</font>', self.styles['TinyText']),
        ]

        circuit_data_row2 = [circuit_header_row2]
        for circuit in circuits:
            polarity = "✓" if circuit.get('polarity_confirmed', True) else ""
            rcd_btn = "✓" if circuit.get('rcd_test_button', True) else ""
            ring_cont = "✓" if circuit.get('ring_continuity', False) else ""
            circuit_data_row2.append([
                Paragraph(str(circuit.get('circuit_ref', '')), self.styles['TinyText']),
                Paragraph(circuit.get('r1_ohm', ''), self.styles['TinyText']),
                Paragraph(circuit.get('rn_ohm', ''), self.styles['TinyText']),
                Paragraph(circuit.get('r2_ohm', ''), self.styles['TinyText']),
                Paragraph(circuit.get('r1_r2_ohm', ''), self.styles['TinyText']),
                Paragraph(circuit.get('R2_ohm', ''), self.styles['TinyText']),
                Paragraph(ring_cont, self.styles['TinyText']),
                Paragraph(circuit.get('ir_live_neutral_mohm', ''), self.styles['TinyText']),
                Paragraph(circuit.get('ir_live_earth_mohm', ''), self.styles['TinyText']),
                Paragraph(circuit.get('ir_neutral_earth_mohm', ''), self.styles['TinyText']),
                Paragraph(polarity, self.styles['TinyText']),
                Paragraph(circuit.get('max_zs', ''), self.styles['TinyText']),
                Paragraph(circuit.get('measured_zs_ohm', ''), self.styles['TinyText']),
                Paragraph(circuit.get('rcd_time_ms', ''), self.styles['TinyText']),
                Paragraph(rcd_btn, self.styles['TinyText']),
            ])

        # Add empty rows if no circuits
        if not circuits:
            for _ in range(10):
                circuit_data_row2.append([''] * 15)

        circuit_table2 = Table(circuit_data_row2, colWidths=[18, 28, 28, 28, 32, 28, 28, 30, 30, 30, 32, 32, 32, 32, 28])
        circuit_table2.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), RED_HEADER),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('FONTSIZE', (0, 0), (-1, -1), 5),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [LIGHT_BLUE, LIGHT_CREAM]),
        ]))
        elements.append(circuit_table2)

        # Testing information
        elements.append(Spacer(1, 10))
        elements.append(self._create_header_bar(f"{board.get('name', 'DB-1')} - Testing information"))
        inspection_date = self.data.get('inspection_date', datetime.now().strftime('%d %b %Y'))
        elements.append(Paragraph(
            f"<b>Tested by</b>  Name: {self.inspector['name']}  Position: {self.inspector['position']}  "
            f"Date tested: {inspection_date}",
            self.styles['TableCell']
        ))

        return elements

    def _build_circuit_schedule_landscape(self) -> list:
        """Build circuit schedule for landscape page - matching Tradecert format exactly."""
        elements = []
        elements.append(Spacer(1, 3*mm))

        board = self.data.get('distribution_board', {})

        # Title
        elements.append(Paragraph(f"<b>Distribution Board - {board.get('name', 'DB-1')}</b>", self.styles['TitleText']))
        elements.append(Spacer(1, 2))

        # DB-1 - Board Details header
        elements.append(self._create_header_bar(f"{board.get('name', 'DB-1')} - Board Details"))

        # Board details row 1
        polarity_tick = "✓" if board.get('polarity_confirmed', True) else ""
        board_row1 = [
            [Paragraph('<b>Location:</b>', self.styles['TinyText']),
             Paragraph(board.get('location', ''), self.styles['TinyText']),
             Paragraph('<b>Manufacturer:</b>', self.styles['TinyText']),
             Paragraph(board.get('manufacturer', ''), self.styles['TinyText']),
             Paragraph('<b>Supplied from:</b>', self.styles['TinyText']),
             Paragraph(board.get('supplied_from', ''), self.styles['TinyText']),
             Paragraph(f'<b>Polarity confirmed:</b> {polarity_tick}', self.styles['TinyText']),
             Paragraph(f"<b>Phases:</b> {board.get('phases', '1')}", self.styles['TinyText']),
             Paragraph(f"<b>Phases confirmed:</b> N/A", self.styles['TinyText'])],
        ]
        # Full width = 287mm = ~813 points, distributed across 9 columns
        board_table1 = Table(board_row1, colWidths=[45, 80, 55, 85, 55, 70, 85, 55, 85])
        board_table1.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 6),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            ('BACKGROUND', (0, 0), (-1, -1), LIGHT_BLUE),
        ]))
        elements.append(board_table1)

        # Board details row 2
        board_row2 = [
            [Paragraph('<b>Zs at DB:</b>', self.styles['TinyText']),
             Paragraph(f"{board.get('zs_at_db', '')} ohm", self.styles['TinyText']),
             Paragraph('<b>IPF at DB:</b>', self.styles['TinyText']),
             Paragraph(f"{board.get('ipf_at_db', '')} kA", self.styles['TinyText']),
             Paragraph('<b>RCD trip time:</b>', self.styles['TinyText']),
             Paragraph(f"{board.get('rcd_trip_time', '')} ms", self.styles['TinyText']),
             Paragraph('<b>Main Switch BS (EN):</b>', self.styles['TinyText']),
             Paragraph(board.get('main_switch_bs_en', ''), self.styles['TinyText']),
             Paragraph('<b>Voltage rating:</b>', self.styles['TinyText']),
             Paragraph(f"{board.get('voltage_rating', '')} V", self.styles['TinyText']),
             Paragraph('<b>Rated current:</b>', self.styles['TinyText']),
             Paragraph(f"{board.get('rated_current', '')} A", self.styles['TinyText']),
             Paragraph('<b>IPF rating:</b>', self.styles['TinyText']),
             Paragraph(f"{board.get('ipf_rating', '')} kA", self.styles['TinyText']),
             Paragraph('<b>RCD rating:</b>', self.styles['TinyText']),
             Paragraph(f"{board.get('rcd_rating', '')} mA", self.styles['TinyText'])],
        ]
        # Full width distributed across 16 columns
        board_table2 = Table(board_row2, colWidths=[45, 45, 45, 40, 50, 40, 70, 50, 55, 35, 55, 35, 50, 35, 50, 35])
        board_table2.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 5),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            ('BACKGROUND', (0, 0), (-1, -1), LIGHT_BLUE),
        ]))
        elements.append(board_table2)

        # SPD Details row
        spd_row = [
            [Paragraph('<b>SPD Details</b> Type:', self.styles['TinyText']),
             Paragraph(board.get('spd_type', ''), self.styles['TinyText']),
             Paragraph('<b>Status:</b>', self.styles['TinyText']),
             Paragraph(board.get('spd_status', ''), self.styles['TinyText']),
             Paragraph('<b>Overcurrent Device</b> BS (EN):', self.styles['TinyText']),
             Paragraph(board.get('spd_ocpd_bs_en', ''), self.styles['TinyText']),
             Paragraph('<b>Voltage:</b>', self.styles['TinyText']),
             Paragraph(f"{board.get('spd_voltage', '')} V", self.styles['TinyText']),
             Paragraph('<b>Current:</b>', self.styles['TinyText']),
             Paragraph(f"{board.get('spd_current', '')} A", self.styles['TinyText'])],
        ]
        # Full width distributed across 10 columns
        spd_table = Table(spd_row, colWidths=[70, 70, 50, 70, 110, 80, 60, 60, 60, 55])
        spd_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 5),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('BACKGROUND', (0, 0), (-1, -1), LIGHT_BLUE),
            ('BACKGROUND', (0, 0), (0, 0), LIGHT_GRAY),
            ('BACKGROUND', (4, 0), (4, 0), LIGHT_GRAY),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ]))
        elements.append(spd_table)

        # Notes row
        notes_row = [[Paragraph('<b>Notes:</b>', self.styles['TinyText']),
                      Paragraph(board.get('notes', ''), self.styles['TinyText'])]]
        # Full width for notes
        notes_table = Table(notes_row, colWidths=[50, 735])
        notes_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 5),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('BACKGROUND', (0, 0), (0, 0), LIGHT_GRAY),
            ('BACKGROUND', (1, 0), (1, 0), LIGHT_BLUE),
        ]))
        elements.append(notes_table)
        elements.append(Spacer(1, 2))

        circuits = self.data.get('circuits', [])

        # Category header row (row 0) - spans multiple columns
        # Columns: 0=Cct, 1=Designation, 2-7=CONDUCTORS(6cols), 8-12=OVERCURRENT(5cols),
        # 13-16=RCD(4cols), 17-19=RING(3cols), 20-21=R1+R2(2cols), 22-24=IR(3cols),
        # 25=Pol, 26=Zs, 27-28=RCD(2cols), 29=AFDD
        cat_header = [
            Paragraph('<font color="white" size="4"><b>Cct</b></font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4"><b>Designation</b></font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4"><b>CONDUCTORS</b></font>', self.styles['TinyText']),
            '', '', '', '', '',  # spans cols 2-7
            Paragraph('<font color="white" size="4"><b>OVERCURRENT DEVICES</b></font>', self.styles['TinyText']),
            '', '', '', '',  # spans cols 8-12
            Paragraph('<font color="white" size="4"><b>RCD</b></font>', self.styles['TinyText']),
            '', '', '',  # spans cols 13-16
            Paragraph('<font color="white" size="4"><b>RING FINAL</b></font>', self.styles['TinyText']),
            '', '',  # spans cols 17-19
            Paragraph('<font color="white" size="4"><b>R1+R2 / R2</b></font>', self.styles['TinyText']),
            '',  # spans cols 20-21
            Paragraph('<font color="white" size="4"><b>INSULATION RESISTANCE</b></font>', self.styles['TinyText']),
            '', '',  # spans cols 22-24
            Paragraph('<font color="white" size="4"><b>Pol</b></font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4"><b>Zs</b></font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4"><b>RCD</b></font>', self.styles['TinyText']),
            '',  # spans cols 27-28
            Paragraph('<font color="white" size="4"><b>AFDD</b></font>', self.styles['TinyText']),
        ]

        # Column header row (row 1) - individual column names, all horizontal
        col_header = [
            Paragraph('<font color="white" size="4">Cct No.</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Circuit Description</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Points</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Wiring</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Ref</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Live mm²</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">CPC mm²</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Max t(s)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">BS(EN)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Type</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">In (A)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">kA</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Max Zs</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">BS(EN)</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Type</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">mA</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">A</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">r1</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">rn</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">r2</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">R1+R2</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">R2</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">V</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">L-L</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">L-E</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">✓</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Ω</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">ms</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Btn</font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4">Btn</font>', self.styles['TinyText']),
        ]

        circuit_data = [cat_header, col_header]

        # Helper to safely convert any value to string
        def to_str(val):
            if val is None:
                return ''
            return str(val)

        for circuit in circuits:
            polarity = "✓" if circuit.get('polarity_confirmed', True) else ""
            rcd_btn = "✓" if circuit.get('rcd_test_button') else ""
            afdd_btn = "✓" if circuit.get('afdd_test_button') else ""

            circuit_data.append([
                Paragraph(to_str(circuit.get('circuit_ref', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('circuit_designation', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('number_of_points', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('wiring_type', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('reference_method', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('live_csa', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('cpc_csa', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('max_disconnection_time', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('ocpd_bs_en', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('ocpd_type', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('ocpd_rating_a', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('breaking_capacity', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('max_zs', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('rcd_bs_en', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('rcd_type', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('rcd_operating_current_ma', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('rcd_rating_a', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('r1_ohm', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('rn_ohm', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('r2_ohm', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('r1_r2_ohm', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('R2_ohm', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('test_voltage', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('ir_live_live_mohm', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('ir_live_earth_mohm', '')), self.styles['TinyText']),
                Paragraph(polarity, self.styles['TinyText']),
                Paragraph(to_str(circuit.get('measured_zs_ohm', '')), self.styles['TinyText']),
                Paragraph(to_str(circuit.get('rcd_time_ms', '')), self.styles['TinyText']),
                Paragraph(rcd_btn, self.styles['TinyText']),
                Paragraph(afdd_btn, self.styles['TinyText']),
            ])

        # Add empty rows to fill the page (at least 12 rows)
        rows_needed = max(12 - len(circuits), 0)
        for _ in range(rows_needed):
            circuit_data.append([''] * 30)

        # Column widths for landscape A4 with 2mm margin each side of table (283mm = 802 points)
        # Cols: 0=Cct, 1=Desc, 2=Pts, 3=Wire, 4=Ref, 5=Live, 6=CPC, 7=MaxT, 8=BS(EN), 9=Type, 10=In, 11=kA, 12=MaxZs
        #       13=BS(EN), 14=Type, 15=mA, 16=A, 17=r1, 18=rn, 19=r2, 20=R1R2, 21=R2, 22=V, 23=LL, 24=LE, 25=Pol, 26=Zs, 27=ms, 28=Btn, 29=Btn
        # Widened designation (col 1) from 85→110pt; reclaimed from: col 3 (28→24), col 7 (26→22), col 8 (46→38), col 13 (46→38)
        col_widths = [22, 110, 22, 24, 20, 26, 26, 22, 38, 22, 24, 22, 28, 38, 22, 24, 22, 26, 26, 26, 28, 20, 24, 28, 28, 20, 28, 21, 22, 22]

        circuit_table = Table(circuit_data, colWidths=col_widths)
        circuit_table.setStyle(TableStyle([
            # Header row 0 (category headers) - red background
            ('BACKGROUND', (0, 0), (-1, 0), RED_HEADER),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            # Span cells for category headers in row 0
            ('SPAN', (2, 0), (7, 0)),   # CONDUCTORS spans cols 2-7
            ('SPAN', (8, 0), (12, 0)),  # OVERCURRENT DEVICES spans cols 8-12
            ('SPAN', (13, 0), (16, 0)), # RCD spans cols 13-16
            ('SPAN', (17, 0), (19, 0)), # RING FINAL spans cols 17-19
            ('SPAN', (20, 0), (21, 0)), # R1+R2 / R2 spans cols 20-21
            ('SPAN', (22, 0), (24, 0)), # INSULATION RESISTANCE spans cols 22-24
            ('SPAN', (27, 0), (28, 0)), # RCD spans cols 27-28
            # Header row 1 (column headers) - darker red background
            ('BACKGROUND', (0, 1), (-1, 1), HEADER_ACCENT),
            ('TEXTCOLOR', (0, 1), (-1, 1), colors.white),
            # General styling
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('ALIGN', (1, 0), (1, -1), 'LEFT'),
            ('FONTSIZE', (0, 0), (-1, -1), 4),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            ('ROWBACKGROUNDS', (0, 2), (-1, -1), [LIGHT_BLUE, LIGHT_CREAM]),
        ]))
        elements.append(circuit_table)
        elements.append(Spacer(1, 3))

        # Testing information header
        elements.append(self._create_header_bar(f"{board.get('name', 'DB-1')} - Testing information"))

        # Tested by row
        inspection_date = self.data.get('inspection_date', datetime.now().strftime('%d %b %Y'))
        tested_row = [
            [Paragraph('<b>Tested by</b>', self.styles['TinyText']),
             Paragraph('<b>Name:</b>', self.styles['TinyText']),
             Paragraph(self.inspector['name'], self.styles['TinyText']),
             Paragraph('<b>Position:</b>', self.styles['TinyText']),
             Paragraph(self.inspector['position'], self.styles['TinyText']),
             Paragraph('<b>Date tested:</b>', self.styles['TinyText']),
             Paragraph(inspection_date, self.styles['TinyText']),
             Paragraph('<b>Signature:</b>', self.styles['TinyText']),
             ''],
        ]
        # Full width for tested by row
        tested_table = Table(tested_row, colWidths=[60, 50, 120, 60, 100, 70, 100, 70, 155])
        tested_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 6),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('BACKGROUND', (0, 0), (-1, -1), LIGHT_BLUE),
            ('BACKGROUND', (0, 0), (0, 0), LIGHT_GRAY),
            ('BACKGROUND', (1, 0), (1, 0), LIGHT_GRAY),
            ('BACKGROUND', (3, 0), (3, 0), LIGHT_GRAY),
            ('BACKGROUND', (5, 0), (5, 0), LIGHT_GRAY),
            ('BACKGROUND', (7, 0), (7, 0), LIGHT_GRAY),
        ]))
        elements.append(tested_table)
        elements.append(Spacer(1, 2))

        # Test Equipment Details
        elements.append(Paragraph('<b>Test Equipment Details</b>', self.styles['SmallText']))
        equipment = self.data.get('test_equipment', {})
        equip_row = [
            [Paragraph('<b>MFT:</b>', self.styles['TinyText']),
             Paragraph(equipment.get('mft', 'N/A'), self.styles['TinyText']),
             Paragraph('<b>Continuity:</b>', self.styles['TinyText']),
             Paragraph(equipment.get('continuity', 'N/A'), self.styles['TinyText']),
             Paragraph('<b>Insulation resistance:</b>', self.styles['TinyText']),
             Paragraph(equipment.get('insulation_resistance', 'N/A'), self.styles['TinyText']),
             Paragraph('<b>Earth fault loop impedance:</b>', self.styles['TinyText']),
             Paragraph(equipment.get('earth_fault_loop', 'N/A'), self.styles['TinyText']),
             Paragraph('<b>RCD:</b>', self.styles['TinyText']),
             Paragraph(equipment.get('rcd', 'N/A'), self.styles['TinyText'])],
        ]
        # Full width for equipment details
        equip_table = Table(equip_row, colWidths=[40, 100, 60, 90, 85, 90, 100, 90, 40, 90])
        equip_table.setStyle(TableStyle([
            ('FONTSIZE', (0, 0), (-1, -1), 6),
            ('GRID', (0, 0), (-1, -1), 0.75, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('BACKGROUND', (0, 0), (-1, -1), LIGHT_BLUE),
            ('BACKGROUND', (0, 0), (0, 0), LIGHT_GRAY),
            ('BACKGROUND', (2, 0), (2, 0), LIGHT_GRAY),
            ('BACKGROUND', (4, 0), (4, 0), LIGHT_GRAY),
            ('BACKGROUND', (6, 0), (6, 0), LIGHT_GRAY),
            ('BACKGROUND', (8, 0), (8, 0), LIGHT_GRAY),
        ]))
        elements.append(equip_table)

        return elements

    def _build_guidance(self) -> list:
        """Build guidance page for recipients."""
        elements = []
        elements.append(PageBreak())
        elements.append(Spacer(1, 10*mm))

        elements.append(self._create_header_bar("CONDITION REPORT GUIDANCE FOR RECIPIENTS"))
        elements.append(Spacer(1, 5))

        guidance_items = [
            "1. The purpose of this Report is to confirm, as far as reasonably practicable, whether or not the "
            "electrical installation is in a satisfactory condition for continued service.",
            "2. This Report is only valid if accompanied by the Inspection Schedule(s) and the Schedule(s) of "
            "Circuit Details and Test Results.",
            "3. The person ordering the Report should have received this Report without watermarks.",
            "4. This Report should be retained in a safe place and be made available to any person inspecting or "
            "undertaking work on the electrical installation in the future.",
            "5. For items classified as C1 ('Danger present'), the safety of those using the installation is at "
            "risk - remedial work should be undertaken immediately.",
            "6. For items classified as C2 ('Potentially dangerous'), remedial work should be undertaken as a "
            "matter of urgency.",
            "7. For items classified as FI ('Further investigation'), such observations should be investigated "
            "without delay.",
            "8. For safety reasons, the electrical installation should be re-inspected at appropriate intervals.",
            "9. Where the installation includes a Residual Current Device (RCD) it should be tested 6 monthly by "
            "pressing the button marked 'T' or 'Test'.",
        ]

        for item in guidance_items:
            elements.append(Paragraph(item, self.styles['SmallText']))
            elements.append(Spacer(1, 3))

        return elements

    def _add_header_footer_landscape(self, canvas, doc):
        """Add header with logos and footer for landscape pages - minimal margins."""
        from reportlab.lib.utils import ImageReader
        canvas.saveState()

        page_width, page_height = landscape(A4)
        margin = 5*mm  # Minimal margin for landscape
        logo_y = page_height - 18*mm

        # Company logo (left side)
        try:
            logo_path = Path(self.logo_path)
            if logo_path.exists():
                img = ImageReader(str(logo_path))
                canvas.drawImage(img, margin, logo_y,
                               width=45*mm, height=15*mm, preserveAspectRatio=True, mask='auto')
        except:
            canvas.setFont('Helvetica-Bold', 12)
            canvas.drawString(margin, logo_y + 3*mm, self.company['name'])

        # Certificate number (right side)
        canvas.setFont('Helvetica-Bold', 8)
        canvas.drawRightString(page_width - margin, logo_y + 8*mm, self.cert_number)
        canvas.setFont('Helvetica', 6)
        canvas.drawRightString(page_width - margin, logo_y + 3*mm, self.company['name'])

        # Footer
        canvas.setFont('Helvetica', 6)
        page_num = canvas.getPageNumber()
        canvas.drawString(margin, 5*mm,
                         "Report produced by Tradecert based on the model form from BS7671:2018+A3:2024 (18th Edition).")
        canvas.drawRightString(page_width - margin, 5*mm, f"Page {page_num}")

        canvas.restoreState()

    def generate(self) -> str:
        """Generate the complete EICR PDF with mixed portrait/landscape pages."""
        # Create document with multiple page templates
        doc = BaseDocTemplate(
            self.output_path,
            pagesize=A4,
        )

        # Portrait frame
        portrait_frame = Frame(
            self.margin, 15*mm,
            self.page_width - 2*self.margin, self.page_height - 40*mm,
            id='portrait_frame'
        )

        # Landscape frame - minimal margins for maximum table width
        landscape_width, landscape_height = landscape(A4)
        landscape_margin = 5*mm  # Reduced margin for landscape page
        landscape_frame = Frame(
            landscape_margin, 10*mm,
            landscape_width - 2*landscape_margin, landscape_height - 25*mm,
            id='landscape_frame'
        )

        # Create page templates
        portrait_template = PageTemplate(
            id='portrait',
            frames=[portrait_frame],
            onPage=self._add_header_footer,
            pagesize=A4
        )

        landscape_template = PageTemplate(
            id='landscape',
            frames=[landscape_frame],
            onPage=self._add_header_footer_landscape,
            pagesize=landscape(A4)
        )

        doc.addPageTemplates([portrait_template, landscape_template])

        # Build all pages
        elements = []
        elements.extend(self._build_page1())
        elements.extend(self._build_page2())
        elements.extend(self._build_page3())
        elements.extend(self._build_inspection_schedule())

        # Switch to landscape for circuit schedule
        elements.append(NextPageTemplate('landscape'))
        elements.append(PageBreak())
        elements.extend(self._build_circuit_schedule_landscape())

        # Switch back to portrait for guidance
        elements.append(NextPageTemplate('portrait'))
        elements.extend(self._build_guidance())

        # Photos are now shown inline with observations, no separate appendix needed
        # elements.extend(self._build_photo_appendix())

        # Build the PDF
        doc.build(elements)

        return self.output_path

    def _build_photo_appendix(self) -> list:
        """Build appendix page with observation photos - grouped by unique photo."""
        elements = []
        observations = self.data.get('observations', [])
        job_path = self.data.get('job_path', '')

        # Check if any observations have photos
        obs_with_photos = [(i, obs) for i, obs in enumerate(observations, 1) if obs.get('photo')]
        if not obs_with_photos or not job_path:
            return elements

        # Group observations by photo path (to avoid showing same photo multiple times)
        photos_to_obs = {}
        for i, obs in obs_with_photos:
            photo_path = obs.get('photo')
            if photo_path not in photos_to_obs:
                photos_to_obs[photo_path] = []
            photos_to_obs[photo_path].append((i, obs))

        # Start new page for appendix
        elements.append(PageBreak())
        elements.append(Spacer(1, 10*mm))

        # Appendix header
        elements.append(Paragraph("<b>APPENDIX - PHOTOGRAPHIC EVIDENCE</b>", self.styles['TitleText']))
        elements.append(Spacer(1, 10))

        # Display each unique photo with its associated observations
        for photo_idx, (photo_rel_path, obs_list) in enumerate(photos_to_obs.items(), 1):
            photo_full_path = Path(job_path) / photo_rel_path

            if not photo_full_path.exists():
                continue

            try:
                # Photo label
                elements.append(Paragraph(f"<b>Photo {photo_idx}: Consumer Unit</b>", self.styles['SectionHeader']))
                elements.append(Spacer(1, 5))

                # Create photo element - larger size since shown once
                photo_img = Image(str(photo_full_path), width=120*mm, height=None)
                photo_img._restrictSize(120*mm, 140*mm)
                elements.append(photo_img)
                elements.append(Spacer(1, 8))

                # List observations that reference this photo
                obs_numbers = [str(i) for i, _ in obs_list]
                elements.append(Paragraph(
                    f"<i>Related to Observation(s): {', '.join(obs_numbers)}</i>",
                    self.styles['SmallText']
                ))
                elements.append(Spacer(1, 15))

            except Exception as e:
                # Skip if image fails to load
                continue

        return elements


def generate_eicr_pdf(data: dict, output_path: str) -> str:
    """Generate an EICR PDF certificate."""
    generator = EICRPDFGenerator(output_path, data)
    return generator.generate()


if __name__ == "__main__":
    # Test
    sample_data = {
        'certificate_number': 'EICR-20260114-TEST',
        'client': {'name': 'Test Client', 'address': '123 Test Street'},
        'supply_characteristics': {'earthing_arrangement': 'TN-C-S', 'nominal_voltage_u': '230'},
        'observations': [{'title': 'Test', 'text': 'Test observation', 'code': 'C2'}],
        'circuits': [{'circuit_ref': '1', 'circuit_designation': 'Ring Final', 'ocpd_type': 'B', 'ocpd_rating_a': '32'}],
    }
    generate_eicr_pdf(sample_data, '/tmp/test_eicr.pdf')
    print("Generated test PDF")
