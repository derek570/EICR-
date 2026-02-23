"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, BarChart3, CheckCircle, Clock, AlertTriangle, Loader2, FileText, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, User, AnalyticsData } from "@/lib/api";

export default function AnalyticsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const me = await api.getMe();
        setUser(me);
        const analytics = await api.getAnalytics(me.id);
        setData(analytics);
      } catch (err) {
        console.error("Failed to load analytics:", err);
        setError("Failed to load analytics data. Please try again.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-muted-foreground">Loading analytics...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-destructive mb-4">{error || "No data available"}</p>
          <Link href="/dashboard">
            <Button variant="outline">Back to Dashboard</Button>
          </Link>
        </div>
      </div>
    );
  }

  const { stats, weekly, timing } = data;

  // Calculate max job count for bar chart scaling
  const maxJobCount = Math.max(...weekly.map((w) => w.job_count), 1);

  // Format week label (e.g., "13 Jan")
  function formatWeekLabel(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Dashboard
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-semibold">Analytics</h1>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Jobs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                <span className="text-2xl font-bold">{stats.total}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Completed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-500" />
                <span className="text-2xl font-bold">{stats.completed}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Processing</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Loader2 className="h-5 w-5 text-blue-500" />
                <span className="text-2xl font-bold">{stats.processing}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Failed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-red-500" />
                <span className="text-2xl font-bold">{stats.failed}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">EICR</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-yellow-500" />
                <span className="text-2xl font-bold">{stats.eicr_count}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">EIC</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-orange-500" />
                <span className="text-2xl font-bold">{stats.eic_count}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Jobs Per Week Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Jobs Per Week (Last 12 Weeks)</CardTitle>
          </CardHeader>
          <CardContent>
            {weekly.length === 0 ? (
              <p className="text-muted-foreground text-sm py-8 text-center">
                No job data available yet. Complete some jobs to see your weekly trend.
              </p>
            ) : (
              <div className="space-y-2">
                {weekly.map((week) => (
                  <div key={week.week_start} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-16 text-right shrink-0">
                      {formatWeekLabel(week.week_start)}
                    </span>
                    <div className="flex-1 h-7 bg-muted rounded-sm overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-sm transition-all duration-300 flex items-center justify-end pr-2"
                        style={{
                          width: `${Math.max((week.job_count / maxJobCount) * 100, 4)}%`,
                        }}
                      >
                        <span className="text-xs font-medium text-primary-foreground">
                          {week.job_count}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Processing Times */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Processing Times
            </CardTitle>
          </CardHeader>
          <CardContent>
            {timing.avg_minutes === 0 && timing.min_minutes === 0 && timing.max_minutes === 0 ? (
              <p className="text-muted-foreground text-sm py-4 text-center">
                No completed jobs with timing data yet.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-sm text-muted-foreground">Average</p>
                  <p className="text-xl font-bold">{timing.avg_minutes} min</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Fastest</p>
                  <p className="text-xl font-bold text-green-600">{timing.min_minutes} min</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Slowest</p>
                  <p className="text-xl font-bold text-orange-600">{timing.max_minutes} min</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
