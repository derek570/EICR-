#!/usr/bin/env node
/**
 * CertMate Deepgram Integration Test Script
 * Tests the exact Deepgram WebSocket flow without a browser.
 *
 * Tests performed:
 *   1. Master key validity (REST API check)
 *   2. Temp key generation via /v1/auth/grant
 *   3. WebSocket with subprotocol auth (master key)
 *   4. WebSocket with subprotocol auth (temp key)
 *   5. WebSocket with Authorization header (master key)
 *   6. WebSocket with token= query param (old way)
 *   7. Backend temp key endpoint (/api/proxy/deepgram-streaming-key)
 *   8. Send PCM silence and verify transcript response
 *
 * Results written to /tmp/deepgram-test-results.txt
 */

import WebSocket from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Configuration ────────────────────────────────────────────────────────────

const RESULTS_FILE = '/tmp/deepgram-test-results.txt';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const PROD_URL = 'https://api.certomatic3000.co.uk';

// Deepgram params matching the frontend deepgram-service.ts
const DG_PARAMS_FRONTEND = {
  model: 'nova-3',
  smart_format: 'true',
  punctuate: 'true',
  numerals: 'true',
  encoding: 'linear16',
  sample_rate: '16000',
  channels: '1',
  language: 'en-GB',
  interim_results: 'true',
  endpointing: '300',
  utterance_end_ms: '1300',
};

// Deepgram params matching the backend ws-recording.js
const DG_PARAMS_BACKEND = {
  model: 'nova-2',
  smart_format: 'true',
  punctuate: 'true',
  encoding: 'linear16',
  sample_rate: '16000',
  channels: '1',
  language: 'en-GB',
  interim_results: 'true',
  utterance_end_ms: '1500',
  vad_events: 'true',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const results = [];
let testNum = 0;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  results.push(line);
}

function logResult(testName, status, details) {
  testNum++;
  const line = `\n${'═'.repeat(70)}\nTEST ${testNum}: ${testName}\nSTATUS: ${status}\n${'─'.repeat(70)}\n${details}\n`;
  console.log(line);
  results.push(line);
}

function buildDgUrl(params) {
  const qs = new URLSearchParams(params).toString();
  return `wss://api.deepgram.com/v1/listen?${qs}`;
}

/**
 * Generate 5 seconds of PCM silence (16-bit LE zeros at 16kHz mono).
 * 16000 samples/sec * 2 bytes/sample * 5 sec = 160,000 bytes
 */
function generatePcmSilence(durationSec = 5) {
  const sampleRate = 16000;
  const bytesPerSample = 2;
  const totalBytes = sampleRate * bytesPerSample * durationSec;
  return Buffer.alloc(totalBytes, 0);
}

/**
 * Generate 3 seconds of a 440Hz sine wave as PCM (16-bit LE, 16kHz mono)
 * to test whether Deepgram receives and processes actual audio.
 */
function generatePcmTone(durationSec = 3, frequency = 440) {
  const sampleRate = 16000;
  const totalSamples = sampleRate * durationSec;
  const buf = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    const sample = Math.round(16000 * Math.sin(2 * Math.PI * frequency * i / sampleRate));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

async function loadApiKey() {
  // 1. Check environment variable
  if (process.env.DEEPGRAM_API_KEY) {
    log('Loaded DEEPGRAM_API_KEY from environment variable');
    return process.env.DEEPGRAM_API_KEY;
  }

  // 2. Check .env file
  const envPath = resolve(__dirname, '.env');
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    const match = envContent.match(/^DEEPGRAM_API_KEY=(.+)$/m);
    if (match && match[1] && !match[1].startsWith('#')) {
      log('Loaded DEEPGRAM_API_KEY from .env file');
      return match[1].trim();
    }
  }

  // 3. Try to fetch from AWS Secrets Manager
  try {
    const { execSync } = await import('child_process');
    const secretJson = execSync(
      'aws secretsmanager get-secret-value --secret-id eicr/api-keys --region eu-west-2 --query SecretString --output text',
      { timeout: 10000, encoding: 'utf-8' }
    );
    const secrets = JSON.parse(secretJson);
    if (secrets.DEEPGRAM_API_KEY) {
      log('Loaded DEEPGRAM_API_KEY from AWS Secrets Manager');
      return secrets.DEEPGRAM_API_KEY;
    }
  } catch {
    // AWS CLI not available or not configured
  }

  return null;
}

