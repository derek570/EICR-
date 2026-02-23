"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import {
  CalendarDays,
  ArrowLeft,
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
import { api, CalendarEvent, CalendarStatus } from "@/lib/api";

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
    } catch (error) {
      console.error("Failed to load calendar status:", error);
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
      // If 401, tokens were revoked
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

  // Handle OAuth callback code from URL
  useEffect(() => {
    const code = searchParams.get("code");
    if (code) {
      setConnecting(true);
      api
        .calendarCallback(code)
        .then(() => {
          toast.success("Google Calendar connected!");
          // Remove the code from the URL
          router.replace("/calendar");
          // Reload status + events
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
        if (s?.connected) {
          return loadEvents();
        }
      })
      .finally(() => setLoading(false));
  }, [loadStatus, loadEvents]);

  const handleConnect = async () => {
    try {
      const { url } = await api.getCalendarAuthUrl();
      // Redirect to Google OAuth
      window.location.href = url;
    } catch (error) {
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
    } catch (error) {
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
    // Check if it's a date-only string (no time component)
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
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-semibold">Calendar</h1>
            </div>
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
                  {disconnecting ? "Disconnecting..." : "Disconnect"}
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Not configured state */}
        {status && !status.configured && (
          <Card>
            <CardHeader>
              <CardTitle>Google Calendar Not Configured</CardTitle>
              <CardDescription>
                Google Calendar integration requires GOOGLE_CLIENT_ID and
                GOOGLE_CLIENT_SECRET environment variables to be set on the server.
                Contact your administrator to enable this feature.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {/* Not connected state */}
        {status && status.configured && !status.connected && !connecting && (
          <Card>
            <CardHeader className="text-center">
              <CalendarDays className="h-12 w-12 text-primary mx-auto mb-2" />
              <CardTitle>Connect Google Calendar</CardTitle>
              <CardDescription>
                View your upcoming inspection appointments and create jobs directly
                from your calendar events. Only events related to electrical
                inspections will be shown.
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

        {/* Connecting state */}
        {connecting && (
          <Card>
            <CardContent className="py-12 flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Connecting to Google Calendar...</p>
            </CardContent>
          </Card>
        )}

        {/* Connected — event list */}
        {status?.connected && !connecting && (
          <>
            {eventsLoading && events.length === 0 ? (
              <Card>
                <CardContent className="py-12 flex flex-col items-center gap-3">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <p className="text-muted-foreground">Loading upcoming inspections...</p>
                </CardContent>
              </Card>
            ) : events.length === 0 ? (
              <Card>
                <CardHeader className="text-center">
                  <CalendarDays className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
                  <CardTitle className="text-lg">No Upcoming Inspections</CardTitle>
                  <CardDescription>
                    No inspection-related events found in the next 30 days. Events
                    must contain keywords like &quot;EICR&quot;, &quot;EIC&quot;,
                    &quot;inspection&quot;, &quot;electrical&quot;, or
                    &quot;test&quot; in their title, description, or location.
                  </CardDescription>
                </CardHeader>
              </Card>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {events.length} upcoming inspection{events.length !== 1 ? "s" : ""} in the next 30 days
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
                            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
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
                              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                                <MapPin className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{event.location}</span>
                              </div>
                            )}

                            {event.description && (
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
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
                            <span className="text-xs text-muted-foreground italic">
                              No address
                            </span>
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
      </main>
    </div>
  );
}

export default function CalendarPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-50 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      }
    >
      <CalendarPageContent />
    </Suspense>
  );
}
