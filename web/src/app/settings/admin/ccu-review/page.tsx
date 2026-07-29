'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  Save,
  ScanSearch,
  Trash2,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import {
  ApiError,
  type CCUAnalysis,
  type CircuitRow,
  type CcuReviewDetailResponse,
  type CcuReviewGroundTruth,
  type CcuReviewListResponse,
  type CcuReviewSample,
  type CcuReviewStatus,
} from '@/lib/types';
import { ccuAnalysisToCircuitRows } from '@/lib/recording/apply-ccu-analysis';
import { isSystemAdmin } from '@/lib/roles';
import { useCurrentUser } from '@/lib/use-current-user';
import { Button } from '@/components/ui/button';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { SelectChips } from '@/components/ui/select-chips';

const BOARD_FIELDS = [
  'board_manufacturer',
  'board_model',
  'board_technology',
  'main_switch_rating',
  'main_switch_bs_en',
  'main_switch_type',
  'main_switch_poles',
  'main_switch_current',
  'main_switch_voltage',
  'main_switch_position',
  'spd_present',
  'spd_bs_en',
  'spd_type',
  'spd_rated_current_a',
  'spd_short_circuit_ka',
] as const;

const TEXT_CIRCUIT_FIELDS = [
  ['circuit_ref', 'Circuit'],
  ['circuit_designation', 'Designation'],
  ['ocpd_bs_en', 'OCPD BS EN'],
  ['ocpd_type', 'OCPD type'],
  ['ocpd_rating_a', 'Rating (A)'],
  ['ocpd_breaking_capacity_ka', 'Breaking capacity (kA)'],
  ['rcd_bs_en', 'RCD BS EN'],
  ['rcd_type', 'RCD type'],
  ['rcd_operating_current_ma', 'RCD rating (mA)'],
] as const;

const YES_NO_OPTIONS = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

function scalarString(value: unknown): string {
  return value == null ? '' : String(value);
}

function extractedBoard(analysis: CCUAnalysis): CcuReviewGroundTruth['board'] {
  const board: CcuReviewGroundTruth['board'] = {};
  for (const key of BOARD_FIELDS) {
    const value = analysis[key];
    if (
      value == null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      if (value != null) board[key] = typeof value === 'number' ? String(value) : value;
    }
  }
  return board;
}

function extractedTruth(detail: CcuReviewDetailResponse): CcuReviewGroundTruth {
  return {
    board: extractedBoard(detail.extracted),
    circuits: ccuAnalysisToCircuitRows(detail.extracted),
    notes: '',
  };
}

function initialTruth(detail: CcuReviewDetailResponse): CcuReviewGroundTruth {
  if (detail.groundTruth) {
    return {
      board: { ...detail.groundTruth.board },
      circuits: detail.groundTruth.circuits.map((row) => ({ ...row })),
      notes: detail.groundTruth.notes,
    };
  }
  return extractedTruth(detail);
}