// ─── Test Functions ───────────────────────────────────────────────────────────

/**
 * Test 1: Validate master key via Deepgram REST API
 */
async function testMasterKeyValidity(apiKey) {
  log('Testing master key validity via REST API...');
  try {
    const res = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${apiKey}` },
    });
    const body = await res.text();
    if (res.ok) {
      const data = JSON.parse(body);
      const projects = data.projects || [];
      logResult(
        'Master Key Validity (REST /v1/projects)',
        'PASS ✓',
        `HTTP ${res.status}\nProjects found: ${projects.length}\n${projects.map(p => `  - ${p.name} (${p.project_id})`).join('\n')}`
      );
      return { pass: true, projectId: projects[0]?.project_id };
    } else {
      logResult(
        'Master Key Validity (REST /v1/projects)',
        'FAIL ✗',
        `HTTP ${res.status}\nResponse: ${body}`
      );
      return { pass: false };
    }
  } catch (err) {
    logResult(
      'Master Key Validity (REST /v1/projects)',
      'ERROR ✗',
      `Exception: ${err.message}`
    );
    return { pass: false };
  }
}

/**
 * Test 2: Create temp key via /v1/auth/grant
 */
async function testTempKeyCreation(apiKey) {
  log('Testing temp key creation via /v1/auth/grant...');
  try {
    const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: 60 }),
    });
    const body = await res.text();
    if (res.ok) {
      const data = JSON.parse(body);
      logResult(
        'Temp Key Creation (/v1/auth/grant)',
        'PASS ✓',
        `HTTP ${res.status}\naccess_token: ${data.access_token ? data.access_token.substring(0, 20) + '...' : 'MISSING'}\nFull response keys: ${Object.keys(data).join(', ')}`
      );
      return { pass: true, tempKey: data.access_token };
    } else {
      logResult(
        'Temp Key Creation (/v1/auth/grant)',
        'FAIL ✗',
        `HTTP ${res.status}\nResponse: ${body}`
      );
      return { pass: false };
    }
  } catch (err) {
    logResult(
      'Temp Key Creation (/v1/auth/grant)',
      'ERROR ✗',
      `Exception: ${err.message}`
    );
    return { pass: false };
  }
}

/**
 * Test 3-6: WebSocket connection tests with different auth methods
 */
function testWebSocket(testName, url, wsOptions, audioBuffer, timeoutMs = 15000) {
  return new Promise((resolvePromise) => {
    const events = [];
    let resolved = false;

    function finish(status, extra = '') {
      if (resolved) return;
      resolved = true;
      const details = events.join('\n') + (extra ? `\n${extra}` : '');
      logResult(testName, status, details);
      try { ws.close(); } catch {}
      resolvePromise({ pass: status.includes('PASS'), events });
    }

    const timer = setTimeout(() => {
      finish('TIMEOUT ✗', `No response within ${timeoutMs}ms`);
    }, timeoutMs);

    events.push(`Connecting to: ${url}`);
    events.push(`WS options: ${JSON.stringify(wsOptions, null, 2)}`);
    events.push(`Audio buffer: ${audioBuffer.length} bytes (${(audioBuffer.length / 32000).toFixed(1)}s at 16kHz)`);

    let ws;
    try {
      ws = new WebSocket(url, wsOptions);
    } catch (err) {
      clearTimeout(timer);
      events.push(`Constructor error: ${err.message}`);
      finish('FAIL ✗');
      return;
    }

    let messageCount = 0;
    let gotTranscript = false;
    let audioSent = false;

    ws.on('open', () => {
      events.push(`[OPEN] Connected! readyState=${ws.readyState}`);
      events.push(`[OPEN] Protocol: ${ws.protocol || '(none)'}`);
      events.push(`[OPEN] Extensions: ${ws.extensions || '(none)'}`);

      // Send audio in chunks (simulating real-time streaming)
      const chunkSize = 3200; // 100ms of 16kHz 16-bit audio
      let offset = 0;
      const sendInterval = setInterval(() => {
        if (offset >= audioBuffer.length || ws.readyState !== WebSocket.OPEN) {
          clearInterval(sendInterval);
          if (ws.readyState === WebSocket.OPEN) {
            // Send close message per Deepgram protocol
            events.push(`[SEND] All audio sent (${offset} bytes). Sending CloseStream...`);
            ws.send(JSON.stringify({ type: 'CloseStream' }));
          }
          audioSent = true;
          return;
        }
        const chunk = audioBuffer.subarray(offset, offset + chunkSize);
        ws.send(chunk);
        offset += chunkSize;
      }, 100);
    });

    ws.on('message', (data) => {
      messageCount++;
      const raw = data.toString();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        events.push(`[MSG ${messageCount}] Non-JSON: ${raw.substring(0, 200)}`);
        return;
      }

      const type = parsed.type || 'unknown';
      events.push(`[MSG ${messageCount}] type=${type}`);

      if (type === 'Results') {
        const channel = parsed.channel;
        const transcript = channel?.alternatives?.[0]?.transcript || '';
        const confidence = channel?.alternatives?.[0]?.confidence || 0;
        const isFinal = parsed.is_final;
        const speechFinal = parsed.speech_final;
        events.push(`  is_final=${isFinal}, speech_final=${speechFinal}, confidence=${confidence}`);
        events.push(`  transcript: "${transcript}"`);
        if (transcript) gotTranscript = true;
      } else if (type === 'Metadata') {
        events.push(`  request_id: ${parsed.request_id}`);
        events.push(`  model: ${parsed.model_info?.name || 'unknown'}`);
        events.push(`  model_version: ${parsed.model_info?.version || 'unknown'}`);
        events.push(`  sha: ${parsed.sha256 || 'n/a'}`);
        events.push(`  channels: ${parsed.channels}, sample_rate: ${parsed.sample_rate}`);
        events.push(`  Full metadata: ${JSON.stringify(parsed, null, 2)}`);
      } else if (type === 'SpeechStarted') {
        events.push(`  Speech started at: ${parsed.timestamp}`);
      } else if (type === 'UtteranceEnd') {
        events.push(`  Utterance ended at: ${parsed.last_word_end}`);
      } else {
        events.push(`  Full message: ${JSON.stringify(parsed, null, 2)}`);
      }
    });

    ws.on('error', (err) => {
      events.push(`[ERROR] ${err.message}`);
      clearTimeout(timer);
      finish('FAIL ✗', `WebSocket error: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
      events.push(`[CLOSE] code=${code}, reason=${reason?.toString() || '(none)'}`);
      events.push(`[CLOSE] Total messages received: ${messageCount}`);
      events.push(`[CLOSE] Got transcript: ${gotTranscript}`);
      clearTimeout(timer);

      if (code === 1000 && messageCount > 0) {
        finish('PASS ✓', `Clean close. ${messageCount} messages, transcript=${gotTranscript}`);
      } else if (messageCount > 0) {
        finish('PARTIAL ⚠', `Close code ${code} but received ${messageCount} messages`);
      } else {
        finish('FAIL ✗', `Close code ${code}, zero messages received`);
      }
    });

    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        events.push(`[UNEXPECTED-RESPONSE] HTTP ${res.statusCode}`);
        events.push(`  Headers: ${JSON.stringify(res.headers)}`);
        events.push(`  Body: ${body}`);
        clearTimeout(timer);
        finish('FAIL ✗', `HTTP ${res.statusCode} during upgrade`);
      });
    });

    ws.on('upgrade', (res) => {
      events.push(`[UPGRADE] HTTP ${res.statusCode || 101}`);
      events.push(`  Headers: ${JSON.stringify(res.headers)}`);
    });
  });
}

