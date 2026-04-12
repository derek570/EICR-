'use client';

import { useJob } from './layout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CircuitBoard, AlertTriangle, Mic, Calendar, User, MapPin } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

export default function JobOverviewPage() {
  const { job, certificateType } = useJob();
  const params = useParams();
  const jobId = params.id as string;
  const isEIC = certificateType === 'EIC';

  const c1Count = job.observations.filter((o) => o.code === 'C1').length;
  const c2Count = job.observations.filter((o) => o.code === 'C2').length;
  const c3Count = job.observations.filter((o) => o.code === 'C3').length;
  const fiCount = job.observations.filter((o) => o.code === 'FI').length;

  const hasDangerousObservations = c1Count > 0 || c2Count > 0;
  const install = job.installation_details;

  return (
    <div className="p-4 space-y-4">
      {/* Start Recording CTA — mirrors iOS Overview tab where recording is initiated */}
      <Link href={`/job/${jobId}/record`}>
        <Card className="border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors cursor-pointer">
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/20">
                <Mic className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-semibold text-foreground">Start Recording</p>
                <p className="text-sm text-muted-foreground">Tap to begin voice data entry</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </Link>

      {/* Overall status — mirrors iOS dashboard status badge */}
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

      {/* Job summary — mirrors iOS hero header showing key job details */}
      {(install?.client_name || install?.address || install?.date_of_inspection) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Job Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {install?.client_name && (
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground shrink-0" />
                <span>{install.client_name}</span>
              </div>
            )}
            {install?.address && (
              <div className="flex items-start gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <span className="text-muted-foreground">
                  {[install.address, install.town, install.postcode].filter(Boolean).join(', ')}
                </span>
              </div>
            )}
            {install?.date_of_inspection && (
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">
                  Inspected: {new Date(install.date_of_inspection).toLocaleDateString()}
                  {install.next_inspection_due && (
                    <>
                      {' '}
                      &middot; Next due:{' '}
                      {new Date(install.next_inspection_due).toLocaleDateString()}
                    </>
                  )}
                </span>
              </div>
            )}
            {install?.general_condition && !isEIC && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Condition:</span>
                <span
                  className={
                    install.general_condition === 'Satisfactory'
                      ? 'text-green-600 font-medium'
                      : install.general_condition === 'Unsatisfactory'
                        ? 'text-red-600 font-medium'
                        : ''
                  }
                >
                  {install.general_condition}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Metrics grid — mirrors iOS DashboardView metric cards */}
      <div className="grid grid-cols-2 gap-4">
        <Link href={`/job/${jobId}/circuits`}>
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="pb-2">
              <CardDescription>Circuits</CardDescription>
              <CardTitle className="text-3xl">{job.circuits.length}</CardTitle>
            </CardHeader>
          </Card>
        </Link>
        {!isEIC && (
          <Link href={`/job/${jobId}/observations`}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer">
              <CardHeader className="pb-2">
                <CardDescription>Observations</CardDescription>
                <CardTitle className="text-3xl">{job.observations.length}</CardTitle>
              </CardHeader>
            </Card>
          </Link>
        )}
      </div>

      {/* Observation code breakdown — EICR only */}
      {!isEIC && job.observations.length > 0 && (
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
