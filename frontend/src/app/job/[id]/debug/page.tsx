"use client";

import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Play, Pause, AlertTriangle, Check, Clock, Volume2 } from "lucide-react";

interface DebugChunk {
  chunkIndex: number;
  chunkStartSeconds: number;
  timestamp: string;
  audioKey: string;
  audioUrl?: string;
  audioBytes: number;
  wasConcatenated: boolean;
  transcriptRaw: string;
  transcript: string;
  modelUsed: string;
  attempts: number;
  isEmpty: boolean;
}

interface DebugData {
  sessionId: string;
  jobId: string;
  address: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  chunksReceived: number;
  chunks: DebugChunk[];
  fullTranscript: string;
  extractedCircuits: number;
  extractedObservations: number;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AudioPlayer({ url, label }: { url: string; label: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  return (
    <div className="flex items-center gap-2">
      <audio
        ref={audioRef}
        src={url}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime || 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
        onEnded={() => setIsPlaying(false)}
      />
      <Button
        size="sm"
        variant="outline"
        onClick={togglePlay}
        className="h-8 w-8 p-0"
      >
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>
      <span className="text-xs text-muted-foreground">
        {formatTime(Math.floor(currentTime))} / {formatTime(Math.floor(duration))}
      </span>
    </div>
  );
}

export default function DebugPage() {
  const params = useParams();
  const jobId = params.id as string;
  const [debugData, setDebugData] = useState<DebugData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadDebugData() {
      try {
        const token = document.cookie
          .split("; ")
          .find((row) => row.startsWith("token="))
          ?.split("=")[1];

        // Get userId from token or session
        const userRes = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || ""}/api/auth/me`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        const userData = await userRes.json();
        const userId = userData.id;

        const res = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || ""}/api/job/${userId}/${jobId}/debug`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Failed to load debug data");
        }

        const data = await res.json();
        setDebugData(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    loadDebugData();
  }, [jobId]);

  if (loading) {
    return (
      <div className="p-4">
        <p>Loading debug data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <Card className="border-yellow-300 bg-yellow-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
              Debug Data Not Available
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-yellow-700">{error}</p>
            <p className="text-sm text-yellow-600 mt-2">
              This feature only works for jobs recorded after {new Date().toLocaleDateString()}.
              Jobs processed before debug logging was enabled won&apos;t have this data.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!debugData) {
    return <div className="p-4">No debug data found</div>;
  }

  const emptyChunks = debugData.chunks.filter((c) => c.isEmpty);
  const totalAudioBytes = debugData.chunks.reduce((sum, c) => sum + c.audioBytes, 0);

  return (
    <div className="p-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Transcription Debug</CardTitle>
          <CardDescription>
            Compare what was recorded vs what was transcribed
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Summary Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-muted p-3 rounded">
              <p className="text-sm text-muted-foreground">Duration</p>
              <p className="text-lg font-semibold">
                {formatTime(Math.floor(debugData.durationMs / 1000))}
              </p>
            </div>
            <div className="bg-muted p-3 rounded">
              <p className="text-sm text-muted-foreground">Audio Chunks</p>
              <p className="text-lg font-semibold">{debugData.chunksReceived}</p>
            </div>
            <div className="bg-muted p-3 rounded">
              <p className="text-sm text-muted-foreground">Total Audio</p>
              <p className="text-lg font-semibold">{formatBytes(totalAudioBytes)}</p>
            </div>
            <div className={`p-3 rounded ${emptyChunks.length > 0 ? "bg-yellow-100" : "bg-green-100"}`}>
              <p className="text-sm text-muted-foreground">Empty Chunks</p>
              <p className={`text-lg font-semibold ${emptyChunks.length > 0 ? "text-yellow-700" : "text-green-700"}`}>
                {emptyChunks.length}
              </p>
            </div>
          </div>

          {/* Extracted Data Summary */}
          <div className="flex gap-4 text-sm">
            <span className="text-muted-foreground">
              Extracted: {debugData.extractedCircuits} circuits, {debugData.extractedObservations} observations
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Audio Chunks Timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Volume2 className="h-5 w-5" />
            Audio Chunks
          </CardTitle>
          <CardDescription>
            Listen to each chunk and see what was transcribed. Yellow highlights indicate chunks where no speech was detected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {debugData.chunks.map((chunk) => (
              <div
                key={chunk.chunkIndex}
                className={`border rounded-lg p-4 ${
                  chunk.isEmpty
                    ? "border-yellow-300 bg-yellow-50"
                    : "border-gray-200"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-mono text-sm bg-muted px-2 py-0.5 rounded">
                        Chunk {chunk.chunkIndex}
                      </span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatTime(chunk.chunkStartSeconds)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatBytes(chunk.audioBytes)}
                      </span>
                      {chunk.wasConcatenated && (
                        <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                          concatenated
                        </span>
                      )}
                      {chunk.isEmpty && (
                        <span className="text-xs bg-yellow-200 text-yellow-800 px-1.5 py-0.5 rounded flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          no speech
                        </span>
                      )}
                    </div>

                    {/* Audio Player */}
                    {chunk.audioUrl && (
                      <div className="mb-2">
                        <AudioPlayer url={chunk.audioUrl} label={`Chunk ${chunk.chunkIndex}`} />
                      </div>
                    )}

                    {/* Transcript */}
                    <div className="mt-2">
                      <p className="text-xs text-muted-foreground mb-1">Transcribed:</p>
                      <p
                        className={`text-sm ${
                          chunk.isEmpty ? "text-yellow-600 italic" : "text-gray-800"
                        }`}
                      >
                        {chunk.transcript || "(no speech detected)"}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Full Transcript */}
      <Card>
        <CardHeader>
          <CardTitle>Full Transcript</CardTitle>
          <CardDescription>
            Complete accumulated transcript from all chunks
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-muted p-4 rounded-lg">
            <p className="whitespace-pre-wrap text-sm">
              {debugData.fullTranscript || "(empty transcript)"}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Tips */}
      <Card>
        <CardHeader>
          <CardTitle>Troubleshooting Tips</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground">
            <li>
              <strong>Yellow chunks:</strong> Audio was sent but no speech detected.
              Play the audio to check if speech is audible. Background noise or low volume may cause this.
            </li>
            <li>
              <strong>Missing values:</strong> If you hear yourself saying values that don&apos;t appear in the transcript,
              try speaking more clearly or louder. Gemini may miss quiet or mumbled speech.
            </li>
            <li>
              <strong>Short chunks concatenated:</strong> Very short audio clips are combined with the next chunk
              for better transcription accuracy.
            </li>
            <li>
              <strong>Context matters:</strong> Say &quot;Ze is 0.35&quot; instead of just &quot;0.35&quot; so the system knows
              which field the value belongs to.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
