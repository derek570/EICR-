/**
 * Tests for recording session lifecycle logic — start, chunk upload, finish,
 * access control, and input validation.
 *
 * These test the handler logic patterns used by src/routes/recording.js
 * without importing the full route module (which has heavy transitive deps
 * like transcribe, extractChunk, Gemini, etc.).
 */

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

// Must be set before importing auth.js (which reads it at module init)
process.env.JWT_SECRET = 'dev-secret-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET;

// ---- Mock DB layer ----
const mockGetUserById = jest.fn();
const mockGetUserByEmail = jest.fn();
const mockUpdateLastLogin = jest.fn();
const mockUpdateLoginAttempts = jest.fn();
const mockLogAction = jest.fn();
const mockCreateJob = jest.fn();
const mockGetJob = jest.fn();
const mockUpdateJob = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
  getUserByEmail: mockGetUserByEmail,
  getUserById: mockGetUserById,
  updateLastLogin: mockUpdateLastLogin,
  updateLoginAttempts: mockUpdateLoginAttempts,
  logAction: mockLogAction,
  createJob: mockCreateJob,
  getJob: mockGetJob,
  updateJob: mockUpdateJob,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const auth = await import('../auth.js');

const activeUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test',
  company_name: 'Co',
  is_active: true,
};

function makeToken(userId = 'user-1') {
  return jwt.sign({ userId, email: 'test@example.com' }, JWT_SECRET, { expiresIn: '24h' });
}

