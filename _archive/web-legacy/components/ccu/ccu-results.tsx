'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Check,
  AlertTriangle,
  Zap,
  Shield,
  CircuitBoard,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type {
  CCUAnalysisResult,
  CCUCircuit,
  Circuit,
  BoardInfo,
  SupplyCharacteristics,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { lookupMaxZs } from '@/lib/max-zs-lookup';

interface CCUResultsProps {
  result: CCUAnalysisResult;
  onApply: (data: {
    circuits: Circuit[];
    boardInfo: Partial<BoardInfo>;
    supply: Partial<SupplyCharacteristics>;
  }) => void;
  onDismiss: () => void;
}

function confidenceBadge(confidence: number) {
  if (confidence >= 0.8) return { label: 'High confidence', color: 'text-green-700 bg-green-50' };
  if (confidence >= 0.5) return { label: 'Medium confidence', color: 'text-amber-700 bg-amber-50' };
  return { label: 'Low confidence', color: 'text-red-700 bg-red-50' };
}

function qualityBadge(quality: string) {
  if (quality === 'clear') return { label: 'Clear image', color: 'text-green-700 bg-green-50' };
  if (quality === 'partially_readable')
    return { label: 'Partially readable', color: 'text-amber-700 bg-amber-50' };
  return { label: 'Poor image', color: 'text-red-700 bg-red-50' };
}

function circuitToRow(ccuCircuit: CCUCircuit, boardId: string): Circuit {
  return {
    circuit_ref: String(ccuCircuit.circuit_number),
    circuit_designation: ccuCircuit.label || '',
    ocpd_type: ccuCircuit.ocpd_type || '',
    ocpd_rating_a: ccuCircuit.ocpd_rating_a || '',
    ocpd_bs_en: ccuCircuit.ocpd_bs_en || '',
    ocpd_breaking_capacity_ka: ccuCircuit.ocpd_breaking_capacity_ka || '',
    rcd_bs_en: ccuCircuit.is_rcbo
      ? ccuCircuit.rcd_bs_en || '61009'
      : ccuCircuit.rcd_protected
        ? ccuCircuit.rcd_bs_en || ''
        : '',
    rcd_type: ccuCircuit.is_rcbo ? 'A' : '',
    rcd_operating_current_ma: ccuCircuit.rcd_protected ? ccuCircuit.rcd_rating_ma || '30' : '',
    ocpd_max_zs_ohm: lookupMaxZs(ccuCircuit.ocpd_type || '', ccuCircuit.ocpd_rating_a || '') || '',
    board_id: boardId,
  };
}

export function CCUResults({ result, onApply, onDismiss }: CCUResultsProps) {
  const [showDetails, setShowDetails] = useState(false);
  const conf = confidenceBadge(result.confidence.overall);
  const qual = qualityBadge(result.confidence.image_quality);

  const validCircuits = result.circuits.filter((c) => c.label !== null || c.ocpd_rating_a !== null);
  const spareCount = result.circuits.length - validCircuits.length;

  const handleApply = () => {
    const boardId = 'board_1';

    const circuits: Circuit[] = result.circuits.map((c) => circuitToRow(c, boardId));

    const boardInfo: Partial<BoardInfo> = {};
    if (result.board_manufacturer) boardInfo.manufacturer = result.board_manufacturer;

    const supply: Partial<SupplyCharacteristics> = {};
    if (result.main_switch_bs_en) supply.main_switch_bs_en = result.main_switch_bs_en;
    if (result.main_switch_poles) supply.main_switch_poles = result.main_switch_poles;
    if (result.main_switch_voltage) supply.main_switch_voltage = result.main_switch_voltage;
    if (result.main_switch_current) supply.main_switch_current = result.main_switch_current;

    if (result.spd_present) {
      if (result.spd_bs_en) supply.spd_bs_en = result.spd_bs_en;
      if (result.spd_type) supply.spd_type_supply = result.spd_type;
      if (result.spd_rated_current_a) supply.spd_rated_current = result.spd_rated_current_a;
      if (result.spd_short_circuit_ka) supply.spd_short_circuit = result.spd_short_circuit_ka;
    }

    onApply({ circuits, boardInfo, supply });
  };

  return (
    <Card className="border-[var(--brand-blue)]">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <CircuitBoard className="h-5 w-5" />
            Analysis Results
          </span>
          <div className="flex gap-2">
            <span className={cn('text-xs px-2 py-1 rounded-full font-normal', conf.color)}>
              {conf.label}
            </span>
            <span className={cn('text-xs px-2 py-1 rounded-full font-normal', qual.color)}>
              {qual.label}
            </span>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-gray-50 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold">{result.circuits.length}</div>
            <div className="text-xs text-gray-500">Circuits found</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold">{validCircuits.length}</div>
            <div className="text-xs text-gray-500">With labels</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold">{spareCount}</div>
            <div className="text-xs text-gray-500">Spare/blank</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold">{Math.round(result.confidence.overall * 100)}%</div>
            <div className="text-xs text-gray-500">Confidence</div>
          </div>
        </div>

        {/* Board Info */}
        {(result.board_manufacturer || result.main_switch_current) && (
          <div className="flex flex-wrap gap-2 text-sm">
            {result.board_manufacturer && (
              <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded">
                {result.board_manufacturer}
                {result.board_model ? ` ${result.board_model}` : ''}
              </span>
            )}
            {result.main_switch_current && (
              <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded">
                Main switch: {result.main_switch_current}A {result.main_switch_type || ''}
              </span>
            )}
            {result.spd_present && (
              <span className="bg-green-50 text-green-700 px-2 py-1 rounded flex items-center gap-1">
                <Shield className="h-3 w-3" />
                SPD: {result.spd_type || 'Present'}
              </span>
            )}
          </div>
        )}

        {/* Confidence message */}
        {result.confidence.message && (
          <div className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 p-3 rounded-md">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{result.confidence.message}</span>
          </div>
        )}

        {/* Circuit table (collapsible) */}
        <div>
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-gray-800"
          >
            {showDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            {showDetails ? 'Hide' : 'Show'} circuit details
          </button>

          {showDetails && (
            <div className="mt-2 border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">#</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">Label</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">Type</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">Rating</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">BS/EN</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">RCD</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {result.circuits.map((circuit) => (
                    <tr
                      key={circuit.circuit_number}
                      className={cn('hover:bg-gray-50', !circuit.label && 'text-gray-400')}
                    >
                      <td className="px-3 py-2">{circuit.circuit_number}</td>
                      <td className="px-3 py-2">
                        {circuit.label || <span className="italic">Spare</span>}
                      </td>
                      <td className="px-3 py-2">{circuit.ocpd_type || '-'}</td>
                      <td className="px-3 py-2">
                        {circuit.ocpd_rating_a ? `${circuit.ocpd_rating_a}A` : '-'}
                      </td>
                      <td className="px-3 py-2">{circuit.ocpd_bs_en || '-'}</td>
                      <td className="px-3 py-2">
                        {circuit.is_rcbo ? (
                          <span className="text-green-600 flex items-center gap-1">
                            <Zap className="h-3 w-3" />
                            RCBO
                          </span>
                        ) : circuit.rcd_protected ? (
                          <span className="text-blue-600">{circuit.rcd_rating_ma || '30'}mA</span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Uncertain fields */}
        {result.confidence.uncertain_fields.length > 0 && showDetails && (
          <div className="text-xs text-gray-500">
            <span className="font-medium">Uncertain fields: </span>
            {result.confidence.uncertain_fields.join(', ')}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button onClick={handleApply} className="flex-1">
            <Check className="h-4 w-4 mr-2" />
            Apply to Board
          </Button>
          <Button onClick={onDismiss} variant="outline">
            Dismiss
          </Button>
        </div>

        <p className="text-xs text-gray-500">
          Applying will create {result.circuits.length} circuits and populate board/supply fields.
          Existing data will not be overwritten.
        </p>
      </CardContent>
    </Card>
  );
}
