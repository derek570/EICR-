'use client';

import { useJob } from './layout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CircuitBoard, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

export default function JobOverviewPage() {
  const { job } = useJob();
  const params = useParams();
  const jobId = params.id as string;

  const c1Count = job.observations.filter((o) => o.code === 'C1').length;
  const c2Count = job.observations.filter((o) => o.code === 'C2').length;
  const c3Count = job.observations.filter((o) => o.code === 'C3').length;
  const fiCount = job.observations.filter((o) => o.code === 'FI').length;

  const hasDangerousObservations = c1Count > 0 || c2Count > 0;

  return (
    <div className="p-4 space-y-4">
      <Card
        className={
          hasDangerousObservations ? 'border-red-300 bg-red-50' : 'border-green-300 bg-green-50'
        }
      >
        <CardContent className="py-4">
          <div className="flex items-center gap-3">
            {hasDangerousObservations ? (
              <>
                <AlertTriangle className="h-6 w-6 text-red-600" />
                <div>
                  <p className="font-semibold text-red-800">Unsatisfactory</p>
                  <p className="text-sm text-red-700">
                    {c1Count > 0 && `${c1Count} danger present`}
                    {c1Count > 0 && c2Count > 0 && ', '}
                    {c2Count > 0 && `${c2Count} potentially dangerous`}
                  </p>
                </div>
              </>
            ) : (
              <>
                <CircuitBoard className="h-6 w-6 text-green-600" />
                <div>
                  <p className="font-semibold text-green-800">Satisfactory</p>
                  <p className="text-sm text-green-700">No dangerous observations found</p>
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Link href={`/job/${jobId}/circuits`}>
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="pb-2">
              <CardDescription>Circuits</CardDescription>
              <CardTitle className="text-3xl">{job.circuits.length}</CardTitle>
            </CardHeader>
          </Card>
        </Link>
        <Link href={`/job/${jobId}/observations`}>
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="pb-2">
              <CardDescription>Observations</CardDescription>
              <CardTitle className="text-3xl">{job.observations.length}</CardTitle>
            </CardHeader>
          </Card>
        </Link>
      </div>

      {job.observations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Observation Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="p-2 rounded bg-red-100">
                <p className="text-2xl font-bold text-red-700">{c1Count}</p>
                <p className="text-xs text-red-600">C1</p>
              </div>
              <div className="p-2 rounded bg-orange-100">
                <p className="text-2xl font-bold text-orange-700">{c2Count}</p>
                <p className="text-xs text-orange-600">C2</p>
              </div>
              <div className="p-2 rounded bg-blue-100">
                <p className="text-2xl font-bold text-blue-700">{c3Count}</p>
                <p className="text-xs text-blue-600">C3</p>
              </div>
              <div className="p-2 rounded bg-purple-100">
                <p className="text-2xl font-bold text-purple-700">{fiCount}</p>
                <p className="text-xs text-purple-600">FI</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Board Information</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">Location</dt>
            <dd>{job.board_info?.location || '-'}</dd>
            <dt className="text-muted-foreground">Manufacturer</dt>
            <dd>{job.board_info?.manufacturer || '-'}</dd>
            <dt className="text-muted-foreground">Earthing</dt>
            <dd>{job.board_info?.earthing_arrangement || '-'}</dd>
            <dt className="text-muted-foreground">Ze</dt>
            <dd>{job.board_info?.ze ? `${job.board_info.ze} Ω` : '-'}</dd>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
