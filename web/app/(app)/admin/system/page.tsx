'use client';

import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Server, Database, HardDrive, Users } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';

interface HealthData {
  status: string;
  uptime: number;
  memory: { heapUsed: number; heapTotal: number; rss: number };
  database: { status: string };
  storage: string;
  node_version: string;
}

interface StatsData {
  jobs: number;
  users: number;
  uptime: number;
  storage: string;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export default function AdminSystemPage() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    try {
      const [healthData, statsData] = await Promise.all([
        api.getAdminHealth() as unknown as Promise<HealthData>,
        api.getAdminStats() as unknown as Promise<StatsData>,
      ]);
      setHealth(healthData);
      setStats(statsData);
    } catch (error) {
      console.error('Failed to load system data:', error);
      toast.error('Failed to load system data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">System</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoading(true);
            loadData();
          }}
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="py-4 text-center">
            <Users className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-2xl font-bold">{stats?.users ?? '-'}</p>
            <p className="text-xs text-muted-foreground">Users</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4 text-center">
            <HardDrive className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-2xl font-bold">{stats?.jobs ?? '-'}</p>
            <p className="text-xs text-muted-foreground">Jobs</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4 text-center">
            <Server className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-2xl font-bold">
              {health?.uptime ? formatUptime(health.uptime) : '-'}
            </p>
            <p className="text-xs text-muted-foreground">Uptime</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4 text-center">
            <Database className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-2xl font-bold">
              {health?.database?.status === 'connected' ? (
                <span className="text-green-600">OK</span>
              ) : (
                <span className="text-red-600">Down</span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">Database</p>
          </CardContent>
        </Card>
      </div>

      {/* Health details */}
      {health && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Server Health</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Status</p>
                <p className="font-medium">{health.status}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Node.js</p>
                <p className="font-medium">{health.node_version}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Storage</p>
                <p className="font-medium">{health.storage}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Memory (Heap)</p>
                <p className="font-medium">
                  {formatBytes(health.memory?.heapUsed ?? 0)} /{' '}
                  {formatBytes(health.memory?.heapTotal ?? 0)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Memory (RSS)</p>
                <p className="font-medium">{formatBytes(health.memory?.rss ?? 0)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Database</p>
                <p className="font-medium">{health.database?.status}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
