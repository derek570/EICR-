/**
 * Admin API routes for EICR-oMatic 3000.
 * Provides system health, queue status, and monitoring endpoints.
 * Mounted at /api/admin in the main api.js server.
 */

import express from 'express';
import { getQueueStatus, getQueueHealth } from './queue.js';
import * as db from './db.js';
import * as storage from './storage.js';

const router = express.Router();

/**
 * GET /api/admin/health
 * Comprehensive system health check
 */
router.get('/health', async (req, res) => {
  try {
    // Check database connectivity
    let dbStatus = 'unknown';
    try {
      await db.query('SELECT 1');
      dbStatus = 'connected';
    } catch {
      dbStatus = 'disconnected';
    }

    // Check storage
    const storageType = storage.isUsingS3() ? 's3' : 'local';

    res.json({
      status: 'ok',
      service: 'eicr-backend-admin',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
      database: dbStatus,
      storage: storageType,
      nodeVersion: process.version,
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/admin/queue/status
 * Job queue status
 */
router.get('/queue/status', async (req, res) => {
  try {
    const status = await getQueueStatus();
    res.json({ status: 'ok', queue: status });
  } catch (error) {
    res.json({ status: 'unavailable', message: error.message });
  }
});

/**
 * GET /api/admin/queue/health
 * Queue health check
 */
router.get('/queue/health', async (req, res) => {
  try {
    const health = await getQueueHealth();
    res.json({ status: 'ok', health });
  } catch (error) {
    res.json({ status: 'unavailable', message: error.message });
  }
});

/**
 * GET /api/admin/stats
 * System statistics with company-level breakdown
 */
router.get('/stats', async (req, res) => {
  try {
    let jobCount = 0;
    let userCount = 0;
    let companyCount = 0;
    let companyBreakdown = [];

    try {
      const jobResult = await db.query('SELECT COUNT(*) as count FROM jobs');
      jobCount = jobResult.rows?.[0]?.count || 0;
    } catch {
      /* db not available */
    }

    try {
      const userResult = await db.query('SELECT COUNT(*) as count FROM users');
      userCount = userResult.rows?.[0]?.count || 0;
    } catch {
      /* db not available */
    }

    try {
      const companyResult = await db.query('SELECT COUNT(*) as count FROM companies');
      companyCount = companyResult.rows?.[0]?.count || 0;
    } catch {
      /* companies table may not exist yet */
    }

    try {
      const breakdownResult = await db.query(`
        SELECT c.id, c.name, c.is_active,
               (SELECT COUNT(*) FROM users WHERE company_id = c.id) as user_count,
               (SELECT COUNT(*) FROM jobs WHERE company_id = c.id) as job_count
        FROM companies c ORDER BY c.name ASC
      `);
      companyBreakdown = breakdownResult.rows || [];
    } catch {
      /* companies table may not exist yet */
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      jobs: { total: jobCount },
      users: { total: userCount },
      companies: { total: companyCount, breakdown: companyBreakdown },
      uptime: process.uptime(),
      storage: storage.isUsingS3() ? 's3' : 'local',
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

export default router;
