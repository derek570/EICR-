#!/usr/bin/env python3
"""
EIC PDF Generator - Creates professional Electrical Installation Certificate matching Tradecert format.
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
import os


# Tradecert-style color palette
RED_HEADER = colors.HexColor('#CC0000')
HEADER_ACCENT = colors.HexColor('#990000')
LIGHT_GRAY = colors.HexColor('#F0F0F0')
LIGHT_GREEN = colors.HexColor('#E8F5E9')
LIGHT_BLUE = colors.HexColor('#E3F2FD')
LIGHT_CREAM = colors.HexColor('#FFFEF0')
BORDER_GRAY = colors.HexColor('#CCCCCC')
GREEN_CHECK = colors.HexColor('#228B22')
GRAY_NA = colors.HexColor('#808080')
TEXT_DARK = colors.HexColor('#000000')


# EIC Inspection Schedule Items (simplified 14-item version)
EIC_INSPECTION_ITEMS = [
    ("1.0", "Condition of consumer's intake equipment (Visual inspection only)"),
    ("2.0", "Parallel or switched alternative sources of supply"),
    ("3.0", "Protective measure: Automatic disconnection of supply"),
    ("4.0", "Basic protection"),
    ("5.0", "Protective measures other than ADS"),
    ("6.0", "Additional protection"),
    ("7.0", "Distribution equipment"),
    ("8.0", "Circuits (Distribution and final)"),
    ("9.0", "Isolation and switching"),
    ("10.0", "Current using equipment (permanently connected)"),
    ("11.0", "Identification and notices"),
    ("12.0", "Location(s) containing a bath or shower"),
    ("13.0", "Other special installations or locations"),
    ("14.0", "Prosumer's low voltage electrical installation(s)"),
]


class TickBox(Flowable):
    """Custom flowable for a tick box with optional tick or N/A."""

    def __init__(self, size=12, checked=False, na=False):
        Flowable.__init__(self)
        self.size = size
        self.checked = checked
        self.na = na
        self.width = size
        self.height = size

    def draw(self):
        self.canv.setStrokeColor(BORDER_GRAY)
        self.canv.setLineWidth(0.5)

        if self.na:
            # Draw N/A box with gray background
            self.canv.setFillColor(GRAY_NA)
            self.canv.roundRect(0, 0, self.size, self.size, 2, fill=1, stroke=1)
            self.canv.setFillColor(colors.white)
            self.canv.setFont("Helvetica-Bold", 6)
            self.canv.drawCentredString(self.size/2, self.size/2 - 2, "N/A")
        elif self.checked:
            # Draw green tick box
            self.canv.setFillColor(GREEN_CHECK)
            self.canv.roundRect(0, 0, self.size, self.size, 2, fill=1, stroke=1)
            # Draw tick mark
            self.canv.setStrokeColor(colors.white)
            self.canv.setLineWidth(1.5)
            self.canv.line(2, self.size/2, self.size/3, 3)
            self.canv.line(self.size/3, 3, self.size-2, self.size-3)
        else:
            # Empty box
            self.canv.setFillColor(colors.white)
            self.canv.roundRect(0, 0, self.size, self.size, 2, fill=1, stroke=1)


class EICPDFGenerator:
    """Generate EIC PDF certificates matching the Tradecert format."""

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
            'name': '',
            'position': ''
        })

        # Certificate number
        self.cert_number = data.get('certificate_number', f"EIC-{datetime.now().strftime('%Y%m%d')}-XXXX")

    def _setup_styles(self):
        """Setup custom paragraph styles."""
        self.styles.add(ParagraphStyle(
            'RedHeader',
            parent=self.styles['Heading1'],
            fontSize=10,
            textColor=colors.white,
            backColor=RED_HEADER,
            spaceAfter=0,
            spaceBefore=0,
            leftIndent=3,
            rightIndent=3,
            leading=14,
            fontName='Helvetica-Bold'
        ))

        self.styles.add(ParagraphStyle(
            'FieldLabel',
            parent=self.styles['Normal'],
            fontSize=8,
            textColor=TEXT_DARK,
            fontName='Helvetica-Bold'
        ))

        self.styles.add(ParagraphStyle(
            'FieldValue',
            parent=self.styles['Normal'],
            fontSize=9,
            textColor=TEXT_DARK,
            fontName='Helvetica'
        ))

        self.styles.add(ParagraphStyle(
            'SmallText',
            parent=self.styles['Normal'],
            fontSize=7,
            textColor=TEXT_DARK,
            fontName='Helvetica'
        ))

        self.styles.add(ParagraphStyle(
            'TitleStyle',
            parent=self.styles['Title'],
            fontSize=16,
            textColor=TEXT_DARK,
            fontName='Helvetica-Bold',
            alignment=TA_LEFT
        ))

        self.styles.add(ParagraphStyle(
            'TinyText',
            parent=self.styles['Normal'],
            fontSize=5,
            textColor=TEXT_DARK,
            fontName='Helvetica'
        ))

        self.styles.add(ParagraphStyle(
            'TitleText',
            parent=self.styles['Normal'],
            fontSize=12,
            textColor=TEXT_DARK,
            fontName='Helvetica-Bold'
        ))

    def _create_header_bar(self, title):
        """Create a red header bar matching EICR style."""
        table = Table([[Paragraph(f'<font color="white"><b>{title}</b></font>', self.styles['SmallText'])]],
                      colWidths=[self.content_width])
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ]))
        return table

    def _create_header(self):
        """Create the certificate header with logos and title."""
        elements = []

        # Logo row
        logo_data = []

        # Company logo
        if self.logo_path and os.path.exists(self.logo_path):
            try:
                logo = Image(self.logo_path, width=60, height=40)
                logo_data.append(logo)
            except:
                logo_data.append('')
        else:
            logo_data.append('')

        # Title in center
        title_para = Paragraph(
            "<b>ELECTRICAL INSTALLATION CERTIFICATE</b><br/>"
            "<font size='8'>Requirements for electrical installations (BS7671:2018+A3:2024 18th edition)</font><br/>"
            f"<font size='8'>Certificate number: {self.cert_number}</font>",
            self.styles['FieldValue']
        )
        logo_data.append(title_para)

        # NICEIC logo
        if self.niceic_logo_path and os.path.exists(self.niceic_logo_path):
            try:
                niceic = Image(self.niceic_logo_path, width=50, height=35)
                logo_data.append(niceic)
            except:
                logo_data.append('')
        else:
            logo_data.append('')

        header_table = Table([logo_data], colWidths=[70, self.content_width - 140, 70])
        header_table.setStyle(TableStyle([
            ('ALIGN', (0, 0), (0, 0), 'LEFT'),
            ('ALIGN', (1, 0), (1, 0), 'CENTER'),
            ('ALIGN', (2, 0), (2, 0), 'RIGHT'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]))

        elements.append(header_table)
        elements.append(Spacer(1, 5*mm))

        return elements

    def _create_section_header(self, title):
        """Create a red section header."""
        return Table(
            [[Paragraph(title, self.styles['RedHeader'])]],
            colWidths=[self.content_width],
            rowHeights=[18]
        )

    def _create_client_details(self):
        """Create client details section."""
        elements = []

        header = self._create_section_header("DETAILS OF THE CLIENT")
        header.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
            ('TEXTCOLOR', (0, 0), (-1, -1), colors.white),
        ]))
        elements.append(header)

        client = self.data.get('client', {})

        # Use 4 columns for all rows, spanning where needed
        data = [
            [Paragraph("<b>Client:</b>", self.styles['SmallText']),
             Paragraph(client.get('name', ''), self.styles['SmallText']), '', ''],
            [Paragraph("<b>Address:</b>", self.styles['SmallText']),
             Paragraph(client.get('address', ''), self.styles['SmallText']), '', ''],
            [Paragraph("<b>Phone:</b>", self.styles['SmallText']),
             Paragraph(client.get('phone', ''), self.styles['SmallText']),
             Paragraph("<b>Email:</b>", self.styles['SmallText']),
             Paragraph(client.get('email', ''), self.styles['SmallText'])],
        ]

        col_widths = [50, (self.content_width - 100) / 2, 50, (self.content_width - 100) / 2]
        table = Table(data, colWidths=col_widths)
        table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (0, -1), LIGHT_GRAY),
            ('BACKGROUND', (2, 2), (2, 2), LIGHT_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            # Span columns 1-3 for rows 0 and 1 (Client and Address)
            ('SPAN', (1, 0), (3, 0)),
            ('SPAN', (1, 1), (3, 1)),
        ]))
        elements.append(table)
        elements.append(Spacer(1, 3*mm))

        return elements

    def _create_installation_details(self):
        """Create installation details section."""
        elements = []

        header = self._create_section_header("DETAILS OF INSTALLATION")
        header.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
        ]))
        elements.append(header)

        installation = self.data.get('installation_details', {})

        data = [
            [Paragraph("<b>Name:</b>", self.styles['FieldLabel']),
             Paragraph(installation.get('name', ''), self.styles['FieldValue'])],
            [Paragraph("<b>Installation address:</b>", self.styles['FieldLabel']),
             Paragraph(installation.get('address', ''), self.styles['FieldValue'])],
            [Paragraph("<b>Description of premises:</b>", self.styles['FieldLabel']),
             Paragraph(installation.get('description', 'Residential'), self.styles['FieldValue'])],
        ]

        table = Table(data, colWidths=[100, self.content_width - 100])
        table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (0, -1), LIGHT_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(table)
        elements.append(Spacer(1, 3*mm))

        return elements

    def _create_extent_section(self):
        """Create extent of installation section."""
        elements = []

        header = self._create_section_header("EXTENT OF INSTALLATION COVERED BY THIS CERTIFICATE")
        header.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
        ]))
        elements.append(header)

        extent = self.data.get('extent_and_limitations', {})
        installation = self.data.get('installation_details', {})

        # Extent text area
        extent_text = extent.get('extent', '')
        data = [
            [Paragraph("<b>Extent of the electrical installation covered by this certificate:</b>", self.styles['FieldLabel'])],
            [Paragraph(extent_text, self.styles['FieldValue'])],
        ]

        table = Table(data, colWidths=[self.content_width], rowHeights=[15, 50])
        table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(table)

        # Installation type checkboxes
        install_type = installation.get('installation_type', 'new_installation')

        new_check = TickBox(10, checked=(install_type == 'new_installation'))
        addition_check = TickBox(10, checked=(install_type == 'addition'))
        alteration_check = TickBox(10, checked=(install_type == 'alteration'))

        type_data = [
            [Paragraph("<b>Installation is:</b>", self.styles['FieldLabel']),
             new_check, Paragraph("New installation", self.styles['SmallText']),
             addition_check, Paragraph("An addition to an existing installation", self.styles['SmallText']),
             alteration_check, Paragraph("An alteration to an existing installation", self.styles['SmallText'])],
        ]

        type_table = Table(type_data, colWidths=[70, 15, 80, 15, 150, 15, 150])
        type_table.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 2),
        ]))
        elements.append(type_table)

        # Comments on existing installation
        comments_text = extent.get('comments_on_existing', '')
        comments_data = [
            [Paragraph("<b>Comments on existing installation (in the case of an addition or alteration see Regulation 644.1.2):</b>", self.styles['SmallText'])],
            [Paragraph(comments_text, self.styles['FieldValue'])],
        ]

        comments_table = Table(comments_data, colWidths=[self.content_width], rowHeights=[15, 30])
        comments_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(comments_table)
        elements.append(Spacer(1, 3*mm))

        return elements

    def _create_next_inspection(self):
        """Create next inspection section."""
        elements = []

        header = self._create_section_header("NEXT INSPECTION")
        header.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
        ]))
        elements.append(header)

        next_years = self.data.get('installation_details', {}).get('next_inspection_years', 10)

        data = [
            [Paragraph(f"I/We, the designer(s), recommend that this installation is further inspected and tested after an interval of not more than:", self.styles['SmallText']),
             Paragraph(f"<b>{next_years} years</b>", self.styles['FieldValue'])],
        ]

        table = Table(data, colWidths=[self.content_width - 60, 60])
        table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(table)
        elements.append(Spacer(1, 3*mm))

        return elements

    def _create_design_section(self):
        """Create design, construction, inspection and testing section."""
        elements = []

        header = self._create_section_header("FOR THE DESIGN, CONSTRUCTION, INSPECTION AND TESTING")
        header.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
        ]))
        elements.append(header)

        design = self.data.get('design_construction', {})

        # Departures
        departures = design.get('departures_from_bs7671', '')
        data = [
            [Paragraph("<b>Details of departures from BS 7671, as amended (Regulations 120.3, 133.5):</b>", self.styles['SmallText'])],
            [Paragraph(departures, self.styles['FieldValue'])],
        ]

        table = Table(data, colWidths=[self.content_width], rowHeights=[15, 30])
        table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(table)

        # Permitted exceptions and risk assessment
        exceptions = design.get('permitted_exceptions', '')
        risk_attached = design.get('risk_assessment_attached', False)
        risk_check = TickBox(10, checked=risk_attached)

        exc_data = [
            [Paragraph("<b>Details of permitted exceptions (Regulations 411.3.3):</b>", self.styles['SmallText']),
             Paragraph("Risk assessment attached", self.styles['SmallText']), risk_check],
            [Paragraph(exceptions, self.styles['FieldValue']), '', ''],
        ]

        exc_table = Table(exc_data, colWidths=[self.content_width - 120, 100, 20], rowHeights=[15, 25])
        exc_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('SPAN', (0, 1), (2, 1)),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(exc_table)
        elements.append(Spacer(1, 3*mm))

        return elements

    def _create_signature_section(self):
        """Create signature section."""
        elements = []

        # Declaration text
        declaration = Paragraph(
            "I/We, being the person(s) responsible for the design, construction and inspection and testing of the electrical installation "
            "(as indicated by my/our signatures below), particulars of which are described above, having exercised reasonable skill and care "
            "when carrying out the design, construction and inspection and testing, hereby CERTIFY that the work for which I have been "
            "responsible is to the best of my knowledge and belief in accordance with BS7671:2018+A3:2024 (18th Edition) as amended except "
            "for the departures, if any, detailed above.",
            self.styles['SmallText']
        )
        elements.append(declaration)
        elements.append(Spacer(1, 3*mm))

        # Signature table with company info
        inspector = self.data.get('inspector', {})
        company = self.data.get('company', self.company)

        sig_data = [
            [Paragraph("<b>For the Design, Construction, Inspection and Testing</b>", self.styles['FieldLabel']),
             Paragraph("<b>Company</b>", self.styles['FieldLabel'])],
            [Paragraph("The extent of liability of the signatory or signatories is limited to the work described above as the subject of this Certificate.", self.styles['SmallText']),
             Paragraph(f"<b>Name:</b> {company.get('name', '')}", self.styles['SmallText'])],
            [Paragraph(f"<b>Name:</b> {inspector.get('name', '')}", self.styles['SmallText']),
             Paragraph(f"<b>Address:</b><br/>{company.get('address', '')}", self.styles['SmallText'])],
            [Paragraph(f"<b>Position:</b> {inspector.get('position', '')}", self.styles['SmallText']),
             ''],
            [Paragraph("<b>Signature:</b>", self.styles['SmallText']),
             Paragraph(f"<b>Phone:</b> {company.get('phone', '')}", self.styles['SmallText'])],
            [Paragraph(f"<b>Date:</b> {datetime.now().strftime('%d %b %Y')}", self.styles['SmallText']),
             Paragraph(f"<b>Website:</b> {company.get('website', '')}", self.styles['SmallText'])],
            ['', Paragraph(f"<b>Enrolment No.:</b> {company.get('enrolment', '')}", self.styles['SmallText'])],
        ]

        sig_table = Table(sig_data, colWidths=[self.content_width/2, self.content_width/2])
        sig_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('BACKGROUND', (1, 0), (1, -1), LIGHT_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(sig_table)

        return elements

    def _create_supply_characteristics(self):
        """Create supply characteristics section (Page 2)."""
        elements = []

        header = self._create_section_header("SUPPLY CHARACTERISTICS AND EARTHING ARRANGEMENTS")
        header.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
        ]))
        elements.append(header)

        supply = self.data.get('supply_characteristics', {})

        # Main supply info row
        supply_data = [
            [Paragraph("<b>Earthing arrangement:</b>", self.styles['FieldLabel']),
             Paragraph(supply.get('earthing_arrangement', ''), self.styles['FieldValue']),
             Paragraph("<b>Number and type of live conductors:</b>", self.styles['FieldLabel']),
             Paragraph(supply.get('live_conductors', 'AC -'), self.styles['FieldValue'])],
        ]

        supply_table = Table(supply_data, colWidths=[90, 80, 140, 100])
        supply_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (0, 0), LIGHT_GRAY),
            ('BACKGROUND', (2, 0), (2, 0), LIGHT_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(supply_table)

        # Nature of Supply Parameters
        elements.append(Paragraph("<b>Nature of Supply Parameters</b>", self.styles['FieldLabel']))

        params_data = [
            [Paragraph("<b>Nominal voltage (U):</b>", self.styles['SmallText']),
             Paragraph(supply.get('nominal_voltage_u', '') + " V", self.styles['FieldValue']),
             Paragraph("<b>Uo:</b>", self.styles['SmallText']),
             Paragraph(supply.get('nominal_voltage_uo', '230') + " V", self.styles['FieldValue']),
             Paragraph("<b>Nominal frequency:</b>", self.styles['SmallText']),
             Paragraph(supply.get('nominal_frequency', '50') + " Hz", self.styles['FieldValue']),
             Paragraph("<b>Supply polarity confirmed:</b>", self.styles['SmallText']),
             TickBox(10, checked=supply.get('supply_polarity_confirmed', True))],
            [Paragraph("<b>Prospective fault current:</b>", self.styles['SmallText']),
             Paragraph(supply.get('prospective_fault_current', '') + " kA", self.styles['FieldValue']),
             Paragraph("<b>Earth loop impedance (Ze):</b>", self.styles['SmallText']),
             Paragraph(supply.get('earth_loop_impedance_ze', '') + " ohm", self.styles['FieldValue']),
             Paragraph("<b>Number of supplies:</b>", self.styles['SmallText']),
             Paragraph(supply.get('number_of_supplies', '1'), self.styles['FieldValue']),
             '', ''],
        ]

        params_table = Table(params_data, colWidths=[85, 45, 40, 45, 75, 40, 90, 20])
        params_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 3),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ]))
        elements.append(params_table)
        elements.append(Spacer(1, 3*mm))

        return elements

    def _create_particulars_section(self):
        """Create particulars of installation section."""
        elements = []

        header = self._create_section_header("PARTICULARS OF INSTALLATION REFERRED TO IN THE CERTIFICATE")
        header.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
        ]))
        elements.append(header)

        particulars = self.data.get('particulars_of_installation', {})
        means = particulars.get('means_of_earthing', {})
        electrode = particulars.get('earth_electrode', {})
        main_switch = particulars.get('main_switch', {})
        earthing_cond = particulars.get('earthing_conductor', {})
        bonding = particulars.get('main_protective_bonding', {})
        extraneous = particulars.get('bonding_of_extraneous_parts', {})

        # Means of earthing
        dist_check = TickBox(10, checked=means.get('distributor_facility', True))
        elec_check = TickBox(10, checked=means.get('earth_electrode', False))

        means_data = [
            [Paragraph("<b>Means of earthing</b>", self.styles['FieldLabel']),
             dist_check, Paragraph("Distributor's facility", self.styles['SmallText']),
             Paragraph("<b>Details of installation earth electrode (where applicable)</b>", self.styles['FieldLabel'])],
            ['', elec_check, Paragraph("Earth electrode", self.styles['SmallText']),
             Paragraph(f"<b>Type:</b> {electrode.get('type', 'N/A')}  <b>Resistance to earth:</b> {electrode.get('resistance_to_earth', 'N/A')} ohm  <b>Location:</b> {electrode.get('location', 'N/A')}", self.styles['SmallText'])],
        ]

        means_table = Table(means_data, colWidths=[80, 15, 100, self.content_width - 195])
        means_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(means_table)

        # Main switch details
        elements.append(Paragraph("<b>Main switch / switch fuse / circuit breaker / RCD</b>", self.styles['FieldLabel']))

        switch_data = [
            [Paragraph(f"<b>Location:</b> {main_switch.get('location', '')}", self.styles['SmallText']),
             Paragraph(f"<b>Type BS(EN):</b> {main_switch.get('type_bs_en', '')}", self.styles['SmallText']),
             Paragraph(f"<b>Number of poles:</b> {main_switch.get('number_of_poles', '')}", self.styles['SmallText']),
             Paragraph(f"<b>Voltage rating:</b> {main_switch.get('voltage_rating', '')} V", self.styles['SmallText']),
             Paragraph(f"<b>Rated current:</b> {main_switch.get('rated_current', '')} A", self.styles['SmallText'])],
        ]

        switch_table = Table(switch_data, colWidths=[100, 90, 80, 80, 80])
        switch_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 3),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ]))
        elements.append(switch_table)

        # Earthing and bonding conductors
        cond_data = [
            [Paragraph("<b>Earthing conductor</b>", self.styles['FieldLabel']),
             Paragraph(f"<b>Conductor material:</b> {earthing_cond.get('conductor_material', '')}", self.styles['SmallText']),
             Paragraph(f"<b>Conductor CSA:</b> {earthing_cond.get('conductor_csa', '')} mm\u00b2", self.styles['SmallText']),
             Paragraph(f"<b>Continuity:</b>", self.styles['SmallText']),
             TickBox(10, checked=earthing_cond.get('continuity', True))],
            [Paragraph("<b>Main protective bonding</b>", self.styles['FieldLabel']),
             Paragraph(f"<b>Conductor material:</b> {bonding.get('conductor_material', '')}", self.styles['SmallText']),
             Paragraph(f"<b>Conductor CSA:</b> {bonding.get('conductor_csa', '')} mm\u00b2", self.styles['SmallText']),
             Paragraph(f"<b>Continuity:</b>", self.styles['SmallText']),
             TickBox(10, checked=bonding.get('continuity', True))],
        ]

        cond_table = Table(cond_data, colWidths=[110, 110, 100, 60, 20])
        cond_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 3),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ]))
        elements.append(cond_table)

        # Bonding of extraneous parts
        elements.append(Paragraph("<b>Bonding of extraneous conductive parts</b>", self.styles['FieldLabel']))

        bond_data = [
            [Paragraph("<b>Water:</b>", self.styles['SmallText']),
             TickBox(10, checked=extraneous.get('water', True)),
             Paragraph("<b>Gas:</b>", self.styles['SmallText']),
             TickBox(10, checked=extraneous.get('gas', True)),
             Paragraph("<b>Oil:</b>", self.styles['SmallText']),
             TickBox(10, checked=extraneous.get('oil', False)),
             Paragraph("<b>Steel:</b>", self.styles['SmallText']),
             TickBox(10, checked=extraneous.get('steel', False)),
             Paragraph("<b>Lightning:</b>", self.styles['SmallText']),
             TickBox(10, checked=extraneous.get('lightning', False))],
            [Paragraph("<b>Other:</b>", self.styles['SmallText']),
             Paragraph(extraneous.get('other', 'N/A'), self.styles['FieldValue']),
             '', '', '', '', '', '', '', ''],
        ]

        bond_table = Table(bond_data, colWidths=[40, 15, 30, 15, 30, 15, 35, 15, 55, 15])
        bond_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('SPAN', (1, 1), (9, 1)),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 3),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ]))
        elements.append(bond_table)
        elements.append(Spacer(1, 3*mm))

        return elements

    def _create_inspection_schedule(self):
        """Create the EIC inspection schedule section."""
        elements = []

        header = self._create_section_header("INSPECTION SCHEDULE")
        header.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
        ]))
        elements.append(header)

        # Legend
        legend_data = [
            [TickBox(12, checked=True), Paragraph("Satisfactory inspection", self.styles['SmallText']),
             TickBox(12, na=True), Paragraph("Not applicable", self.styles['SmallText'])],
        ]

        legend_table = Table(legend_data, colWidths=[20, 120, 20, 100])
        legend_table.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(legend_table)
        elements.append(Spacer(1, 2*mm))

        # Schedule table header
        schedule_header = [
            [Paragraph("<b>Item no</b>", self.styles['FieldLabel']),
             Paragraph("<b>Description</b>", self.styles['FieldLabel']),
             Paragraph("<b>Outcome</b>", self.styles['FieldLabel'])],
        ]

        schedule = self.data.get('inspection_schedule', {}).get('items', {})

        schedule_rows = schedule_header.copy()
        for item_no, description in EIC_INSPECTION_ITEMS:
            item_data = schedule.get(item_no, {})
            if isinstance(item_data, dict):
                outcome = item_data.get('outcome', 'tick')
            else:
                outcome = item_data if item_data else 'tick'

            if outcome == 'tick' or outcome == True:
                outcome_cell = TickBox(14, checked=True)
            elif outcome == 'N/A' or outcome == 'na':
                outcome_cell = TickBox(14, na=True)
            else:
                outcome_cell = TickBox(14, checked=False)

            schedule_rows.append([
                Paragraph(item_no, self.styles['FieldValue']),
                Paragraph(description, self.styles['SmallText']),
                outcome_cell
            ])

        schedule_table = Table(schedule_rows, colWidths=[40, self.content_width - 80, 40])
        schedule_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('BACKGROUND', (0, 0), (-1, 0), LIGHT_GREEN),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('ALIGN', (2, 0), (2, -1), 'CENTER'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(schedule_table)

        return elements

    def _create_distribution_board(self):
        """Create distribution board section (Page 3)."""
        elements = []

        board = self.data.get('distribution_board', {})
        board_name = board.get('board_name', 'DB-1')

        # Board header
        elements.append(Paragraph(f"<b>Distribution Board - {board_name}</b>", self.styles['TitleStyle']))
        elements.append(Spacer(1, 3*mm))

        header = self._create_section_header(f"{board_name} - Board Details")
        header.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
        ]))
        elements.append(header)

        # Board details
        details_data = [
            [Paragraph("<b>Location:</b>", self.styles['SmallText']),
             Paragraph(board.get('location', ''), self.styles['FieldValue']),
             Paragraph("<b>Manufacturer:</b>", self.styles['SmallText']),
             Paragraph(board.get('manufacturer', ''), self.styles['FieldValue']),
             Paragraph("<b>Supplied from:</b>", self.styles['SmallText']),
             Paragraph(board.get('supplied_from', ''), self.styles['FieldValue']),
             Paragraph("<b>Polarity confirmed:</b>", self.styles['SmallText']),
             TickBox(10, checked=board.get('polarity_confirmed', True)),
             Paragraph("<b>Phases:</b>", self.styles['SmallText']),
             Paragraph(board.get('phases', '1'), self.styles['FieldValue']),
             Paragraph("<b>Phases confirmed:</b>", self.styles['SmallText']),
             Paragraph(board.get('phases_confirmed', ''), self.styles['FieldValue'])],
        ]

        details_table = Table(details_data, colWidths=[45, 55, 55, 55, 55, 55, 70, 15, 40, 25, 70, 30])
        details_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 2),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ]))
        elements.append(details_table)

        # Zs, IPF, RCD, Main Switch row
        main_switch = board.get('main_switch', {})
        spd = board.get('spd_details', {})

        row2_data = [
            [Paragraph("<b>Zs at DB:</b>", self.styles['SmallText']),
             Paragraph(f"{board.get('zs_at_db', '')} ohm", self.styles['FieldValue']),
             Paragraph("<b>IPF at DB:</b>", self.styles['SmallText']),
             Paragraph(f"{board.get('ipf_at_db', '')} kA", self.styles['FieldValue']),
             Paragraph("<b>RCD trip time:</b>", self.styles['SmallText']),
             Paragraph(f"{board.get('rcd_trip_time', '')} ms", self.styles['FieldValue']),
             Paragraph("<b>Main Switch BS (EN):</b>", self.styles['SmallText']),
             Paragraph(main_switch.get('bs_en', ''), self.styles['FieldValue']),
             Paragraph("<b>Voltage rating:</b>", self.styles['SmallText']),
             Paragraph(f"{main_switch.get('voltage_rating', '')} V", self.styles['FieldValue']),
             Paragraph("<b>Rated current:</b>", self.styles['SmallText']),
             Paragraph(f"{main_switch.get('rated_current', '')} A", self.styles['FieldValue'])],
        ]

        row2_table = Table(row2_data, colWidths=[50, 40, 50, 35, 60, 35, 80, 50, 60, 35, 60, 35])
        row2_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 2),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ]))
        elements.append(row2_table)

        # SPD Details row
        spd_data = [
            [Paragraph("<b>SPD Details</b>", self.styles['FieldLabel']),
             Paragraph(f"<b>Type:</b> {spd.get('type', '')}", self.styles['SmallText']),
             Paragraph(f"<b>Status:</b> {spd.get('status', '')}", self.styles['SmallText']),
             Paragraph("<b>Overcurrent Device</b>", self.styles['FieldLabel']),
             '', '', '', ''],
        ]

        spd_table = Table(spd_data, colWidths=[70, 80, 80, 100, 50, 50, 50, 50])
        spd_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 3),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ]))
        elements.append(spd_table)

        # Notes
        notes_data = [
            [Paragraph("<b>Notes:</b>", self.styles['FieldLabel']),
             Paragraph(board.get('notes', ''), self.styles['FieldValue'])],
        ]

        notes_table = Table(notes_data, colWidths=[50, self.content_width - 50])
        notes_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(notes_table)
        elements.append(Spacer(1, 5*mm))

        return elements

    def _build_circuit_schedule_landscape(self):
        """Build circuit schedule for landscape page - matching EICR/Tradecert format exactly."""
        elements = []
        elements.append(Spacer(1, 3*mm))

        board = self.data.get('distribution_board', {})

        # Title
        elements.append(Paragraph(f"<b>Distribution Board - {board.get('name', 'DB-1')}</b>", self.styles['TitleText']))
        elements.append(Spacer(1, 2))

        # DB-1 - Board Details header (using landscape width)
        landscape_width = landscape(A4)[0] - 10*mm
        header_table = Table([[Paragraph(f'<font color="white"><b>{board.get("name", "DB-1")} - Board Details</b></font>', self.styles['SmallText'])]],
                            colWidths=[landscape_width])
        header_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ]))
        elements.append(header_table)

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
        cat_header = [
            Paragraph('<font color="white" size="4"><b>Cct</b></font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4"><b>Designation</b></font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4"><b>CONDUCTORS</b></font>', self.styles['TinyText']),
            '', '', '', '', '',
            Paragraph('<font color="white" size="4"><b>OVERCURRENT DEVICES</b></font>', self.styles['TinyText']),
            '', '', '', '',
            Paragraph('<font color="white" size="4"><b>RCD</b></font>', self.styles['TinyText']),
            '', '', '',
            Paragraph('<font color="white" size="4"><b>RING FINAL</b></font>', self.styles['TinyText']),
            '', '',
            Paragraph('<font color="white" size="4"><b>R1+R2 / R2</b></font>', self.styles['TinyText']),
            '',
            Paragraph('<font color="white" size="4"><b>INSULATION RESISTANCE</b></font>', self.styles['TinyText']),
            '', '',
            Paragraph('<font color="white" size="4"><b>Pol</b></font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4"><b>Zs</b></font>', self.styles['TinyText']),
            Paragraph('<font color="white" size="4"><b>RCD</b></font>', self.styles['TinyText']),
            '',
            Paragraph('<font color="white" size="4"><b>AFDD</b></font>', self.styles['TinyText']),
        ]

        # Column header row (row 1)
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

        # Column widths for landscape A4
        col_widths = [22, 85, 22, 28, 20, 26, 26, 26, 46, 22, 24, 22, 28, 46, 22, 24, 22, 26, 26, 26, 28, 20, 24, 28, 28, 20, 28, 21, 22, 22]

        circuit_table = Table(circuit_data, colWidths=col_widths)
        circuit_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), RED_HEADER),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('SPAN', (2, 0), (7, 0)),
            ('SPAN', (8, 0), (12, 0)),
            ('SPAN', (13, 0), (16, 0)),
            ('SPAN', (17, 0), (19, 0)),
            ('SPAN', (20, 0), (21, 0)),
            ('SPAN', (22, 0), (24, 0)),
            ('SPAN', (27, 0), (28, 0)),
            ('BACKGROUND', (0, 1), (-1, 1), HEADER_ACCENT),
            ('TEXTCOLOR', (0, 1), (-1, 1), colors.white),
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
        testing_header = Table([[Paragraph(f'<font color="white"><b>{board.get("name", "DB-1")} - Testing information</b></font>', self.styles['SmallText'])]],
                              colWidths=[landscape_width])
        testing_header.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ]))
        elements.append(testing_header)

        # Tested by row
        inspection_date = self.data.get('inspection_date', datetime.now().strftime('%d %b %Y'))
        inspector = self.data.get('inspector', {})
        tested_row = [
            [Paragraph('<b>Tested by</b>', self.styles['TinyText']),
             Paragraph('<b>Name:</b>', self.styles['TinyText']),
             Paragraph(inspector.get('name', ''), self.styles['TinyText']),
             Paragraph('<b>Position:</b>', self.styles['TinyText']),
             Paragraph(inspector.get('position', ''), self.styles['TinyText']),
             Paragraph('<b>Date tested:</b>', self.styles['TinyText']),
             Paragraph(inspection_date, self.styles['TinyText']),
             Paragraph('<b>Signature:</b>', self.styles['TinyText']),
             ''],
        ]
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

    def _add_header_footer_landscape(self, canvas, doc):
        """Add header with logos and footer for landscape pages."""
        canvas.saveState()
        page_width, page_height = landscape(A4)
        margin = 5*mm

        # Certificate number at top right
        canvas.setFont('Helvetica', 8)
        canvas.drawRightString(page_width - margin, page_height - 12*mm, self.cert_number)

        # Footer text
        footer_text = "Certificate produced by Tradecert based on the model form from BS7671:2018+A3:2024 (18th Edition)."
        canvas.setFont('Helvetica', 7)
        canvas.drawString(margin, 6*mm, footer_text)

        # Page number
        page_num = canvas.getPageNumber()
        canvas.drawRightString(page_width - margin, 6*mm, f"Page {page_num}")

        canvas.restoreState()

    def _create_testing_info(self):
        """Create testing information section."""
        elements = []

        header = self._create_section_header("DB-1 - Testing information")
        header.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
        ]))
        elements.append(header)

        inspector = self.data.get('inspector', {})
        test_equip = self.data.get('distribution_board', {}).get('test_equipment', {})

        # Tested by row
        test_data = [
            [Paragraph("<b>Tested by</b>", self.styles['FieldLabel']),
             Paragraph(f"<b>Name:</b> {inspector.get('name', '')}", self.styles['SmallText']),
             Paragraph(f"<b>Position:</b> {inspector.get('position', '')}", self.styles['SmallText']),
             Paragraph(f"<b>Date tested:</b> {datetime.now().strftime('%d %b %Y')}", self.styles['SmallText']),
             Paragraph("<b>Signature:</b>", self.styles['SmallText']),
             ''],
        ]

        test_table = Table(test_data, colWidths=[60, 100, 80, 90, 60, 80])
        test_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(test_table)

        # Test equipment details
        elements.append(Paragraph("<b>Test Equipment Details</b>", self.styles['FieldLabel']))

        equip_data = [
            [Paragraph(f"<b>MFT:</b> {test_equip.get('mft', 'N/A')}", self.styles['SmallText']),
             Paragraph(f"<b>Continuity:</b> {test_equip.get('continuity', 'N/A')}", self.styles['SmallText']),
             Paragraph(f"<b>Insulation resistance:</b> {test_equip.get('insulation_resistance', 'N/A')}", self.styles['SmallText']),
             Paragraph(f"<b>Earth fault loop impedance:</b> {test_equip.get('earth_fault_loop_impedance', 'N/A')}", self.styles['SmallText']),
             Paragraph(f"<b>RCD:</b> {test_equip.get('rcd', 'N/A')}", self.styles['SmallText'])],
        ]

        equip_table = Table(equip_data, colWidths=[80, 80, 100, 130, 80])
        equip_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        elements.append(equip_table)

        return elements

    def _create_guidance_page(self):
        """Create the guidance page (Page 4)."""
        elements = []

        header = self._create_section_header("ELECTRICAL INSTALLATION CERTIFICATE GUIDANCE FOR RECIPIENTS")
        header.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), RED_HEADER),
        ]))
        elements.append(header)
        elements.append(Spacer(1, 3*mm))

        guidance_text = [
            "1. This CERTIFICATE is an important and valuable document which should be retained for future reference.",
            "2. This safety Certificate has been issued to confirm that the electrical installation work to which it relates has been designed, constructed, inspected and tested in accordance with BS 7671.",
            "3. You should have received a Certificate without watermarks and the company should have retained a duplicate. If you were the person ordering the work, but not the owner of the installation, you should pass this Certificate, or a full copy of it including the schedules, immediately to the owner.",
            "4. This Certificate should be retained in a safe place and be shown to any person inspecting or undertaking further work on the electrical installation in the future. If you later vacate the property, this Certificate will demonstrate to the new owner that the electrical installation complied with the requirements of BS 7671 at the time the Certificate was issued.",
            "5. For safety reasons, the electrical installation will need to be inspected at appropriate intervals by a skilled person or persons, competent in such work. The maximum time interval recommended before the next inspection is stated on Page 1 under 'NEXT INSPECTION'.",
            "6. This Certificate is intended to be issued only for a new electrical installation or for new work associated with an alteration or an addition to an existing installation. It should not have been issued for the inspection and testing of an existing electrical installation. An 'Electrical Installation Condition Report (EICR)' should have been issued for such an inspection.",
            "7. This Certificate is only valid if the Schedule of Inspections has been completed to confirm that all relevant inspections have been carried out and where accompanied by Schedule(s) of Circuit Details and Test Results.",
            "8. Where the installation includes a residual current device (RCD) it should be tested six-monthly by pressing the button marked 'T' or 'Test'. The device should switch off the supply and should then be switched on to restore the supply. If the device does not switch off the supply when the button is pressed, seek expert advice.",
            "9. Where the installation includes an arc fault detection device (AFDD) having a manual test facility it should be tested six-monthly by pressing the test button.",
            "10. Where the installation includes a surge protection device (SPD) the status indicator should be checked to confirm it is in operational condition in accordance with manufacturers information.",
            "11. Where the installation includes alternative or additional sources of supply, warning notices should be found at the origin or meter position.",
        ]

        for text in guidance_text:
            elements.append(Paragraph(text, self.styles['SmallText']))
            elements.append(Spacer(1, 2*mm))

        elements.append(Spacer(1, 5*mm))

        # Wiring types reference
        elements.append(Paragraph("<b>WIRING TYPES REFERENCE</b>", self.styles['FieldLabel']))
        elements.append(Spacer(1, 2*mm))

        wiring_types = [
            "A: PVC/PVC cables",
            "B: PVC cables in metallic conduit",
            "C: PVC cables in non-metallic conduit core",
            "D: PVC cables in metallic trunking",
            "E: PVC cables in non-metallic trunking",
            "F: PVC/SWA cables",
            "G: XLPE/SWA cables",
            "H: Mineral insulated cables",
            "O: Other cable types not listed here",
        ]

        for wtype in wiring_types:
            elements.append(Paragraph(wtype, self.styles['SmallText']))

        return elements

    def _add_page_footer(self, canvas, doc):
        """Add footer to each page."""
        canvas.saveState()

        # Certificate number at top right
        canvas.setFont('Helvetica', 8)
        canvas.drawRightString(self.page_width - self.margin, self.page_height - 15*mm, self.cert_number)

        # Footer text
        footer_text = "Certificate produced by Tradecert based on the model form from BS7671:2018+A3:2024 (18th Edition)."
        canvas.setFont('Helvetica', 7)
        canvas.drawString(self.margin, 10*mm, footer_text)

        # Page number
        page_num = canvas.getPageNumber()
        canvas.drawRightString(self.page_width - self.margin, 10*mm, f"Page {page_num} of 4")

        canvas.restoreState()

    def generate(self):
        """Generate the complete EIC PDF with mixed portrait/landscape pages."""
        doc = BaseDocTemplate(
            self.output_path,
            pagesize=A4,
            leftMargin=self.margin,
            rightMargin=self.margin,
            topMargin=20*mm,
            bottomMargin=15*mm
        )

        # Create frames for portrait and landscape orientations
        portrait_frame = Frame(
            self.margin, 15*mm,
            self.page_width - 2*self.margin, self.page_height - 35*mm,
            id='portrait_frame'
        )

        landscape_width, landscape_height = landscape(A4)
        landscape_margin = 5*mm
        landscape_frame = Frame(
            landscape_margin, 10*mm,
            landscape_width - 2*landscape_margin, landscape_height - 25*mm,
            id='landscape_frame'
        )

        # Create page templates
        portrait_template = PageTemplate(
            id='portrait',
            frames=[portrait_frame],
            onPage=self._add_page_footer,
            pagesize=A4
        )

        landscape_template = PageTemplate(
            id='landscape',
            frames=[landscape_frame],
            onPage=self._add_header_footer_landscape,
            pagesize=landscape(A4)
        )

        doc.addPageTemplates([portrait_template, landscape_template])

        elements = []

        # Page 1: Client details, Installation details, Extent, Next inspection, Design, Signatures
        elements.extend(self._create_header())
        elements.extend(self._create_client_details())
        elements.extend(self._create_installation_details())
        elements.extend(self._create_extent_section())
        elements.extend(self._create_next_inspection())
        elements.extend(self._create_design_section())
        elements.extend(self._create_signature_section())

        elements.append(PageBreak())

        # Page 2: Supply characteristics, Particulars, Inspection schedule
        elements.extend(self._create_header())
        elements.extend(self._create_supply_characteristics())
        elements.extend(self._create_particulars_section())
        elements.extend(self._create_inspection_schedule())

        # Switch to landscape for circuit schedule
        elements.append(NextPageTemplate('landscape'))
        elements.append(PageBreak())

        # Page 3: Circuit schedule (landscape) - includes board details, circuit table, and testing info
        elements.extend(self._build_circuit_schedule_landscape())

        # Switch back to portrait for guidance page
        elements.append(NextPageTemplate('portrait'))
        elements.append(PageBreak())

        # Page 4: Guidance
        elements.extend(self._create_header())
        elements.extend(self._create_guidance_page())

        # Build PDF
        doc.build(elements)

        return self.output_path


def generate_eic_pdf(data: dict, output_path: str) -> str:
    """
    Generate an EIC PDF certificate.

    Args:
        data: Dictionary containing all certificate data
        output_path: Path where PDF will be saved

    Returns:
        Path to the generated PDF
    """
    generator = EICPDFGenerator(output_path, data)
    return generator.generate()


def detect_bathroom_work(text: str) -> bool:
    """
    Detect if the work description mentions bathroom-related work.

    Args:
        text: The extent/description text to analyze

    Returns:
        True if bathroom work is detected, False otherwise
    """
    keywords = [
        'bathroom', 'bath', 'shower', 'en-suite', 'ensuite',
        'wet room', 'wetroom', 'washroom', 'toilet', 'wc',
        'bath/shower', 'shower room'
    ]

    text_lower = text.lower()
    return any(keyword in text_lower for keyword in keywords)


if __name__ == "__main__":
    # Test generation
    test_data = {
        'certificate_number': 'EIC-20260120-TEST',
        'client': {
            'name': 'Test Client',
            'address': '123 Test Street, Test Town',
            'phone': '01onal234567',
            'email': 'test@test.com'
        },
        'installation_details': {
            'name': 'Test Installation',
            'address': '123 Test Street, Test Town',
            'description': 'Residential',
            'installation_type': 'new_installation',
            'next_inspection_years': 10
        },
        'extent_and_limitations': {
            'extent': 'New bathroom installation including shower circuit',
            'comments_on_existing': ''
        },
        'supply_characteristics': {
            'earthing_arrangement': 'TN-C-S',
            'live_conductors': 'AC - 1-phase (2 wire)',
            'nominal_voltage_u': '230',
            'nominal_voltage_uo': '230',
            'nominal_frequency': '50',
            'supply_polarity_confirmed': True,
            'prospective_fault_current': '2.5',
            'earth_loop_impedance_ze': '0.35',
            'number_of_supplies': '1'
        },
        'inspection_schedule': {
            'items': {
                '12.0': {'outcome': 'tick'}  # Bathroom work detected
            }
        },
        'inspector': {
            'name': 'Derek Beckley',
            'position': 'Manager'
        }
    }

    # Test bathroom detection
    print(f"Bathroom detected: {detect_bathroom_work(test_data['extent_and_limitations']['extent'])}")

    # Generate test PDF
    output = generate_eic_pdf(test_data, '/tmp/test_eic.pdf')
    print(f"Generated: {output}")