function describeDate(value: string | null): string {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export default function CcuReviewPage() {
  return (
    <React.Suspense fallback={<ReviewSkeleton />}>
      <CcuReviewContent />
    </React.Suspense>
  );
}

function CcuReviewContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: userLoading } = useCurrentUser();
  const allowed = !!user && isSystemAdmin(user);
  const requestedSample = searchParams.get('sample');

  const [status, setStatus] = React.useState<CcuReviewStatus>('unreviewed');
  const [queue, setQueue] = React.useState<CcuReviewListResponse | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(requestedSample);
  const [detail, setDetail] = React.useState<CcuReviewDetailResponse | null>(null);
  const [truth, setTruth] = React.useState<CcuReviewGroundTruth | null>(null);
  const [queueLoading, setQueueLoading] = React.useState(true);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedMessage, setSavedMessage] = React.useState<string | null>(null);

  const setSampleUrl = React.useCallback(
    (sampleId: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (sampleId) next.set('sample', sampleId);
      else next.delete('sample');
      router.replace(`/settings/admin/ccu-review${next.size ? `?${next.toString()}` : ''}`, {
        scroll: false,
      });
    },
    [router, searchParams]
  );

  const loadQueue = React.useCallback(async () => {
    if (!allowed) return null;
    setQueueLoading(true);
    setError(null);
    try {
      const result = await api.adminListCcuReviewSamples(status, 200, 0);
      setQueue(result);
      return result;
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'Failed to load the CCU review queue'
      );
      return null;
    } finally {
      setQueueLoading(false);
    }
  }, [allowed, status]);

  React.useEffect(() => {
    if (!allowed) {
      setQueueLoading(false);
      return;
    }
    void loadQueue();
  }, [allowed, loadQueue]);

  React.useEffect(() => {
    if (selectedId || requestedSample || !queue?.items.length) return;
    const firstId = queue.items[0].sampleId;
    setSelectedId(firstId);
    setSampleUrl(firstId);
  }, [queue, requestedSample, selectedId, setSampleUrl]);

  React.useEffect(() => {
    if (!allowed || !selectedId) {
      setDetail(null);
      setTruth(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setError(null);
    setSavedMessage(null);
    void api
      .adminGetCcuReviewSample(selectedId)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        setTruth(initialTruth(result));
        setDirty(false);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(
          cause instanceof ApiError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : 'Failed to load this CCU extraction'
        );
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, selectedId]);

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function selectSample(sample: CcuReviewSample) {
    if (dirty && !window.confirm('Discard your unsaved changes and open another extraction?')) {
      return;
    }
    setSelectedId(sample.sampleId);
    setSampleUrl(sample.sampleId);
  }

  function patchBoard(key: string, value: string | boolean | null) {
    setTruth((current) =>
      current ? { ...current, board: { ...current.board, [key]: value } } : current
    );
    setDirty(true);
    setSavedMessage(null);
  }

  function patchCircuit(index: number, key: string, value: string | boolean) {
    setTruth((current) => {
      if (!current) return current;
      const circuits = current.circuits.map((row, rowIndex) =>
        rowIndex === index ? { ...row, [key]: value } : row
      );
      return { ...current, circuits };
    });
    setDirty(true);
    setSavedMessage(null);
  }

  function addCircuit() {
    setTruth((current) => {
      if (!current) return current;
      const nextIndex = current.circuits.length + 1;
      return {
        ...current,
        circuits: [
          ...current.circuits,
          {
            id: `ccu-review-added-${Date.now()}`,
            board_id: 'ccu-ground-truth',
            circuit_ref: String(nextIndex),
            circuit_designation: '',
          },
        ],
      };
    });
    setDirty(true);
  }

  function removeCircuit(index: number) {
    setTruth((current) =>
      current
        ? { ...current, circuits: current.circuits.filter((_, rowIndex) => rowIndex !== index) }
        : current
    );
    setDirty(true);
  }

  function resetToExtraction() {
    if (!detail) return;
    if (dirty && !window.confirm('Replace your edits with the original model extraction?')) return;
    setTruth(extractedTruth(detail));
    setDirty(true);
    setSavedMessage(null);
  }

  async function saveGroundTruth() {
    if (!selectedId || !truth) return;
    setSaving(true);
    setError(null);
    setSavedMessage(null);
    try {
      const result = await api.adminSaveCcuGroundTruth(selectedId, truth);
      setDirty(false);
      setSavedMessage(`Saved as reviewed · revision ${result.revision}`);
      const refreshed = await loadQueue();
      if (status === 'unreviewed') {
        const next = refreshed?.items.find((sample) => sample.sampleId !== selectedId) ?? null;
        if (next) {
          setSelectedId(next.sampleId);
          setSampleUrl(next.sampleId);
        }
      }
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'Failed to save the CCU ground truth'
      );
    } finally {
      setSaving(false);
    }
  }

  if (userLoading) return <ReviewSkeleton />;

  if (!allowed) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6">
        <BackButton onClick={() => router.push('/settings')} />
        <SectionCard accent="amber" title="Not authorised">
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            CCU ground-truth review is available only to system administrators.
          </p>
        </SectionCard>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-[1720px] flex-col gap-5 px-4 py-6">
      <BackButton onClick={() => router.push('/settings')} />
      <HeroHeader
        eyebrow="Administration"
        title="CCU Ground Truth"
        subtitle="Compare each original photo with CertMate’s extracted board and circuit fields, then save the correct answer."
        icon={<ScanSearch className="h-10 w-10" aria-hidden />}
      />

      {error ? (
        <SectionCard accent="amber" title="Review workspace error">
          <p className="text-[13px] text-[var(--color-text-secondary)]">{error}</p>
          <Button variant="ghost" size="sm" onClick={() => void loadQueue()}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Retry queue
          </Button>
        </SectionCard>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[250px_minmax(340px,0.85fr)_minmax(560px,1.15fr)]">
        <QueuePanel
          queue={queue}
          loading={queueLoading}
          status={status}
          selectedId={selectedId}
          onStatus={setStatus}
          onSelect={selectSample}
        />

        <PhotoPanel detail={detail} loading={detailLoading} />

        <div className="flex min-w-0 flex-col gap-4">
          {detailLoading ? (
            <div className="cm-shimmer h-96 rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
          ) : detail && truth ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-3">
                <div>
                  <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">
                    {detail.sample.reviewed
                      ? `Reviewed · revision ${detail.reviewMeta?.revision ?? 1}`
                      : 'Unreviewed extraction'}
                  </p>
                  <p className="text-[11px] text-[var(--color-text-tertiary)]">
                    {dirty ? 'Unsaved changes' : savedMessage || 'No unsaved changes'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={resetToExtraction}>
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    Reset to extraction
                  </Button>
                  <Button size="sm" disabled={saving || !dirty} onClick={saveGroundTruth}>
                    <Save className="h-4 w-4" aria-hidden />
                    {saving ? 'Saving…' : 'Save correct board'}
                  </Button>
                </div>
              </div>

              <BoardEditor board={truth.board} onChange={patchBoard} />

              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[16px] font-bold text-[var(--color-text-primary)]">
                    Circuits
                  </h2>
                  <p className="text-[12px] text-[var(--color-text-secondary)]">
                    {truth.circuits.length} circuit{truth.circuits.length === 1 ? '' : 's'}
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={addCircuit}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Add circuit
                </Button>
              </div>

              {truth.circuits.map((circuit, index) => (
                <CircuitEditor
                  key={circuit.id}
                  circuit={circuit}
                  index={index}
                  onChange={patchCircuit}
                  onRemove={removeCircuit}
                />
              ))}

              <SectionCard accent="blue" title="Reviewer notes">
                <label className="flex flex-col gap-1 text-[12px] font-medium text-[var(--color-text-secondary)]">
                  Anything uncertain or obscured in the photograph
                  <textarea
                    value={truth.notes}
                    onChange={(event) => {
                      setTruth({ ...truth, notes: event.target.value });
                      setDirty(true);
                    }}
                    rows={4}
                    maxLength={5000}
                    className="resize-y rounded-[var(--radius-input)] border-[1.5px] border-[color:var(--color-surface-3)] bg-[var(--color-surface-2)] px-3 py-2 text-[16px] text-[var(--color-text-primary)] focus:border-[var(--color-green-vibrant)] focus:outline-none"
                  />
                </label>
              </SectionCard>

              <Button size="lg" disabled={saving || !dirty} onClick={saveGroundTruth}>
                <Save className="h-5 w-5" aria-hidden />
                {saving ? 'Saving…' : 'Save correct board'}
              </Button>
            </>
          ) : (
            <SectionCard accent="blue" title="Choose an extraction">
              <p className="text-[13px] text-[var(--color-text-secondary)]">
                Select a CCU extraction from the review queue.
              </p>
            </SectionCard>
          )}
        </div>
      </div>
    </main>
  );
}

function QueuePanel({
  queue,
  loading,
  status,
  selectedId,
  onStatus,
  onSelect,
}: {
  queue: CcuReviewListResponse | null;
  loading: boolean;
  status: CcuReviewStatus;
  selectedId: string | null;
  onStatus: (status: CcuReviewStatus) => void;
  onSelect: (sample: CcuReviewSample) => void;
}) {
  return (
    <aside className="flex flex-col gap-3 xl:sticky xl:top-4">
      <SectionCard
        accent="blue"
        title="Review queue"
        subtitle={
          queue ? `${queue.unreviewed} unreviewed · ${queue.reviewed} reviewed` : 'Loading samples'
        }
      >
        <div className="grid grid-cols-3 gap-1">
          {(['unreviewed', 'reviewed', 'all'] as CcuReviewStatus[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onStatus(option)}
              className={`rounded-[var(--radius-sm)] px-2 py-2 text-[11px] font-semibold capitalize ${
                status === option
                  ? 'bg-[var(--color-brand-blue)] text-white'
                  : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <div className="flex max-h-[65vh] flex-col gap-1 overflow-y-auto pr-1">
          {loading ? (
            <div className="cm-shimmer h-28 rounded-[var(--radius-md)] bg-[var(--color-surface-2)]" />
          ) : queue?.items.length ? (
            queue.items.map((sample) => (
              <button
                key={sample.sampleId}
                type="button"
                onClick={() => onSelect(sample)}
                className={`flex items-center gap-2 rounded-[var(--radius-md)] border p-2 text-left transition ${
                  selectedId === sample.sampleId
                    ? 'border-[var(--color-brand-blue)] bg-[var(--color-brand-blue)]/10'
                    : 'border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)]'
                }`}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                    sample.reviewed
                      ? 'bg-[var(--color-brand-green)]/20 text-[var(--color-brand-green)]'
                      : 'bg-[var(--color-brand-blue)]/15 text-[var(--color-brand-blue)]'
                  }`}
                >
                  {sample.reviewed ? (
                    <Check className="h-4 w-4" aria-hidden />
                  ) : (
                    <ImageIcon className="h-4 w-4" aria-hidden />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold text-[var(--color-text-primary)]">
                    {describeDate(sample.createdAt)}
                  </span>
                  <span className="block truncate text-[10px] text-[var(--color-text-tertiary)]">
                    {sample.sessionId}
                  </span>
                </span>
                <ChevronRight
                  className="h-3.5 w-3.5 text-[var(--color-text-tertiary)]"
                  aria-hidden
                />
              </button>
            ))
          ) : (
            <p className="rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-3 text-[12px] text-[var(--color-text-secondary)]">
              No {status === 'all' ? '' : status} extractions.
            </p>
          )}
        </div>
      </SectionCard>
    </aside>
  );
}

function PhotoPanel({
  detail,
  loading,
}: {
  detail: CcuReviewDetailResponse | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="cm-shimmer min-h-[420px] rounded-[var(--radius-lg)] bg-[var(--color-surface-2)] xl:sticky xl:top-4" />
    );
  }
  if (!detail) {
    return (
      <SectionCard accent="blue" title="Original photograph">
        <p className="text-[13px] text-[var(--color-text-secondary)]">
          The photograph will appear here.
        </p>
      </SectionCard>
    );
  }
  return (
    <aside className="flex flex-col gap-3 xl:sticky xl:top-4">
      <SectionCard
        accent="green"
        title="Original photograph"
        subtitle={describeDate(detail.sample.createdAt)}
      >
        {/* S3 host and signature parameters vary by environment, so a raw
            image element is intentional here; fixed Next Image domains
            would make the admin tool fail outside production. */}
        <a
          href={detail.imageUrl}
          target="_blank"
          rel="noreferrer"
          className="group relative block overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-black"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={detail.imageUrl}
            alt={`Consumer unit extraction ${detail.sample.extractionId}`}
            className="max-h-[75vh] w-full object-contain transition group-hover:brightness-110"
          />
        </a>
        <a
          href={detail.imageUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-brand-blue)]"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          Open full-size photo
        </a>
        <dl className="grid grid-cols-2 gap-2 text-[11px]">
          <div>
            <dt className="text-[var(--color-text-tertiary)]">Model</dt>
            <dd className="font-semibold text-[var(--color-text-primary)]">
              {detail.extractionMeta.model || 'Unknown'}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-text-tertiary)]">Circuits extracted</dt>
            <dd className="font-semibold text-[var(--color-text-primary)]">
              {detail.extracted.circuits?.filter(
                (circuit) => circuit.is_rcd_device !== true && circuit.circuit_number != null
              ).length ?? 0}
            </dd>
          </div>
        </dl>
        {detail.extracted.questionsForInspector?.length ? (
          <div className="rounded-[var(--radius-md)] bg-[var(--color-status-processing)]/10 p-3">
            <p className="mb-1 text-[11px] font-semibold text-[var(--color-status-processing)]">
              Model questions
            </p>
            <ul className="list-disc space-y-1 pl-4 text-[11px] text-[var(--color-text-secondary)]">
              {detail.extracted.questionsForInspector.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </SectionCard>
    </aside>
  );
}

function BoardEditor({
  board,
  onChange,
}: {
  board: CcuReviewGroundTruth['board'];
  onChange: (key: string, value: string | boolean | null) => void;
}) {
  return (
    <SectionCard accent="electrical" title="Board details">
      <div className="grid gap-3 sm:grid-cols-2">
        <FloatingLabelInput
          label="Manufacturer"
          value={scalarString(board.board_manufacturer)}
          onChange={(event) => onChange('board_manufacturer', event.target.value)}
        />
        <FloatingLabelInput
          label="Model"
          value={scalarString(board.board_model)}
          onChange={(event) => onChange('board_model', event.target.value)}
        />
        <SelectChips
          label="Board technology"
          value={scalarString(board.board_technology) || null}
          options={[
            { value: 'modern', label: 'Modern' },
            { value: 'rewireable_fuse', label: 'Rewireable fuse' },
            { value: 'cartridge_fuse', label: 'Cartridge fuse' },
            { value: 'mixed', label: 'Mixed' },
          ]}
          onChange={(value) => onChange('board_technology', value)}
        />
        <SelectChips
          label="Main switch position"
          value={scalarString(board.main_switch_position) || null}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
          ]}
          onChange={(value) => onChange('main_switch_position', value)}
        />
        <FloatingLabelInput
          label="Main switch rating (A)"
          value={scalarString(board.main_switch_rating)}
          onChange={(event) => onChange('main_switch_rating', event.target.value)}
        />
        <FloatingLabelInput
          label="Main switch BS EN"
          value={scalarString(board.main_switch_bs_en)}
          onChange={(event) => onChange('main_switch_bs_en', event.target.value)}
        />
        <SelectChips
          label="SPD present"
          value={typeof board.spd_present === 'boolean' ? (board.spd_present ? 'yes' : 'no') : null}
          options={YES_NO_OPTIONS}
          onChange={(value) => onChange('spd_present', value === 'yes')}
        />
        <FloatingLabelInput
          label="SPD type"
          value={scalarString(board.spd_type)}
          onChange={(event) => onChange('spd_type', event.target.value)}
        />
        <FloatingLabelInput
          label="SPD BS EN"
          value={scalarString(board.spd_bs_en)}
          onChange={(event) => onChange('spd_bs_en', event.target.value)}
        />
      </div>
    </SectionCard>
  );
}

