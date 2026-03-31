'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface LogEntry {
  time: string;
  type: 'info' | 'error' | 'ws' | 'transcript';
  message: string;
}

function timestamp(): string {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

export default function TestRecordingPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [micStatus, setMicStatus] = useState<string>('Not requested');
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<string>('Disconnected');
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [transcript, setTranscript] = useState<string>('');
  const [isRunning, setIsRunning] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    setLogs((prev) => [...prev, { time: timestamp(), type, message }]);
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
    processorRef.current?.disconnect();
    analyserRef.current?.disconnect();
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current = null;
    streamRef.current = null;
    processorRef.current = null;
    analyserRef.current = null;
    setWsStatus('Disconnected');
    setAudioLevel(0);
    setIsRunning(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  const runDiagnostic = useCallback(async () => {
    cleanup();
    setLogs([]);
    setTranscript('');
    setApiKey(null);
    setSampleRate(null);
    setIsRunning(true);

    // Step 1: Mic permission
    addLog('info', 'Requesting microphone permission...');
    setMicStatus('Requesting...');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setMicStatus('Granted');
      addLog('info', `Mic granted. Tracks: ${stream.getAudioTracks().length}`);
    } catch (err) {
      setMicStatus(`Denied: ${err}`);
      addLog('error', `Mic denied: ${err}`);
      setIsRunning(false);
      return;
    }

    // Step 2: AudioContext
    addLog('info', 'Creating AudioContext...');
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
      audioContextRef.current = ctx;
      setSampleRate(ctx.sampleRate);
      addLog('info', `AudioContext created. Sample rate: ${ctx.sampleRate}Hz, state: ${ctx.state}`);
      if (ctx.state === 'suspended') {
        await ctx.resume();
        addLog('info', 'AudioContext resumed');
      }
    } catch (err) {
      addLog('error', `AudioContext failed: ${err}`);
      setIsRunning(false);
      return;
    }

    // Step 3: Set up analyser for level meter
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const updateLevel = () => {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      setAudioLevel(Math.round(sum / dataArray.length));
      animFrameRef.current = requestAnimationFrame(updateLevel);
    };
    updateLevel();
    addLog('info', 'Audio analyser connected — level meter active');

    // Step 4: Fetch temp key
    addLog('info', 'Fetching Deepgram streaming key...');
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) {
      addLog('error', 'No auth token in localStorage. Log in first.');
      setIsRunning(false);
      return;
    }

    let key: string;
    try {
      const resp = await fetch(`${API_BASE_URL}/api/proxy/deepgram-streaming-key`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`${resp.status}: ${text}`);
      }
      const data = await resp.json();
      key = data.key;
      if (!key) throw new Error('No key in response');
      setApiKey(key.slice(0, 12) + '...');
      addLog('info', `Key received (${key.length} chars, starts with ${key.slice(0, 8)}...)`);
    } catch (err) {
      addLog('error', `Key fetch failed: ${err}`);
      setIsRunning(false);
      return;
    }

    // Step 5: Open Deepgram WebSocket
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

    addLog('ws', `Connecting to ${wsUrl.slice(0, 60)}...`);
    setWsStatus('Connecting...');

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
      addLog('ws', 'WebSocket OPEN');
      setWsStatus('Connected');

      // Step 6: Start streaming audio
      addLog('info', `Starting audio stream (native ${ctx.sampleRate}Hz -> 16kHz Int16 PCM)`);
      const bufferSize = 4096;
      const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = resampleToInt16(float32, ctx.sampleRate, 16000);
        wsRef.current.send(int16.buffer);
      };

      source.connect(processor);
      processor.connect(ctx.destination);
      addLog('info', 'Audio processor connected — streaming to Deepgram');
    };

    ws.onmessage = (event) => {
      let data: string;
      if (typeof event.data === 'string') {
        data = event.data;
      } else {
        data = new TextDecoder().decode(event.data);
      }

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(data);
      } catch {
        addLog('ws', `Non-JSON message: ${data.slice(0, 100)}`);
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
          const tag = isFinal ? 'FINAL' : 'INTERIM';
          addLog('transcript', `[${tag}] (${(confidence * 100).toFixed(1)}%) ${text}`);
          if (isFinal) {
            setTranscript((prev) => (prev ? prev + ' ' : '') + text);
          }
        }
      } else if (type === 'UtteranceEnd') {
        addLog('ws', 'UtteranceEnd received');
      } else if (type === 'Metadata') {
        addLog('ws', `Metadata: request_id=${(json as Record<string, unknown>).request_id}`);
      } else if (type === 'Error') {
        addLog('error', `Deepgram error: ${JSON.stringify(json)}`);
      } else {
        addLog('ws', `Event: ${type} — ${data.slice(0, 120)}`);
      }
    };

    ws.onerror = () => {
      addLog('error', 'WebSocket ERROR event');
      setWsStatus('Error');
    };

    ws.onclose = (event) => {
      addLog(
        'ws',
        `WebSocket CLOSED: code=${event.code}, reason="${event.reason}", clean=${event.wasClean}`
      );
      setWsStatus(`Closed (${event.code})`);
      wsRef.current = null;
    };
  }, [addLog, cleanup]);

  const stopDiagnostic = useCallback(() => {
    addLog('info', 'Stopping diagnostic...');
    cleanup();
    addLog('info', 'Stopped.');
  }, [addLog, cleanup]);

  const logColors: Record<LogEntry['type'], string> = {
    info: '#8b8b8b',
    error: '#ff6b6b',
    ws: '#4ecdc4',
    transcript: '#ffe66d',
  };

  return (
    <div
      style={{
        padding: 20,
        fontFamily: 'monospace',
        maxWidth: 800,
        margin: '0 auto',
        color: '#e0e0e0',
        background: '#0a0a0a',
        minHeight: '100vh',
      }}
    >
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Deepgram Recording Diagnostic</h1>

      {/* Status Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
          marginBottom: 16,
          fontSize: 13,
        }}
      >
        <div style={{ background: '#1a1a1a', padding: 10, borderRadius: 6 }}>
          <strong>Mic:</strong>{' '}
          <span
            style={{
              color:
                micStatus === 'Granted'
                  ? '#4ecdc4'
                  : micStatus.startsWith('Denied')
                    ? '#ff6b6b'
                    : '#8b8b8b',
            }}
          >
            {micStatus}
          </span>
        </div>
        <div style={{ background: '#1a1a1a', padding: 10, borderRadius: 6 }}>
          <strong>Sample Rate:</strong> {sampleRate ? `${sampleRate} Hz` : '—'}
        </div>
        <div style={{ background: '#1a1a1a', padding: 10, borderRadius: 6 }}>
          <strong>API Key:</strong> {apiKey || '—'}
        </div>
        <div style={{ background: '#1a1a1a', padding: 10, borderRadius: 6 }}>
          <strong>WebSocket:</strong>{' '}
          <span
            style={{
              color:
                wsStatus === 'Connected'
                  ? '#4ecdc4'
                  : wsStatus.startsWith('Closed') || wsStatus === 'Error' || wsStatus === 'Failed'
                    ? '#ff6b6b'
                    : '#ffe66d',
            }}
          >
            {wsStatus}
          </span>
        </div>
      </div>

      {/* Audio Level */}
      <div style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 13 }}>Audio Level:</strong>
        <div
          style={{
            background: '#1a1a1a',
            borderRadius: 4,
            height: 20,
            overflow: 'hidden',
            marginTop: 4,
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${Math.min(100, audioLevel / 1.28)}%`,
              background: audioLevel > 100 ? '#4ecdc4' : audioLevel > 30 ? '#ffe66d' : '#555',
              transition: 'width 50ms',
            }}
          />
        </div>
      </div>

      {/* Controls */}
      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <button
          onClick={isRunning ? stopDiagnostic : runDiagnostic}
          style={{
            padding: '8px 20px',
            borderRadius: 6,
            border: 'none',
            background: isRunning ? '#ff6b6b' : '#4ecdc4',
            color: '#0a0a0a',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'monospace',
            fontSize: 14,
          }}
        >
          {isRunning ? 'Stop' : 'Run Diagnostic'}
        </button>
      </div>

      {/* Final Transcript */}
      {transcript && (
        <div
          style={{
            background: '#1a2a1a',
            padding: 12,
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: '#4ecdc4' }}>Transcript:</strong>
          <div style={{ marginTop: 4 }}>{transcript}</div>
        </div>
      )}

      {/* Event Log */}
      <div style={{ fontSize: 12 }}>
        <strong>Event Log ({logs.length}):</strong>
        <div
          style={{
            background: '#111',
            padding: 8,
            borderRadius: 6,
            marginTop: 4,
            maxHeight: 400,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {logs.length === 0 && (
            <div style={{ color: '#555' }}>Press &quot;Run Diagnostic&quot; to start</div>
          )}
          {logs.map((log, i) => (
            <div key={i} style={{ marginBottom: 2 }}>
              <span style={{ color: '#555' }}>{log.time}</span>{' '}
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