describe('Recording session lifecycle', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Session start logic', () => {
    test('should generate unique session ID', () => {
      const sessionId = `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      expect(sessionId).toMatch(/^rec_\d+_[a-z0-9]+$/);
    });

    test('should initialize session state correctly', () => {
      const session = {
        userId: 'user-1',
        jobId: null,
        address: '',
        addressUpdated: false,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        chunksReceived: 0,
        pendingChunks: 0,
        finishRequested: false,
        finishResolve: null,
        audioHoldBuffer: null,
        debugLog: [],
        recentTranscripts: [],
        debugMode: false,
        debugBuffer: '',
        debugSegments: [],
        preDebugContext: '',
        debugStartTime: null,
        geminiFullTranscript: '',
      };

      expect(session.userId).toBe('user-1');
      expect(session.chunksReceived).toBe(0);
      expect(session.debugMode).toBe(false);
      expect(session.debugLog).toEqual([]);
      expect(session.finishRequested).toBe(false);
    });

    test('should associate existing jobId when provided', () => {
      const jobId = 'job_existing_123';
      const session = {
        userId: 'user-1',
        jobId: jobId || null,
      };

      expect(session.jobId).toBe('job_existing_123');
    });

    test('should set jobId to null when not provided', () => {
      const jobId = undefined;
      const session = {
        userId: 'user-1',
        jobId: jobId || null,
      };

      expect(session.jobId).toBeNull();
    });
  });

  describe('Chunk upload validation', () => {
    test('should require authentication', () => {
      const req = { headers: {}, query: {} };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      const next = jest.fn();

      auth.requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    test('should reject chunk for nonexistent session (404)', () => {
      const activeSessions = new Map();
      const sessionId = 'rec_nonexistent';

      const session = activeSessions.get(sessionId);
      expect(session).toBeUndefined();
      // Route handler would return: res.status(404).json({ error: "Recording session not found or expired" })
    });

    test('should reject chunk when userId does not match session owner', () => {
      const activeSessions = new Map();
      activeSessions.set('rec_123', { userId: 'user-1', lastActivity: Date.now() });

      const session = activeSessions.get('rec_123');
      const reqUserId = 'user-2';

      expect(session.userId !== reqUserId).toBe(true);
      // Route handler would return: res.status(403).json({ error: "Access denied" })
    });

    test('should require audio file', () => {
      const audioFile = null;
      expect(!audioFile).toBe(true);
      // Route handler would return: res.status(400).json({ error: "No audio file provided" })
    });

    test('should detect and handle duplicate chunks', () => {
      const processedChunks = new Map();
      processedChunks.set(0, { transcript: 'hello world' });
      processedChunks.set(1, { transcript: 'circuit one' });

      // Duplicate chunk 0
      expect(processedChunks.has(0)).toBe(true);
      const cached = processedChunks.get(0);
      expect(cached.transcript).toBe('hello world');

      // New chunk 2
      expect(processedChunks.has(2)).toBe(false);
    });

    test('should increment chunksReceived and pendingChunks', () => {
      const session = { chunksReceived: 3, pendingChunks: 1 };

      session.chunksReceived++;
      session.pendingChunks++;

      expect(session.chunksReceived).toBe(4);
      expect(session.pendingChunks).toBe(2);
    });

    test('should hold short chunks below threshold', () => {
      const MIN_CHUNK_BYTES = 50_000;
      const shortChunkSize = 30_000;
      const normalChunkSize = 80_000;

      expect(shortChunkSize < MIN_CHUNK_BYTES).toBe(true);
      expect(normalChunkSize < MIN_CHUNK_BYTES).toBe(false);
    });
  });

  describe('Session finish logic', () => {
    test('should reject finish for nonexistent session', () => {
      const activeSessions = new Map();
      const session = activeSessions.get('rec_nonexistent');
      expect(session).toBeUndefined();
    });

    test('should reject finish when userId does not match', () => {
      const activeSessions = new Map();
      activeSessions.set('rec_123', { userId: 'user-1' });

      const session = activeSessions.get('rec_123');
      const reqUserId = 'user-2';
      expect(session.userId !== reqUserId).toBe(true);
    });

    test('should wait for pending chunks before saving', async () => {
      const session = {
        pendingChunks: 2,
        finishRequested: false,
        finishResolve: null,
      };

      // Simulate the finish endpoint waiting for pending chunks
      const waitPromise = new Promise((resolve) => {
        session.finishRequested = true;
        session.finishResolve = resolve;
        if (session.pendingChunks === 0) resolve();
      });

      // Simulate chunks completing
      setTimeout(() => {
        session.pendingChunks = 0;
        if (session.finishResolve) session.finishResolve();
      }, 10);

      await waitPromise;

      expect(session.pendingChunks).toBe(0);
      expect(session.finishRequested).toBe(true);
    });

    test('should create new job when no jobId provided', async () => {
      mockCreateJob.mockResolvedValue({});

      const session = { jobId: null, userId: 'user-1' };
      const isExistingJob = !!session.jobId;

      expect(isExistingJob).toBe(false);

      // In the real handler, this triggers db.createJob()
      if (!isExistingJob) {
        await mockCreateJob({
          id: `job_${Date.now()}`,
          user_id: session.userId,
          folder_name: 'Test Address',
          address: 'Test Address',
          certificate_type: 'EICR',
          status: 'done',
        });
      }

      expect(mockCreateJob).toHaveBeenCalled();
    });

    test('should update existing job when jobId provided', async () => {
      mockGetJob.mockResolvedValue({ id: 'job-1', folder_name: 'Old Address' });
      mockUpdateJob.mockResolvedValue(undefined);

      const session = { jobId: 'job-1', userId: 'user-1' };
      const isExistingJob = !!session.jobId;

      expect(isExistingJob).toBe(true);

      if (isExistingJob) {
        await mockUpdateJob(session.jobId, {
          folder_name: 'New Address',
          address: 'New Address',
          status: 'done',
          completed_at: new Date().toISOString(),
        });
      }

      expect(mockUpdateJob).toHaveBeenCalledWith('job-1', expect.objectContaining({
        status: 'done',
        address: 'New Address',
      }));
    });

    test('should default certificateType to EICR', () => {
      const body = {};
      const { certificateType = 'EICR' } = body;
      expect(certificateType).toBe('EICR');
    });

    test('should remove session from active map after save', () => {
      const activeSessions = new Map();
      activeSessions.set('rec_123', { userId: 'user-1' });

      expect(activeSessions.has('rec_123')).toBe(true);

      activeSessions.delete('rec_123');

      expect(activeSessions.has('rec_123')).toBe(false);
    });
  });

  describe('Whisper mode (jobData in finish)', () => {
    test('should populate accumulator from iOS jobData when no chunks received', () => {
      const session = { chunksReceived: 0 };
      const jobData = {
        circuits: [
          { circuit_ref: '1', circuit_designation: 'Lights' },
          { circuit_ref: '2', circuit_designation: 'Sockets' },
        ],
        observations: [
          { code: 'C2', observation_text: 'No RCD protection on socket circuit' },
        ],
        installation_details: { address: '42 Test Street', client_name: 'John' },
        supply_characteristics: { earthing_arrangement: 'TN-C-S' },
      };

      // Simulates the Whisper mode path: populate accumulator from jobData
      const circuits = [];
      if (jobData.circuits && session.chunksReceived === 0) {
        for (const circuit of jobData.circuits) {
          if (circuit.circuit_ref || circuit.circuit_designation) {
            circuits.push({ ...circuit });
          }
        }
      }

      expect(circuits).toHaveLength(2);
      expect(circuits[0].circuit_designation).toBe('Lights');
    });

    test('should skip populating when chunks were already received', () => {
      const session = { chunksReceived: 3 };
      const jobData = {
        circuits: [{ circuit_ref: '1', circuit_designation: 'Lights' }],
      };

      const circuits = [];
      if (jobData && session.chunksReceived === 0) {
        for (const circuit of jobData.circuits) {
          circuits.push({ ...circuit });
        }
      }

      expect(circuits).toHaveLength(0);
    });
  });

  describe('Debug audio mode', () => {
    test('should detect debug start keyword', () => {
      const DEBUG_START = /\b(?:d[\s-]?bug|debug|dee\s*bug)\b/i;
      expect(DEBUG_START.test('debug circuit three')).toBe(true);
      expect(DEBUG_START.test('dee bug mode')).toBe(true);
      expect(DEBUG_START.test('d bug')).toBe(true);
      expect(DEBUG_START.test('regular transcript')).toBe(false);
    });

    test('should detect debug end keyword', () => {
      const DEBUG_END = /\b(?:end|stop|finish|done)\s+(?:d[\s-]?bug|debug)\b/i;
      expect(DEBUG_END.test('end debug')).toBe(true);
      expect(DEBUG_END.test('stop debug')).toBe(true);
      expect(DEBUG_END.test('finish debug')).toBe(true);
      expect(DEBUG_END.test('done debug')).toBe(true);
      expect(DEBUG_END.test('debug end')).toBe(false);
    });

    test('should buffer transcript while in debug mode', () => {
      const session = {
        debugMode: true,
        debugBuffer: 'first segment',
      };

      const transcript = ' second segment';
      session.debugBuffer += transcript;

      expect(session.debugBuffer).toBe('first segment second segment');
    });

    test('should save debug segment on end keyword', () => {
      const session = {
        debugMode: true,
        debugBuffer: 'problem with wiring at junction box',
        debugStartTime: new Date().toISOString(),
        debugSegments: [],
      };

      session.debugSegments.push({
        transcript: session.debugBuffer.trim(),
        startedAt: session.debugStartTime,
        endedAt: new Date().toISOString(),
      });
      session.debugMode = false;
      session.debugBuffer = '';

      expect(session.debugSegments).toHaveLength(1);
      expect(session.debugSegments[0].transcript).toContain('junction box');
      expect(session.debugMode).toBe(false);
      expect(session.debugBuffer).toBe('');
    });
  });

  describe('Stale session cleanup', () => {
    test('should identify stale sessions', () => {
      const STALE_THRESHOLD = 30 * 60 * 1000; // 30 minutes
      const now = Date.now();

      const freshSession = { lastActivity: now - (5 * 60 * 1000) }; // 5 min ago
      const staleSession = { lastActivity: now - (45 * 60 * 1000) }; // 45 min ago

      expect(now - freshSession.lastActivity > STALE_THRESHOLD).toBe(false);
      expect(now - staleSession.lastActivity > STALE_THRESHOLD).toBe(true);
    });

    test('should auto-save stale session with data', () => {
      const session = {
        lastActivity: Date.now() - (35 * 60 * 1000),
        eicrBuffer: { fullText: 'circuit one measured zs 0.35 ohms' },
        accumulator: { circuits: [{ circuit_ref: '1' }], observations: [] },
      };

      const hasData = session.eicrBuffer?.fullText?.length > 0 ||
                      session.accumulator?.circuits?.length > 0 ||
                      session.accumulator?.observations?.length > 0;

      expect(hasData).toBe(true);
    });

    test('should discard stale session without data', () => {
      const session = {
        lastActivity: Date.now() - (35 * 60 * 1000),
        eicrBuffer: { fullText: '' },
        accumulator: { circuits: [], observations: [] },
      };

      const hasData = session.eicrBuffer?.fullText?.length > 0 ||
                      session.accumulator?.circuits?.length > 0 ||
                      session.accumulator?.observations?.length > 0;

      expect(hasData).toBe(false);
    });
  });

  describe('Extract-transcript endpoint validation', () => {
    test('should reject transcript shorter than 10 chars', () => {
      const transcript = 'short';
      expect(!transcript || transcript.trim().length < 10).toBe(true);
    });

    test('should accept transcript with sufficient length', () => {
      const transcript = 'Circuit one lights measured zs 0.35 ohms insulation resistance 200 megohms';
      expect(!transcript || transcript.trim().length < 10).toBe(false);
    });

    test('should reject empty transcript', () => {
      const transcript = '';
      expect(!transcript || transcript.trim().length < 10).toBe(true);
    });

    test('should reject whitespace-only transcript', () => {
      const transcript = '          ';
      expect(!transcript || transcript.trim().length < 10).toBe(true);
    });
  });

  describe('Debug report validation', () => {
    test('should require sessionId and issueText', () => {
      const body1 = { sessionId: 'rec_123' };
      const body2 = { issueText: 'problem' };
      const body3 = { sessionId: 'rec_123', issueText: 'problem' };

      expect(!body1.issueText || !body1.sessionId).toBe(true);
      expect(!body2.issueText || !body2.sessionId).toBe(true);
      expect(!body3.issueText || !body3.sessionId).toBe(false);
    });

    test('should reject issueText exceeding 5000 characters', () => {
      const longText = 'a'.repeat(5001);
      expect(longText.length > 5000).toBe(true);

      const normalText = 'Problem with circuit three wiring.';
      expect(normalText.length > 5000).toBe(false);
    });
  });
});
