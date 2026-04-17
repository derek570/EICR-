"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  CalendarDays,
  ExternalLink,
  MapPin,
  Clock,
  Plus,
  Unplug,
  RefreshCw,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/api-client";
import type { CalendarEvent, CalendarStatus } from "@/lib/types";

function CalendarPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [creatingJob, setCreatingJob] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getCalendarStatus();
      setStatus(s);
      return s;
    } catch {
      setStatus({ configured: false, connected: false });
      return null;
    }
  }, []);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const result = await api.getCalendarEvents();
      setEvents(result.events);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to load events";
      if (msg.includes("401") || msg.includes("revoked")) {
        setStatus({ configured: true, connected: false });
        toast.error("Calendar access was revoked. Please reconnect.");
      } else {
        toast.error(msg);
      }
    } finally {
      setEventsLoading(false);
    }
  }, []);

  // Handle OAuth callback code
  useEffect(() => {
    const code = searchParams.get("code");
    if (code) {
      setConnecting(true);
      api
        .calendarCallback(code)
        .then(() => {
          toast.success("Google Calendar connected!");
          router.replace("/calendar");
          loadStatus().then((s) => {
            if (s?.connected) loadEvents();
          });
        })
        .catch((err) => {
          toast.error("Failed to connect: " + err.message);
        })
        .finally(() => setConnecting(false));
    }
  }, [searchParams, router, loadStatus, loadEvents]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    loadStatus()
      .then((s) => {
        if (s?.connected) return loadEvents();
      })
      .finally(() => setLoading(false));
  }, [loadStatus, loadEvents]);

  const handleConnect = async () => {
    try {
      const { url } = await api.getCalendarAuthUrl();
      window.location.href = url;
    } catch {
      toast.error("Failed to start calendar connection");
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect your Google Calendar? You can reconnect at any time.")) return;
    setDisconnecting(true);
    try {
      await api.disconnectCalendar();
      setStatus({ configured: true, connected: false });
      setEvents([]);
      toast.success("Calendar disconnected");
    } catch {
      toast.error("Failed to disconnect calendar");
    } finally {
      setDisconnecting(false);
    }
  };

  const handleCreateJob = async (event: CalendarEvent) => {
    if (!event.location) {
      toast.error("This event has no address/location set");
      return;
    }
    setCreatingJob(event.id);
    try {
      const result = await api.createJobFromCalendarEvent({
        summary: event.summary,
        location: event.location,
        start: event.start,
        description: event.description,
      });
      toast.success(`Job created for ${result.address}`);
      router.push(`/job/${result.jobId}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to create job";
      toast.error(msg);
    } finally {
      setCreatingJob(null);
    }
  };

  const formatDateTime = (iso: string) => {
    if (!iso) return "";
    const date = new Date(iso);
    if (iso.length === 10) {
      return date.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    }
    return date.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-[var(--brand-blue)]" />
          <h1 className="text-lg font-semibold">Calendar</h1>
        </div>

        <div className="flex items-center gap-2">
          {status?.connected && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadEvents()}
                disabled={eventsLoading}
              >
                <RefreshCw className={`h-4 w-4 mr-1 ${eventsLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="text-red-600 hover:text-red-700"
              >
                <Unplug className="h-4 w-4 mr-1" />
                {disconnecting ? "..." : "Disconnect"}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Not configured */}
      {status && !status.configured && (
        <Card>
          <CardHeader>
            <CardTitle>Google Calendar Not Configured</CardTitle>
            <CardDescription>
              Google Calendar integration requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
              environment variables on the server. Contact your administrator.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Not connected */}
      {status && status.configured && !status.connected && !connecting && (
        <Card>
          <CardHeader className="text-center">
            <CalendarDays className="h-12 w-12 text-[var(--brand-blue)] mx-auto mb-2" />
            <CardTitle>Connect Google Calendar</CardTitle>
            <CardDescription>
              View upcoming inspection appointments and create jobs from calendar events.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button onClick={handleConnect} size="lg">
              <ExternalLink className="h-4 w-4 mr-2" />
              Connect Google Calendar
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Connecting */}
      {connecting && (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-[var(--brand-blue)]" />
            <p className="text-gray-500">Connecting to Google Calendar...</p>
          </CardContent>
        </Card>
      )}

      {/* Connected — events */}
      {status?.connected && !connecting && (
        <>
          {eventsLoading && events.length === 0 ? (
            <Card>
              <CardContent className="py-12 flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-[var(--brand-blue)]" />
                <p className="text-gray-500">Loading upcoming inspections...</p>
              </CardContent>
            </Card>
          ) : events.length === 0 ? (
            <Card>
              <CardHeader className="text-center">
                <CalendarDays className="h-10 w-10 text-gray-300 mx-auto mb-2" />
                <CardTitle className="text-lg">No Upcoming Inspections</CardTitle>
                <CardDescription>
                  No inspection-related events found in the next 30 days. Events must
                  contain keywords like &quot;EICR&quot;, &quot;inspection&quot;, or
                  &quot;electrical&quot; in their title or description.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">
                {events.length} upcoming inspection{events.length !== 1 ? "s" : ""} in the
                next 30 days
              </p>

              {events.map((event) => (
                <Card key={event.id} className="hover:shadow-md transition-shadow">
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-base truncate">
                          {event.summary || "Untitled event"}
                        </h3>
                        <div className="mt-1.5 space-y-1">
                          <div className="flex items-center gap-1.5 text-sm text-gray-500">
                            <Clock className="h-3.5 w-3.5 shrink-0" />
                            <span>{formatDateTime(event.start)}</span>
                            {event.end && (
                              <>
                                <span>-</span>
                                <span>
                                  {new Date(event.end).toLocaleTimeString("en-GB", {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>
                              </>
                            )}
                          </div>
                          {event.location && (
                            <div className="flex items-center gap-1.5 text-sm text-gray-500">
                              <MapPin className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{event.location}</span>
                            </div>
                          )}
                          {event.description && (
                            <p className="text-xs text-gray-400 mt-1 line-clamp-2">
                              {event.description}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0">
                        {event.location ? (
                          <Button
                            size="sm"
                            onClick={() => handleCreateJob(event)}
                            disabled={creatingJob === event.id}
                          >
                            {creatingJob === event.id ? (
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            ) : (
                              <Plus className="h-4 w-4 mr-1" />
                            )}
                            Create Job
                          </Button>
                        ) : (
                          <span className="text-xs text-gray-400 italic">No address</span>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function CalendarPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      }
    >
      <CalendarPageContent />
    </Suspense>
  );
}