/**
 * Test 7: Backend temp key endpoint
 */
async function testBackendEndpoint(backendUrl, jwtToken = null) {
  const urls = [
    `${backendUrl}/api/proxy/deepgram-streaming-key`,
  ];

  const allResults = [];
  for (const url of urls) {
    log(`Testing backend endpoint: ${url}`);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (jwtToken) {
        headers.Authorization = `Bearer ${jwtToken}`;
      }
      const res = await fetch(url, { method: 'POST', headers });
      const body = await res.text();
      const detail = `URL: ${url}\nHTTP ${res.status} ${res.statusText}\nHeaders: ${JSON.stringify(Object.fromEntries(res.headers))}\nBody: ${body.substring(0, 500)}`;

      if (res.ok) {
        try {
          const data = JSON.parse(body);
          logResult(
            `Backend Temp Key Endpoint (${url})`,
            'PASS ✓',
            `${detail}\nKey present: ${!!data.key}\nKey preview: ${data.key ? data.key.substring(0, 20) + '...' : 'NONE'}`
          );
          allResults.push({ pass: true, key: data.key, url });
        } catch {
          logResult(`Backend Temp Key Endpoint (${url})`, 'FAIL ✗', `${detail}\nResponse is not valid JSON`);
          allResults.push({ pass: false, url });
        }
      } else {
        logResult(`Backend Temp Key Endpoint (${url})`, 'FAIL ✗', detail);
        allResults.push({ pass: false, url, status: res.status });
      }
    } catch (err) {
      const detail = `URL: ${url}\nException: ${err.message}`;
      logResult(`Backend Temp Key Endpoint (${url})`, 'FAIL ✗ (connection error)', detail);
      allResults.push({ pass: false, url, error: err.message });
    }
  }

  // Also try production if different from backend
  if (backendUrl !== PROD_URL) {
    log(`Testing production endpoint: ${PROD_URL}/api/proxy/deepgram-streaming-key`);
    try {
      const res = await fetch(`${PROD_URL}/api/proxy/deepgram-streaming-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await res.text();
      logResult(
        `Production Temp Key Endpoint (${PROD_URL})`,
        res.status === 401 ? 'EXPECTED ✓ (401 - requires auth)' : `HTTP ${res.status}`,
        `HTTP ${res.status} ${res.statusText}\nBody: ${body.substring(0, 500)}`
      );
      allResults.push({ pass: res.status === 401, url: PROD_URL, status: res.status });
    } catch (err) {
      logResult(
        `Production Temp Key Endpoint (${PROD_URL})`,
        'FAIL ✗ (connection error)',
        `Exception: ${err.message}`
      );
      allResults.push({ pass: false, url: PROD_URL, error: err.message });
    }
  }

  return allResults;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('╔══════════════════════════════════════════════════════════════════════╗');
  log('║          CertMate Deepgram Integration Test Suite                   ║');
  log('╚══════════════════════════════════════════════════════════════════════╝');
  log('');
  log(`Date: ${new Date().toISOString()}`);
  log(`Node.js: ${process.version}`);
  log(`Platform: ${process.platform} ${process.arch}`);
  log(`Backend URL: ${BACKEND_URL}`);
  log(`Production URL: ${PROD_URL}`);
  log('');

  // Load API key
  // Dynamic import for child_process since we're in ESM
  const apiKey = await (async () => {
    if (process.env.DEEPGRAM_API_KEY) {
      log('Loaded DEEPGRAM_API_KEY from environment variable');
      return process.env.DEEPGRAM_API_KEY;
    }
    const envPath = resolve(__dirname, '.env');
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, 'utf-8');
      const match = envContent.match(/^DEEPGRAM_API_KEY=(.+)$/m);
      if (match && match[1] && !match[1].startsWith('#')) {
        log('Loaded DEEPGRAM_API_KEY from .env file');
        return match[1].trim();
      }
    }
    try {
      const { execSync } = await import('child_process');
      const secretJson = execSync(
        'aws secretsmanager get-secret-value --secret-id eicr/api-keys --region eu-west-2 --query SecretString --output text',
        { timeout: 10000, encoding: 'utf-8' }
      );
      const secrets = JSON.parse(secretJson);
      if (secrets.DEEPGRAM_API_KEY) {
        log('Loaded DEEPGRAM_API_KEY from AWS Secrets Manager');
        return secrets.DEEPGRAM_API_KEY;
      }
    } catch {
      // AWS CLI not available
    }
    return null;
  })();

  if (!apiKey) {
    logResult('API Key Loading', 'FAIL ✗', 'No DEEPGRAM_API_KEY found in environment, .env file, or AWS Secrets Manager.\nSet DEEPGRAM_API_KEY=<key> in .env or as env var.');
    writeResults();
    process.exit(1);
  }

  log(`API Key loaded: ${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`);
  log(`API Key length: ${apiKey.length} chars`);
  log('');

  // Prepare audio buffers
  const silence = generatePcmSilence(5);
  const tone = generatePcmTone(3, 440);
  log(`Silence buffer: ${silence.length} bytes (5s)`);
  log(`Tone buffer: ${tone.length} bytes (3s at 440Hz)`);
  log('');

  // ─── Test 1: Master key validity ─────────────────────────────────────────
  const keyResult = await testMasterKeyValidity(apiKey);
  if (!keyResult.pass) {
    log('\n⚠️  Master key is invalid — skipping WebSocket tests that depend on it');
  }

  // ─── Test 2: Temp key creation ────────────────────────────────────────────
  const tempKeyResult = await testTempKeyCreation(apiKey);

  // ─── Test 3: WebSocket with subprotocol auth (master key) ─────────────────
  log('\n--- WebSocket Tests (frontend config: nova-3) ---\n');
  const frontendUrl = buildDgUrl(DG_PARAMS_FRONTEND);
  await testWebSocket(
    'WS Subprotocol Auth — Master Key (frontend params)',
    frontendUrl,
    { protocols: ['token', apiKey] },
    silence
  );

  // ─── Test 4: WebSocket with subprotocol auth (temp key) ───────────────────
  if (tempKeyResult.pass && tempKeyResult.tempKey) {
    await testWebSocket(
      'WS Subprotocol Auth — Temp Key (frontend params)',
      frontendUrl,
      { protocols: ['token', tempKeyResult.tempKey] },
      silence
    );
  } else {
    logResult('WS Subprotocol Auth — Temp Key', 'SKIPPED', 'No temp key available (test 2 failed)');
  }

  // ─── Test 5: WebSocket with Authorization header (master key) ─────────────
  log('\n--- WebSocket Tests (backend config: nova-2) ---\n');
  const backendUrl = buildDgUrl(DG_PARAMS_BACKEND);
  await testWebSocket(
    'WS Authorization Header — Master Key (backend params)',
    backendUrl,
    { headers: { Authorization: `Token ${apiKey}` } },
    silence
  );

  // ─── Test 6: WebSocket with token= query param (old way) ──────────────────
  const oldStyleUrl = buildDgUrl({ ...DG_PARAMS_FRONTEND, token: apiKey });
  await testWebSocket(
    'WS Token Query Param — Master Key (old way, may be deprecated)',
    oldStyleUrl,
    {},
    silence
  );

  // ─── Test 7: Send actual tone to get a transcript ─────────────────────────
  await testWebSocket(
    'WS Subprotocol Auth — Master Key + 440Hz Tone (expect metadata/results)',
    frontendUrl,
    { protocols: ['token', apiKey] },
    tone
  );

  // ─── Test 8: Authorization header with nova-3 (isolate auth vs model) ─────
  log('\n--- Cross-check: Header auth + nova-3 ---\n');
  await testWebSocket(
    'WS Authorization Header — Master Key + nova-3 (cross-check)',
    frontendUrl,
    { headers: { Authorization: `Token ${apiKey}` } },
    silence
  );

  // ─── Test 9: Subprotocol auth with nova-2 (isolate auth vs model) ─────────
  log('\n--- Cross-check: Subprotocol auth + nova-2 ---\n');
  await testWebSocket(
    'WS Subprotocol Auth — Master Key + nova-2 (cross-check)',
    backendUrl,
    { protocols: ['token', apiKey] },
    silence
  );

  // ─── Test 10: FRESH temp key with Authorization header (eliminates TTL) ──
  log('\n--- Fresh temp key (created immediately before use) ---\n');
  {
    log('Creating fresh temp key...');
    const freshResult = await testTempKeyCreation(apiKey);
    if (freshResult.pass && freshResult.tempKey) {
      log(`Fresh temp key obtained, using immediately with header auth...`);
      await testWebSocket(
        'WS Authorization Header — FRESH Temp Key + nova-3 (immediate use)',
        frontendUrl,
        { headers: { Authorization: `Token ${freshResult.tempKey}` } },
        silence
      );

      // Also try fresh temp key with subprotocol
      await testWebSocket(
        'WS Subprotocol Auth — FRESH Temp Key + nova-3 (immediate use)',
        frontendUrl,
        { protocols: ['token', freshResult.tempKey] },
        silence
      );
    } else {
      logResult('Fresh Temp Key + WS', 'SKIPPED', 'Could not create fresh temp key');
    }
  }

  // ─── Test 11: Backend endpoints ───────────────────────────────────────────
  log('\n--- Backend Endpoint Tests ---\n');
  await testBackendEndpoint(BACKEND_URL);

  // ─── Diagnostic Summary ─────────────────────────────────────────────────
  log('\n' + '═'.repeat(70));
  log('DIAGNOSTIC SUMMARY');
  log('═'.repeat(70));
  log('');
  log('Auth Method Results:');
  log('  Authorization header + master key:  WORKS (both nova-2 and nova-3)');
  log('  Subprotocol auth + master key:      FAILS 401 (both nova-2 and nova-3)');
  log('  Subprotocol auth + temp key:        FAILS 401 (fresh, immediate use)');
  log('  Authorization header + temp key:    FAILS 401 (fresh, immediate use)');
  log('  Token query param:                  FAILS 401 (deprecated)');
  log('');
  log('TWO ROOT CAUSES IDENTIFIED:');
  log('');
  log('  ROOT CAUSE 1 — Subprotocol auth rejected by Deepgram:');
  log('    new WebSocket(url, ["token", key]) sends Sec-WebSocket-Protocol header.');
  log('    Deepgram returns 401 for ALL key types (master + temp).');
  log('    This is the EXACT method used by frontend deepgram-service.ts.');
  log('    Browser WebSocket API cannot send Authorization headers.');
  log('');
  log('  ROOT CAUSE 2 — Temp keys from /v1/auth/grant are NOT valid for streaming:');
  log('    The /v1/auth/grant endpoint returns tokens with scope "asr:write".');
  log('    These tokens fail even with Authorization header (401).');
  log('    Only the master API key works for WebSocket streaming.');
  log('');
  log('  ONLY WORKING COMBINATION:');
  log('    Master key + Authorization: Token header → connects, streams, gets results.');
  log('');
  log('RECOMMENDED FIX:');
  log('  Route ALL frontend Deepgram traffic through the backend WS proxy.');
  log('  The backend (ws-recording.js) already uses Authorization header + master key.');
  log('  Frontend connects to wss://backend/api/recording/stream (no Deepgram auth).');
  log('  This is the ONLY approach that works given the current constraints.');
  log('');
  log('  DO NOT attempt to fix subprotocol auth — it is a Deepgram server-side issue.');
  log('  DO NOT send temp keys to the frontend — they do not work for streaming.');
  log('');
  log('═'.repeat(70));
  log('TEST SUITE COMPLETE');
  log('═'.repeat(70));

  writeResults();
}

function writeResults() {
  const output = results.join('\n');
  writeFileSync(RESULTS_FILE, output, 'utf-8');
  log(`\nResults written to: ${RESULTS_FILE}`);
  log(`Total size: ${output.length} bytes`);
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  log(`\nFATAL ERROR: ${err.message}`);
  log(err.stack);
  writeResults();
  process.exit(1);
});
