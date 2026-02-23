"use client";

/**
 * Phone Companion Mic Page — /mic
 *
 * Minimal fullscreen page designed for phone browsers.
 * Captures audio via phone mic, streams Int16 PCM chunks via Socket.IO
 * to the desktop's recording session in a `recording:{jobId}` room.
 *
 * Flow:
 * 1. User authenticates (token in URL query or login redirect)
 * 2. User selects a job from their job list
 * 3. Taps big mic button to start streaming audio
 * 4. Desktop receives audio-chunk events and feeds to Deepgram
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Mic, MicOff, Loader2, Wifi, WifiOff, Phone } from "lucide-react";

import { api } from "@/lib/api-client";
import { getToken, getUser } from "@/lib/auth";
import { AudioCapture, type AudioCaptureDelegate } from "@/lib/audio-capture";
import type { Job } from "@/lib/types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

type ConnectionStatus = "disconnected" | "connecting" | "connected";

export default function MicPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [desktopConnected, setDesktopConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chunkCount, setChunkCount] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const audioCaptureRef = useRef<AudioCapture | null>(null);
  const chunkCountRef = useRef(0);
  const userIdRef = useRef<string | null>(null);

  // ---- Auth Check ----

  useEffect(() => {
    const token = getToken();
    const user = getUser();
    if (!token || !user) {
      // Redirect to login with return URL
      window.location.href = `/login?redirect=${encodeURIComponent("/mic")}`;
      return;
    }
    userIdRef.current = user.id;
    setIsAuthenticated(true);
    setIsLoading(false);

    // Load jobs
    api.getJobs(user.id).then((jobList) => {
      setJobs(jobList);
    }).catch(() => {
      setError("Failed to load jobs");
    });
  }, []);

  // ---- Socket.IO Connection ----

  const connectSocket = useCallback(() => {
    const token = getToken();
    if (!token || socketRef.current) return;

    setConnectionStatus("connecting");

    const socket = io(API_BASE_URL, {
      auth: { token },
      transports: ["websocket"],
    });

    socket.on("connect", () => {
      setConnectionStatus("connected");
      setError(null);
    });

    socket.on("disconnect", () => {
      setConnectionStatus("disconnected");
      setDesktopConnected(false);
    });

    socket.on("connect_error", (err) => {
      setConnectionStatus("disconnected");
      setError(`Connection failed: ${err.message}`);
    });

    // Desktop has joined the recording room
    socket.on("companion-joined", () => {
      setDesktopConnected(true);
    });

    socket.on("companion-left", () => {
      setDesktopConnected(false);
    });

    socketRef.current = socket;
  }, []);

  // ---- Disconnect Socket ----

  const disconnectSocket = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setConnectionStatus("disconnected");
    setDesktopConnected(false);
  }, []);

  // ---- Start Streaming ----

  const startStreaming = useCallback(async () => {
    if (!selectedJobId || !socketRef.current) return;
    setError(null);

    try {
      // Join recording room
      socketRef.current.emit("join-recording", { jobId: selectedJobId });

      // Start audio capture
      const delegate: AudioCaptureDelegate = {
        onAudioData(pcmInt16: Int16Array) {
          // Convert Int16Array to ArrayBuffer for Socket.IO binary transport
          socketRef.current?.emit("audio-chunk", {
            jobId: selectedJobId,
            chunk: pcmInt16.buffer,
          });
          chunkCountRef.current++;
          // Update UI every 10 chunks to avoid excessive re-renders
          if (chunkCountRef.current % 10 === 0) {
            setChunkCount(chunkCountRef.current);
          }
        },
        onError(err: Error) {
          setError(`Microphone error: ${err.message}`);
          stopStreaming();
        },
      };

      const ac = new AudioCapture(delegate);
      audioCaptureRef.current = ac;
      await ac.start();

      chunkCountRef.current = 0;
      setChunkCount(0);
      setIsStreaming(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start microphone");
    }
  }, [selectedJobId]);

  // ---- Stop Streaming ----

  const stopStreaming = useCallback(() => {
    audioCaptureRef.current?.stop();
    audioCaptureRef.current = null;

    if (selectedJobId && socketRef.current) {
      socketRef.current.emit("leave-recording", { jobId: selectedJobId });
    }

    setIsStreaming(false);
    setChunkCount(chunkCountRef.current);
  }, [selectedJobId]);

  // ---- Connect on mount, disconnect on unmount ----

  useEffect(() => {
    if (isAuthenticated) {
      connectSocket();
    }
    return () => {
      stopStreaming();
      disconnectSocket();
    };
  }, [isAuthenticated, connectSocket, disconnectSocket, stopStreaming]);

  // ---- Render ----

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null; // Redirecting to login
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between p-4 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <Phone className="h-5 w-5 text-blue-400" />
          <span className="font-semibold text-lg">CertMate Mic</span>
        </div>
        <div className="flex items-center gap-2">
          {connectionStatus === "connected" ? (
            <Wifi className="h-5 w-5 text-green-400" />
          ) : connectionStatus === "connecting" ? (
            <Loader2 className="h-5 w-5 animate-spin text-yellow-400" />
          ) : (
            <WifiOff className="h-5 w-5 text-red-400" />
          )}
          <span className="text-sm text-slate-400">
            {connectionStatus === "connected"
              ? "Connected"
              : connectionStatus === "connecting"
                ? "Connecting..."
                : "Disconnected"}
          </span>
        </div>
      </header>

      {/* Job Selector */}
      <div className="p-4">
        <label className="block text-sm text-slate-400 mb-2">Select Job</label>
        <select
          className="w-full p-3 rounded-lg bg-slate-800 border border-slate-600 text-white text-lg"
          value={selectedJobId ?? ""}
          onChange={(e) => setSelectedJobId(e.target.value || null)}
          disabled={isStreaming}
        >
          <option value="">Choose a job...</option>
          {jobs.map((job) => (
            <option key={job.id} value={job.id}>
              {job.address || job.id}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop connection status */}
      {selectedJobId && (
        <div className="px-4 pb-2">
          <div
            className={`flex items-center gap-2 p-3 rounded-lg ${
              desktopConnected
                ? "bg-green-900/30 border border-green-700"
                : "bg-yellow-900/30 border border-yellow-700"
            }`}
          >
            <div
              className={`h-2 w-2 rounded-full ${
                desktopConnected ? "bg-green-400" : "bg-yellow-400 animate-pulse"
              }`}
            />
            <span className="text-sm">
              {desktopConnected
                ? "Desktop is listening"
                : "Waiting for desktop to start recording..."}
            </span>
          </div>
        </div>
      )}

      {/* Big Mic Button */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8">
        <button
          onClick={isStreaming ? stopStreaming : startStreaming}
          disabled={!selectedJobId || connectionStatus !== "connected"}
          className={`
            w-40 h-40 rounded-full flex items-center justify-center transition-all
            disabled:opacity-30 disabled:cursor-not-allowed active:scale-95
            ${
              isStreaming
                ? "bg-red-600 shadow-[0_0_40px_rgba(239,68,68,0.4)]"
                : "bg-blue-600 shadow-[0_0_40px_rgba(59,130,246,0.3)]"
            }
          `}
        >
          {isStreaming ? (
            <MicOff className="h-16 w-16 text-white" />
          ) : (
            <Mic className="h-16 w-16 text-white" />
          )}
        </button>

        <p className="text-slate-400 text-center text-lg">
          {isStreaming
            ? "Streaming audio to desktop..."
            : selectedJobId
              ? "Tap to start streaming"
              : "Select a job first"}
        </p>

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <div className="w-1 h-4 bg-blue-400 rounded-full animate-pulse" />
              <div className="w-1 h-6 bg-blue-400 rounded-full animate-pulse [animation-delay:150ms]" />
              <div className="w-1 h-3 bg-blue-400 rounded-full animate-pulse [animation-delay:300ms]" />
              <div className="w-1 h-5 bg-blue-400 rounded-full animate-pulse [animation-delay:450ms]" />
              <div className="w-1 h-3 bg-blue-400 rounded-full animate-pulse [animation-delay:600ms]" />
            </div>
            <span className="text-sm text-slate-500">
              {chunkCount > 0 ? `${chunkCount} chunks sent` : ""}
            </span>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 mb-4 p-3 rounded-lg bg-red-900/40 border border-red-700 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Footer */}
      <footer className="p-4 text-center text-sm text-slate-600">
        Open CertMate Desktop and start recording on the same job
      </footer>
    </div>
  );
}