function CircuitEditor({
  circuit,
  index,
  onChange,
  onRemove,
}: {
  circuit: CircuitRow;
  index: number;
  onChange: (index: number, key: string, value: string | boolean) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <SectionCard
      accent="protection"
      title={`Circuit ${scalarString(circuit.circuit_ref) || index + 1}`}
      subtitle={scalarString(circuit.circuit_designation) || 'No designation'}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TEXT_CIRCUIT_FIELDS.map(([key, label]) => (
          <FloatingLabelInput
            key={key}
            label={label}
            value={scalarString(circuit[key])}
            onChange={(event) => onChange(index, key, event.target.value)}
          />
        ))}
        <SelectChips
          label="RCBO"
          value={typeof circuit.is_rcbo === 'boolean' ? (circuit.is_rcbo ? 'yes' : 'no') : null}
          options={YES_NO_OPTIONS}
          onChange={(value) => onChange(index, 'is_rcbo', value === 'yes')}
        />
        <SelectChips
          label="RCD protected"
          value={
            typeof circuit.rcd_protected === 'boolean'
              ? circuit.rcd_protected
                ? 'yes'
                : 'no'
              : null
          }
          options={YES_NO_OPTIONS}
          onChange={(value) => onChange(index, 'rcd_protected', value === 'yes')}
        />
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => onRemove(index)}>
          <Trash2 className="h-4 w-4 text-[var(--color-status-failed)]" aria-hidden />
          Remove circuit
        </Button>
      </div>
    </SectionCard>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-[var(--color-brand-blue)]"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      Settings
    </button>
  );
}

function ReviewSkeleton() {
  return (
    <main className="mx-auto flex w-full max-w-[1720px] flex-col gap-4 px-4 py-6">
      <div className="cm-shimmer h-10 w-32 rounded-[var(--radius-md)] bg-[var(--color-surface-2)]" />
      <div className="cm-shimmer h-36 rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
      <div className="grid gap-4 xl:grid-cols-[250px_1fr_1.2fr]">
        <div className="cm-shimmer h-96 rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
        <div className="cm-shimmer h-[560px] rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
        <div className="cm-shimmer h-[560px] rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
      </div>
    </main>
  );
}
