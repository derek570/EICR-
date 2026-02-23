import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

function generateHTML(data) {
  const { board, circuits, testedBy, testDate, inspector } = data;

  // Use inspector object if provided, otherwise fall back to testedBy string
  const inspectorName = inspector?.name || testedBy || '';
  const inspectorOrg = inspector?.organisation || '';
  const inspectorEnrolment = inspector?.enrolment_number || '';
  const inspectorMFT = inspector?.mft_serial_number || '';

  const circuitRows = circuits.map(c => `
    <tr>
      <td class="center">${c.circuit_ref || ''}</td>
      <td>${c.circuit_designation || ''}</td>
      <td class="center">${c.number_of_points || c.num_points || ''}</td>
      <td class="center">${c.wiring_type || 'A'}</td>
      <td class="center">${c.ref_method || 'C'}</td>
      <td class="center">${c.live_csa_mm2 || ''}</td>
      <td class="center">${c.cpc_csa_mm2 || ''}</td>
      <td class="center">${c.max_disconnect_time_s || '0.4'}</td>
      <td class="center">${c.ocpd_bs_en || '61009-1'}</td>
      <td class="center">${c.ocpd_type || 'B'}</td>
      <td class="center">${c.ocpd_rating_a || ''}</td>
      <td class="center">${c.ocpd_breaking_capacity_ka || '6'}</td>
      <td class="center">${c.ocpd_max_zs_ohm || ''}</td>
      <td class="center">${c.rcd_bs_en || '61009-1'}</td>
      <td class="center">${c.rcd_type || 'A'}</td>
      <td class="center">${c.rcd_operating_current_ma || '30'}</td>
      <td class="center">${c.rcd_rating_a || ''}</td>
      <td class="center">${c.ring_r1_ohm || ''}</td>
      <td class="center">${c.ring_rn_ohm || ''}</td>
      <td class="center">${c.ring_r2_ohm || ''}</td>
      <td class="center">${c.r1_r2_ohm || ''}</td>
      <td class="center">${c.r2_ohm || ''}</td>
      <td class="center">${c.ir_test_voltage_v || '500'}</td>
      <td class="center">${c.ir_live_live_mohm || '>200'}</td>
      <td class="center">${c.ir_live_earth_mohm || '>200'}</td>
      <td class="center">${c.polarity_confirmed === true || c.polarity_confirmed === 'true' || c.polarity_confirmed === '✓' || c.polarity_confirmed === 'OK' ? '✓' : ''}</td>
      <td class="center">${c.measured_zs_ohm || ''}</td>
      <td class="center">${c.rcd_time_ms || ''}</td>
      <td class="center">${c.rcd_button_confirmed === true || c.rcd_button_confirmed === 'true' || c.rcd_button_confirmed === '✓' || c.rcd_button_confirmed === 'OK' ? '✓' : ''}</td>
      <td class="center">${c.afdd_button_confirmed || 'N/A'}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: Arial, sans-serif;
      font-size: 9px;
      padding: 15px;
      background: white;
    }
    h1 {
      font-size: 18px;
      margin-bottom: 10px;
    }
    .header-bar {
      background: #cc0000;
      color: white;
      padding: 5px 10px;
      font-weight: bold;
      font-size: 11px;
      margin: 10px 0 5px 0;
    }
    .board-details {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 5px;
      margin-bottom: 10px;
      font-size: 9px;
    }
    .board-details .row {
      display: contents;
    }
    .board-details label {
      font-weight: bold;
    }
    .board-row {
      display: flex;
      flex-wrap: wrap;
      gap: 15px;
      margin-bottom: 5px;
      padding: 3px 0;
      border-bottom: 1px solid #ddd;
    }
    .board-row .item {
      display: flex;
      gap: 5px;
    }
    .board-row .item label {
      font-weight: bold;
    }
    .check {
      color: green;
      font-weight: bold;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 8px;
      margin-top: 10px;
    }
    th, td {
      border: 1px solid #999;
      padding: 3px 2px;
      text-align: left;
    }
    th {
      background: #f0f0f0;
      font-weight: bold;
      text-align: center;
      font-size: 7px;
    }
    .center {
      text-align: center;
    }
    .header-group {
      background: #cc0000;
      color: white;
      text-align: center;
      font-weight: bold;
    }
    .sub-header {
      background: #ffcccc;
      font-size: 6px;
    }
    .notes-section {
      margin: 10px 0;
      padding: 5px;
      border: 1px solid #ccc;
      min-height: 30px;
    }
    .testing-info {
      margin-top: 15px;
      padding: 10px;
      border: 1px solid #ccc;
    }
    .testing-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-top: 10px;
    }
    .testing-grid .item {
      display: flex;
      gap: 5px;
    }
    .testing-grid .item label {
      font-weight: bold;
    }
  </style>
</head>
<body>
  <h1>Distribution Board - ${board.name || 'DB-1'}</h1>

  <div class="header-bar">${board.name || 'DB-1'} - Board Details</div>

  <div class="board-row">
    <div class="item"><label>Location:</label> <span>${board.location || ''}</span></div>
    <div class="item"><label>Manufacturer:</label> <span>${board.manufacturer || ''}</span></div>
    <div class="item"><label>Supplied from:</label> <span>${board.supplied_from || ''}</span></div>
    <div class="item"><label>Polarity confirmed:</label> <span class="check">✓</span></div>
    <div class="item"><label>Phases:</label> <span>${board.phases || '1'}</span></div>
    <div class="item"><label>Phases confirmed:</label> <span>${board.phases_confirmed || 'N/A'}</span></div>
  </div>

  <div class="board-row">
    <div class="item"><label>Zs at DB:</label> <span>${board.zs_at_db || ''} ohm</span></div>
    <div class="item"><label>IPF at DB:</label> <span>${board.ipf_at_db || ''} kA</span></div>
    <div class="item"><label>RCD trip time:</label> <span>${board.rcd_trip_time || 'N/A'} ms</span></div>
    <div class="item"><label>Main Switch BS (EN):</label> <span>${board.main_switch_bs_en || '60947-3'}</span></div>
    <div class="item"><label>Voltage rating:</label> <span>${board.voltage_rating || '230'} V</span></div>
    <div class="item"><label>Rated current:</label> <span>${board.rated_current || '100'} A</span></div>
    <div class="item"><label>IPF rating:</label> <span>${board.ipf_rating || 'N/A'} kA</span></div>
    <div class="item"><label>RCD rating:</label> <span>${board.rcd_rating || 'N/A'} mA</span></div>
  </div>

  <div class="board-row">
    <div class="item"><label>SPD Details Type:</label> <span>${board.spd_type || 'N/A'}</span></div>
    <div class="item"><label>Status:</label> <span class="check">${board.spd_status || '✓'}</span></div>
    <div class="item"><label>Overcurrent Device BS (EN):</label> <span>${board.spd_ocpd_bs_en || ''}</span></div>
    <div class="item"><label>Voltage:</label> <span>${board.spd_voltage || ''} V</span></div>
    <div class="item"><label>Current:</label> <span>${board.spd_current || ''} A</span></div>
  </div>

  <div><strong>Notes:</strong></div>
  <div class="notes-section">${board.notes || ''}</div>

  <table>
    <thead>
      <tr>
        <th rowspan="2" style="width: 30px">Circuit<br>reference</th>
        <th rowspan="2" style="width: 100px">Circuit designation</th>
        <th rowspan="2" style="width: 35px">Number of<br>points served</th>
        <th colspan="5" class="header-group">CONDUCTORS</th>
        <th colspan="5" class="header-group">OVERCURRENT DEVICES</th>
        <th colspan="4" class="header-group">RCD</th>
        <th colspan="3" class="header-group">RING FINAL CIRCUITS</th>
        <th colspan="2" class="header-group">R1+R2 OR R2</th>
        <th colspan="3" class="header-group">INSULATION RESISTANCE</th>
        <th rowspan="2" style="width: 30px">Polarity<br>confirmed</th>
        <th rowspan="2" style="width: 35px">Measured<br>Zs (ohm)</th>
        <th colspan="2" class="header-group">RCD</th>
        <th colspan="1" class="header-group">AFDD</th>
      </tr>
      <tr class="sub-header">
        <th>Type of<br>wiring</th>
        <th>Reference<br>method</th>
        <th>Live<br>(mm²)</th>
        <th>CPC<br>(mm²)</th>
        <th>Max disconnect<br>time (s)</th>
        <th>BS(EN)</th>
        <th>Type</th>
        <th>Rating<br>(A)</th>
        <th>Breaking<br>capacity (kA)</th>
        <th>Maximum<br>Zs (ohm)</th>
        <th>BS(EN)</th>
        <th>Type</th>
        <th>Operating<br>current (mA)</th>
        <th>Rating<br>(A)</th>
        <th>r1<br>(ohm)</th>
        <th>rn<br>(ohm)</th>
        <th>r2<br>(ohm)</th>
        <th>R1+R2<br>(ohm)</th>
        <th>R2<br>(ohm)</th>
        <th>Test<br>Voltage (V)</th>
        <th>Live-Live<br>(Mohm)</th>
        <th>Live-Earth<br>(Mohm)</th>
        <th>RCD time<br>(ms)</th>
        <th>RCD button<br>confirmed</th>
        <th>AFDD button<br>confirmed</th>
      </tr>
    </thead>
    <tbody>
      ${circuitRows}
    </tbody>
  </table>

  <div class="header-bar">${board.name || 'DB-1'} - Testing information</div>

  <div class="testing-info">
    <div class="testing-grid">
      <div class="item"><label>Tested by Name:</label> <span>${inspectorName}</span></div>
      <div class="item"><label>Organisation:</label> <span>${inspectorOrg}</span></div>
      <div class="item"><label>Enrolment No:</label> <span>${inspectorEnrolment}</span></div>
      <div class="item"><label>Date tested:</label> <span>${testDate || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</span></div>
    </div>

    <div style="margin-top: 15px;"><strong>Test Equipment Details</strong></div>
    <div class="testing-grid">
      <div class="item"><label>MFT Serial No:</label> <span>${inspectorMFT || 'N/A'}</span></div>
      <div class="item"><label>Continuity:</label> <span>N/A</span></div>
      <div class="item"><label>Insulation resistance:</label> <span>N/A</span></div>
      <div class="item"><label>Earth fault loop impedance:</label> <span>N/A</span></div>
      <div class="item"><label>RCD:</label> <span>N/A</span></div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Generate a PDF test results sheet matching the Tradecert format
 */
export async function generateTestResultsPDF({ outDir, circuits, board, testedBy, testDate, inspector }) {
  const html = generateHTML({
    board: board || {},
    circuits: circuits || [],
    testedBy,
    testDate,
    inspector: inspector || {}
  });

  // Save HTML for debugging
  await fs.writeFile(path.join(outDir, "test_results.html"), html, "utf8");

  // Launch browser and generate PDF
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setContent(html, { waitUntil: "networkidle" });

  await page.pdf({
    path: path.join(outDir, "test_results.pdf"),
    format: "A4",
    landscape: true,
    margin: {
      top: "10mm",
      bottom: "10mm",
      left: "10mm",
      right: "10mm"
    },
    printBackground: true
  });

  await browser.close();

  return {
    pdf: "test_results.pdf",
    html: "test_results.html"
  };
}
