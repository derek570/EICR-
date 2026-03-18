/**
 * PDF generation routes
 */

import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import * as auth from "../auth.js";
import * as db from "../db.js";
import * as storage from "../storage.js";
import { resolveJob, routeTimeout } from "../utils/jobs.js";
import logger from "../logger.js";

const router = Router();

/**
 * Generate PDF certificate
 * POST /api/job/:userId/:jobId/generate-pdf
 */
router.post("/job/:userId/:jobId/generate-pdf", auth.requireAuth, routeTimeout(60000), async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  logger.info("PDF generation requested", { userId, jobId });

  let tempDir = null;

  try {
    const job = await resolveJob(userId, jobId);
    const folderName = job?.address || jobId;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `eicr-pdf-${jobId}-`));
    const outputDir = path.join(tempDir, "output");
    await fs.mkdir(outputDir, { recursive: true });

    const s3Prefix = `jobs/${userId}/${folderName}/output/`;

    const csvContent = await storage.downloadText(`${s3Prefix}test_results.csv`);
    if (csvContent) {
      await fs.writeFile(path.join(outputDir, "test_results.csv"), csvContent);
    }

    let extractedContent = null;
    try {
      extractedContent = await storage.downloadText(`${s3Prefix}extracted_data.json`);
    } catch (e) {
      logger.info("No extracted_data.json found, will use pipeline files", { jobId });
    }

    if (extractedContent) {
      const extracted = JSON.parse(extractedContent);

      const installationData = extracted.installation_details || {};
      await fs.writeFile(
        path.join(outputDir, "installation_details.json"),
        JSON.stringify({
          address: installationData.address || extracted.address || jobId,
          client_name: installationData.client_name || extracted.client_name || "",
          postcode: installationData.postcode || extracted.postcode || "",
          ...installationData,
        }, null, 2)
      );

      const boardInfo = extracted.board_info || {};
      const supplyChars = extracted.supply_characteristics || {};
      await fs.writeFile(
        path.join(outputDir, "board_details.json"),
        JSON.stringify({
          ...boardInfo,
          ze: supplyChars.earth_loop_impedance_ze || boardInfo.ze || "",
          ipf_at_db: supplyChars.prospective_fault_current || boardInfo.ipf_at_db || "",
          earthing_arrangement: supplyChars.earthing_arrangement || boardInfo.earthing_arrangement || "",
          voltage_rating: supplyChars.nominal_voltage_u || boardInfo.voltage_rating || "",
          nominal_voltage_u: supplyChars.nominal_voltage_u || boardInfo.nominal_voltage_u || "",
          nominal_voltage_uo: supplyChars.nominal_voltage_uo || boardInfo.nominal_voltage_uo || "",
          nominal_frequency: supplyChars.nominal_frequency || boardInfo.nominal_frequency || "",
          live_conductors: supplyChars.live_conductors || boardInfo.live_conductors || "",
          number_of_supplies: supplyChars.number_of_supplies || boardInfo.number_of_supplies || "",
          supply_polarity_confirmed: supplyChars.supply_polarity_confirmed ?? boardInfo.supply_polarity_confirmed ?? "",
          earthing_conductor_csa: supplyChars.earthing_conductor_csa || boardInfo.earthing_conductor_csa || "",
          earthing_conductor_material: supplyChars.earthing_conductor_material || boardInfo.earthing_conductor_material || "",
          main_bonding_csa: supplyChars.main_bonding_csa || boardInfo.main_bonding_csa || "",
          bonding_conductor_material: supplyChars.bonding_conductor_material || boardInfo.bonding_conductor_material || "",
          bonding_conductor_csa: supplyChars.bonding_conductor_csa || boardInfo.bonding_conductor_csa || "",
          bonding_water: supplyChars.bonding_water ?? boardInfo.bonding_water ?? "",
          bonding_gas: supplyChars.bonding_gas ?? boardInfo.bonding_gas ?? "",
          bonding_oil: supplyChars.bonding_oil ?? boardInfo.bonding_oil ?? "",
          bonding_structural_steel: supplyChars.bonding_structural_steel ?? boardInfo.bonding_structural_steel ?? "",
          bonding_lightning: supplyChars.bonding_lightning ?? boardInfo.bonding_lightning ?? "",
          bonding_other: supplyChars.bonding_other || boardInfo.bonding_other || "",
          main_switch_bs_en: supplyChars.main_switch_bs_en || boardInfo.main_switch_bs_en || "",
          main_switch_poles: supplyChars.main_switch_poles || boardInfo.main_switch_poles || "",
          main_switch_voltage: supplyChars.main_switch_voltage || boardInfo.main_switch_voltage || "",
          main_switch_current: supplyChars.main_switch_current || boardInfo.main_switch_current || "",
          rated_current: supplyChars.main_switch_current || supplyChars.rated_current || boardInfo.rated_current || "",
          spd_bs_en: supplyChars.spd_bs_en || boardInfo.spd_bs_en || "",
          spd_type_supply: supplyChars.spd_type_supply || boardInfo.spd_type_supply || "",
          spd_short_circuit: supplyChars.spd_short_circuit || boardInfo.spd_short_circuit || "",
          spd_rated_current: supplyChars.spd_rated_current || boardInfo.spd_rated_current || "",
          earth_electrode_type: supplyChars.earth_electrode_type || boardInfo.earth_electrode_type || "",
          earth_electrode_resistance: supplyChars.earth_electrode_resistance || boardInfo.earth_electrode_resistance || "",
          tails_csa: supplyChars.tails_csa || boardInfo.tails_csa || "",
          tails_material: supplyChars.tails_material || boardInfo.tails_material || "",
          extent: extracted.installation_details?.extent || boardInfo.extent || "",
          agreed_limitations: extracted.installation_details?.agreed_limitations || boardInfo.agreed_limitations || "",
          agreed_with: extracted.installation_details?.agreed_with || boardInfo.agreed_with || "",
          operational_limitations: extracted.installation_details?.operational_limitations || boardInfo.operational_limitations || "",
        }, null, 2)
      );

      await fs.writeFile(
        path.join(outputDir, "supply_characteristics.json"),
        JSON.stringify(supplyChars, null, 2)
      );

      await fs.writeFile(
        path.join(outputDir, "observations.json"),
        JSON.stringify(extracted.observations || [], null, 2)
      );

      if (extracted.boards && Array.isArray(extracted.boards) && extracted.boards.length > 0) {
        await fs.writeFile(
          path.join(outputDir, "boards.json"),
          JSON.stringify(extracted.boards, null, 2)
        );
        logger.info("Written boards.json for multi-board PDF generation", { jobId, boardCount: extracted.boards.length });
      }

      if (extracted.inspection_schedule) {
        await fs.writeFile(
          path.join(outputDir, "inspection_schedule.json"),
          JSON.stringify(extracted.inspection_schedule, null, 2)
        );
        logger.info("Written inspection_schedule.json for PDF generation", { jobId });
      }

      if (extracted.inspector) {
        await fs.writeFile(
          path.join(outputDir, "inspector.json"),
          JSON.stringify(extracted.inspector, null, 2)
        );
        logger.info("Written inspector.json for PDF generation", { jobId });
      }

      logger.info("Using extracted_data.json for PDF generation", { jobId });
    } else {
      logger.info("Downloading individual pipeline files for PDF generation", { jobId });

      try {
        const installationJson = await storage.downloadText(`${s3Prefix}installation_details.json`);
        if (installationJson) {
          await fs.writeFile(path.join(outputDir, "installation_details.json"), installationJson);
        }
      } catch (e) {
        logger.warn("No installation_details.json found", { jobId });
        await fs.writeFile(
          path.join(outputDir, "installation_details.json"),
          JSON.stringify({ address: jobId, client_name: "", postcode: "" }, null, 2)
        );
      }

      try {
        const boardJson = await storage.downloadText(`${s3Prefix}board_details.json`);
        if (boardJson) {
          await fs.writeFile(path.join(outputDir, "board_details.json"), boardJson);
        }
      } catch (e) {
        logger.warn("No board_details.json found", { jobId });
        await fs.writeFile(
          path.join(outputDir, "board_details.json"),
          JSON.stringify({}, null, 2)
        );
      }

      try {
        const observationsJson = await storage.downloadText(`${s3Prefix}observations.json`);
        if (observationsJson) {
          await fs.writeFile(path.join(outputDir, "observations.json"), observationsJson);
        }
      } catch (e) {
        logger.warn("No observations.json found", { jobId });
        await fs.writeFile(
          path.join(outputDir, "observations.json"),
          JSON.stringify([], null, 2)
        );
      }

      try {
        const supplyJson = await storage.downloadText(`${s3Prefix}supply_characteristics.json`);
        if (supplyJson) {
          const supply = JSON.parse(supplyJson);
          const boardPath = path.join(outputDir, "board_details.json");
          let board = {};
          try {
            const existingBoard = await fs.readFile(boardPath, "utf8");
            board = JSON.parse(existingBoard);
          } catch (e) {}

          const mergedBoard = {
            ...board,
            ze: supply.earth_loop_impedance_ze || board.ze || "",
            ipf_at_db: supply.prospective_fault_current || board.ipf_at_db || "",
            earthing_arrangement: supply.earthing_arrangement || board.earthing_arrangement || "",
            voltage_rating: supply.nominal_voltage_u || board.voltage_rating || "",
          };
          await fs.writeFile(boardPath, JSON.stringify(mergedBoard, null, 2));
          logger.info("Merged supply_characteristics into board_details for PDF", { jobId });
        }
      } catch (e) {
        logger.debug("No supply_characteristics.json found for PDF merge", { jobId });
      }
    }

    const pythonScript = path.resolve(import.meta.dirname, "..", "..", "python", "generate_full_pdf.py");

    const pdfPath = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("PDF generation timed out after 30 seconds"));
      }, 30000);

      const proc = spawn("python3", [pythonScript, outputDir], {
        cwd: path.resolve(import.meta.dirname, "..", ".."),
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          const match = stdout.match(/Generated:\s*(.+\.pdf)/);
          if (match) {
            resolve(match[1].trim());
          } else {
            resolve(path.join(outputDir, "eicr_certificate.pdf"));
          }
        } else {
          reject(new Error(`PDF generation failed: ${stderr || stdout}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const pdfBuffer = await fs.readFile(pdfPath);

    logger.info("PDF generated successfully", { userId, jobId, size: pdfBuffer.length });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="EICR_${jobId}.pdf"`);
    res.send(pdfBuffer);

  } catch (error) {
    logger.error("PDF generation failed", { userId, jobId, error: error.message });
    res.status(500).json({ error: "PDF generation failed: " + error.message });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

export default router;
