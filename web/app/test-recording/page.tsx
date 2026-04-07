'use client';

/**
 * Test Recording Harness — Standalone diagnostic page for testing
 * the audio capture → Deepgram transcription → Sonnet extraction pipeline.
 *
 * Accessible at /test-recording (no auth required for the page itself,
 * but the Deepgram key endpoint requires a valid auth token).
 *
 * Tests:
 *   1. Microphone permission & AudioContext creation
 *   2. Deepgram streaming key fetch via backend proxy
 *   3. WebSocket connection to Deepgram Nova-3
 *   4. Audio capture (AudioWorklet or ScriptProcessor fallback)
 *   5. Real-time transcription display
 *   6. Sonnet extraction via backend proxy (optional)
 */

import { useState, useRef, useCallback, useEffect } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface LogEntry {
  time: string;
  type: 'info' | 'error' | 'ws' | 'transcript' | 'sonnet';
  message: string;
}

function timestamp(): string {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

export default function TestRecordingPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [micStatus, setMicStatus] = useState<string>('Not requested');
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [captureMethod, setCaptureMethod] = useState<string>('—');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<string>('Disconnected');
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [chunkCount, setChunkCount] = useState<number>(0);
  const [transcript, setTranscript] = useState<string>('');
  const [isRunning, setIsRunning] = useState(false);
  const [transcriptCount, setTranscriptCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const chunkCountRef = useRef(0);
  const transcriptCountRef = useRef(0);

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    setLogs((prev) => [...prev.slice(-500), { time: timestamp(), type, message }]);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Resample Float32 audio from native sample rate to 16kHz Int16 PCM
  function resampleToInt16(float32: Float32Array, fromRate: number, toRate: number): Int16Array {
    const ratio = fromRate / toRate;
    const outLength = Math.floor(float32.length / ratio);
    const int16 = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcIdx = i * ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, float32.length - 1);
      const frac = srcIdx - lo;
      const sample = float32[lo] + frac * (float32[hi] - float32[lo]);
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }
    return int16;
  }

  const cleanup = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    if (wsRef.current) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        /* ignore */
      }
      wsRef.current.close(1000);
      wsRef.current = null;
    }
    workletRef.current?.disconnect();
    workletRef.current = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current = null;
    streamRef.current = null;
    setWsStatus('Disconnected');
    setAudioLevel(0);
    setIsRunning(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const runDiagnostic = useCallback(async () => {
    cleanup();
    setLogs([]);
    setTranscript('');
    setApiKey(null);
    setSampleRate(null);
    setCaptureMethod('—');
    setChunkCount(0);
    setTranscriptCount(0);
    chunkCountRef.current = 0;
    transcriptCountRef.current = 0;
    setIsRunning(true);

    // Step 1: Mic permission
    addLog('info', 'Step 1: Requesting microphone permission...');
    setMicStatus('Requesting...');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      const settings = track.getSettings();
      setMicStatus('Granted');
      addLog(
        'info',
        `Mic granted. Track: "${track.label}", sampleRate=${settings.sampleRate || 'default'}`
      );
    } catch (err) {
      setMicStatus(`Denied: ${err}`);
      addLog('error', `Mic denied: ${err}`);
      setIsRunning(false);
      return;
    }

    // Step 2: AudioContext
    addLog('info', 'Step 2: Creating AudioContext (target: 16kHz)...');
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = ctx;
      setSampleRate(ctx.sampleRate);
      addLog(
        'info',
        `AudioContext created. Actual sampleRate=${ctx.sampleRate}Hz, state=${ctx.state}`
      );
      if (ctx.state === 'suspended') {
        await ctx.resume();
        addLog('info', 'AudioContext was suspended — resumed OK');
      }
      if (ctx.sampleRate !== 16000) {
        addLog('info', `Browser gave ${ctx.sampleRate}Hz instead of 16kHz — will resample`);
      }
    } catch (err) {
      addLog('error', `AudioContext creation failed: ${err}`);
      setIsRunning(false);
      return;
    }

    // Step 3: Set up analyser for level meter
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyserRef.current = analyser;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.fftSize);
    const updateLevel = () => {
      analyser.getByteTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      setAudioLevel(Math.min(1, rms * 4));
      animFrameRef.current = requestAnimationFrame(updateLevel);
    };
    updateLevel();

    // Step 4: Fetch Deepgram key
    addLog('info', 'Step 3: Fetching Deepgram streaming key via backend proxy...');
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) {
      addLog('error', 'No auth token in localStorage. Log in at /login first.');
      setIsRunning(false);
      return;
    }

    let key: string;
    try {
      const resp = await fetch(`${API_BASE_URL}/api/proxy/deepgram-streaming-key`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text}`);
      }
      const data = await resp.json();
      key = data.key;
      if (!key) throw new Error('No key in response');
      setApiKey(key.slice(0, 12) + '...');
      addLog('info', `Key received (${key.length} chars)`);
    } catch (err) {
      addLog('error', `Key fetch FAILED: ${err}`);
      setIsRunning(false);
      return;
    }

    // Step 5: Set up audio capture (AudioWorklet or ScriptProcessor)
    addLog('info', 'Step 4: Setting up audio capture...');
    const actualRate = ctx.sampleRate;

    // Shared handler for audio chunks
    const sendAudioChunk = (float32: Float32Array) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const int16 =
        actualRate !== 16000
          ? resampleToInt16(float32, actualRate, 16000)
          : resampleToInt16(float32, actualRate, actualRate);
      wsRef.current.send(int16.buffer);
      chunkCountRef.current++;
      if (chunkCountRef.current % 50 === 0) {
        setChunkCount(chunkCountRef.current);
      }
    };

    try {
      // Try AudioWorklet first
      const processorCode = `
        class PCMProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0];
            if (input && input[0]) {
              const samples = new Float32Array(input[0]);
              this.port.postMessage(samples, [samples.buffer]);
            }
            return true;
          }
        }
        registerProcessor('test-pcm-processor', PCMProcessor);
      `;
      const blob = new Blob([processorCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const worklet = new AudioWorkletNode(ctx, 'test-pcm-processor');
      workletRef.current = worklet;
      worklet.port.onmessage = (event: MessageEvent) => {
        sendAudioChunk(event.data as Float32Array);
      };
      source.connect(worklet);
      setCaptureMethod('AudioWorklet');
      addLog('info', 'AudioWorklet capture active');
    } catch (err) {
      addLog('info', `AudioWorklet failed (${err}), using ScriptProcessor fallback`);
      // eslint-disable-next-line deprecation/deprecation
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        sendAudioChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(ctx.destination); // Required for onaudioprocess to fire
      setCaptureMethod('ScriptProcessor');
      addLog('info', 'ScriptProcessor capture active (fallback)');
    }

    // Step 6: Open Deepgram WebSocket
    addLog('ws', 'Step 5: Connecting to Deepgram Nova-3...');
    setWsStatus('Connecting...');

    const params = new URLSearchParams({
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
    });
    const wsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, ['token', key]);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
    } catch (err) {
      addLog('error', `WebSocket creation failed: ${err}`);
      setWsStatus('Failed');
      setIsRunning(false);
      return;
    }

    ws.onopen = () => {
      addLog('ws', 'WebSocket OPEN — streaming audio to Deepgram');
      setWsStatus('Connected');
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(event.data);
      } catch {
        return;
      }

      const type = json.type as string;
      if (type === 'Results') {
        const channel = json.channel as Record<string, unknown> | undefined;
        const alternatives = channel?.alternatives as Array<Record<string, unknown>> | undefined;
        const text = (alternatives?.[0]?.transcript as string) || '';
        const confidence = (alternatives?.[0]?.confidence as number) || 0;
        const isFinal = json.is_final as boolean;

        if (text) {
          transcriptCountRef.current++;
          setTranscriptCount(transcriptCountRef.current);
          const tag = isFinal ? 'FINAL' : 'INTERIM';
          addLog('transcript', `[${tag}] (${(confidence * 100).toFixed(1)}%) ${text}`);
          if (isFinal) {
            setTranscript((prev) => (prev ? prev + ' ' : '') + text);
          }
        }
      } else if (type === 'Metadata') {
        const info = json.model_info as Record<string, unknown> | undefined;
        addLog('ws', `Metadata: model=${info?.name || '?'}, request_id=${json.request_id}`);
      } else if (type === 'UtteranceEnd') {
        addLog('ws', 'UtteranceEnd');
      } else if (type === 'SpeechStarted') {
        addLog('ws', 'SpeechStarted');
      }
    };

    ws.onerror = () => {
      addLog('error', 'WebSocket ERROR');
      setWsStatus('Error');
    };

    ws.onclose = (event) => {
      const codeDesc: Record<number, string> = {
        1000: 'Normal',
        1001: 'Going Away',
        1006: 'Abnormal (no close frame)',
        1008: 'Policy Violation (auth?)',
        1011: 'Server Error',
      };
      addLog(
        'ws',
        `WebSocket CLOSED: code=${event.code} (${codeDesc[event.code] || 'Unknown'}), clean=${event.wasClean}`
      );
      setWsStatus(`Closed (${event.code})`);
      wsRef.current = null;
    };
  }, [addLog, cleanup]);

  const stopDiagnostic = useCallback(() => {
    addLog('info', 'Stopping...');
    setChunkCount(chunkCountRef.current);
    cleanup();
    if (transcriptCountRef.current > 0) {
      addLog(
        'info',
        `Pipeline WORKING: ${transcriptCountRef.current} transcripts, ${chunkCountRef.current} audio chunks sent`
      );
    } else if (chunkCountRef.current > 0) {
      addLog(
        'error',
        `BROKEN: Audio sent (${chunkCountRef.current} chunks) but no transcripts received`
      );
    } else {
      addLog('error', 'BROKEN: No audio chunks were sent');
    }
  }, [addLog, cleanup]);

  const logColors: Record<LogEntry['type'], string> = {
    info: '#94a3b8',
    error: '#f87171',
    ws: '#22d3ee',
    transcript: '#4ade80',
    sonnet: '#c084fc',
  };

  const statusColor = transcriptCount > 0 ? '#4ade80' : isRunning ? '#fbbf24' : '#64748b';

  return (
    <div
      style={{
        padding: 16,
        fontFamily: 'system-ui, monospace',
        maxWidth: 900,
        margin: '0 auto',
        color: '#e2e8f0',
        background: '#0f172a',
        minHeight: '100vh',
      }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
        CertMate Audio Pipeline Test Harness
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
        Tests: Mic → AudioCapture → Deepgram Nova-3 → Transcription. Use this to debug audio
        extraction issues.
      </p>

      {/* Status Banner */}
      <div
        style={{
          padding: 12,
          textAlign: 'center',
          fontSize: 18,
          fontWeight: 700,
          borderRadius: 8,
          marginBottom: 16,
          background: transcriptCount > 0 ? '#052e16' : isRunning ? '#422006' : '#1e293b',
          color: statusColor,
          border: `1px solid ${statusColor}33`,
        }}
      >
        {transcriptCount > 0 ? 'WORKING' : isRunning ? 'TESTING...' : 'IDLE'}
      </div>

      {/* Stats Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 8,
          marginBottom: 16,
          fontSize: 13,
        }}
      >
        {[
          {
            label: 'Mic',
            value: micStatus,
            color:
              micStatus === 'Granted'
                ? '#4ade80'
                : micStatus.startsWith('Denied')
                  ? '#f87171'
                  : '#94a3b8',
          },
          { label: 'Sample Rate', value: sampleRate ? `${sampleRate} Hz` : '—', color: '#94a3b8' },
          {
            label: 'Capture',
            value: captureMethod,
            color: captureMethod !== '—' ? '#4ade80' : '#94a3b8',
          },
          { label: 'API Key', value: apiKey || '—', color: apiKey ? '#4ade80' : '#94a3b8' },
          {
            label: 'WebSocket',
            value: wsStatus,
            color:
              wsStatus === 'Connected'
                ? '#4ade80'
                : wsStatus.includes('Error') || wsStatus.includes('Closed') || wsStatus === 'Failed'
                  ? '#f87171'
                  : '#fbbf24',
          },
          {
            label: 'Chunks Sent',
            value: String(chunkCount),
            color: chunkCount > 0 ? '#4ade80' : '#94a3b8',
          },
          {
            label: 'Transcripts',
            value: String(transcriptCount),
            color: transcriptCount > 0 ? '#4ade80' : '#94a3b8',
          },
        ].map((s) => (
          <div key={s.label} style={{ background: '#1e293b', padding: 10, borderRadius: 6 }}>
            <div style={{ color: '#64748b', fontSize: 11 }}>{s.label}</div>
            <div style={{ color: s.color, fontWeight: 600, fontFamily: 'monospace' }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* Audio Level */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Audio Level</div>
        <div style={{ background: '#1e293b', borderRadius: 4, height: 24, overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              width: `${audioLevel * 100}%`,
              background: audioLevel > 0.3 ? '#4ade80' : audioLevel > 0.1 ? '#fbbf24' : '#475569',
              transition: 'width 50ms, background 200ms',
            }}
          />
        </div>
      </div>

      {/* Controls */}
      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <button
          onClick={isRunning ? stopDiagnostic : runDiagnostic}
          style={{
            padding: '10px 24px',
            borderRadius: 8,
            border: 'none',
            background: isRunning ? '#dc2626' : '#16a34a',
            color: '#fff',
            fontWeight: 700,
            cursor: 'pointer',
            fontSize: 15,
          }}
        >
          {isRunning ? 'Stop' : 'Start Recording Test'}
        </button>
        <button
          onClick={() => {
            setLogs([]);
            setTranscript('');
          }}
          disabled={isRunning}
          style={{
            padding: '10px 16px',
            borderRadius: 8,
            border: '1px solid #334155',
            background: '#1e293b',
            color: '#94a3b8',
            cursor: isRunning ? 'not-allowed' : 'pointer',
            fontSize: 13,
          }}
        >
          Clear
        </button>
      </div>

      {/* Transcript */}
      {transcript && (
        <div
          style={{
            background: '#0f2418',
            border: '1px solid #16a34a33',
            padding: 12,
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          <div style={{ color: '#4ade80', fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
            TRANSCRIPT
          </div>
          {transcript}
        </div>
      )}

      {/* Event Log */}
      <div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
          Event Log ({logs.length})
        </div>
        <div
          style={{
            background: '#0f172a',
            border: '1px solid #1e293b',
            padding: 8,
            borderRadius: 8,
            maxHeight: 400,
            overflow: 'auto',
            fontSize: 12,
            fontFamily: "'SF Mono', 'Fira Code', monospace",
            lineHeight: 1.5,
          }}
        >
          {logs.length === 0 && (
            <div style={{ color: '#475569' }}>Press &quot;Start Recording Test&quot; to begin</div>
          )}
          {logs.map((log, i) => (
            <div key={i} style={{ marginBottom: 1 }}>
              <span style={{ color: '#475569' }}>{log.time}</span>{' '}
              <span style={{ color: logColors[log.type] }}>[{log.type.toUpperCase()}]</span>{' '}
              {log.message}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}
