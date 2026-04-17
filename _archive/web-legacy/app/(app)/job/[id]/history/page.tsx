'use client';

import { useEffect, useState } from 'react';
import { useJobContext } from '../layout';
import { api } from '@/lib/api-client';
import type { JobVersion, JobVersionDetail } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { History, ChevronDown, ChevronUp, Clock, Loader2 } from 'lucide-react';

export default function HistoryPage() {
  const { job, user } = useJobContext();
  const [versions, setVersions] = useState<JobVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null);
  const [snapshotData, setSnapshotData] = useState<Record<string, JobVersionDetail>>({});
  const [loadingSnapshot, setLoadingSnapshot] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    async function fetchHistory() {
      try {
        const data = await api.getJobHistory(user!.id, job.id);
        setVersions(data);
      } catch (error) {
        console.error('Failed to fetch job history:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchHistory();
  }, [user, job.id]);

  const toggleVersion = async (versionId: string) => {
    if (expandedVersion === versionId) {
      setExpandedVersion(null);
      return;
    }

    setExpandedVersion(versionId);

    if (!snapshotData[versionId]) {
      setLoadingSnapshot(versionId);
      try {
        const detail = await api.getJobVersion(user!.id, job.id, versionId);
        setSnapshotData((prev) => ({ ...prev, [versionId]: detail }));
      } catch (error) {
        console.error('Failed to fetch version snapshot:', error);
      } finally {
        setLoadingSnapshot(null);
      }
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return `${date.toLocaleDateString()} at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  if (loading) {
    return (
      <div className="p-4 flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2">
        <History className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Edit History</h2>
      </div>

      {versions.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <History className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No edit history yet</p>
            <p className="text-sm mt-1">
              Changes will be tracked automatically when you save edits.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {versions.map((version) => (
            <Card key={version.id}>
              <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary text-sm font-semibold">
                      v{version.version_number}
                    </div>
                    <div>
                      <CardTitle className="text-sm font-medium">
                        {version.changes_summary || 'Saved'}
                      </CardTitle>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                        <Clock className="h-3 w-3" />
                        {formatDate(version.created_at)}
                      </div>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => toggleVersion(version.id)}>
                    {expandedVersion === version.id ? (
                      <>
                        <ChevronUp className="h-4 w-4 mr-1" />
                        Hide
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-4 w-4 mr-1" />
                        View Snapshot
                      </>
                    )}
                  </Button>
                </div>
              </CardHeader>
              {expandedVersion === version.id && (
                <CardContent className="pt-0 px-4 pb-4">
                  {loadingSnapshot === version.id ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : snapshotData[version.id] ? (
                    <pre className="bg-muted border rounded-md p-3 text-xs overflow-x-auto max-h-96 overflow-y-auto">
                      {JSON.stringify(snapshotData[version.id].data_snapshot, null, 2)}
                    </pre>
                  ) : (
                    <p className="text-sm text-muted-foreground">Failed to load snapshot data.</p>
                  )}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
