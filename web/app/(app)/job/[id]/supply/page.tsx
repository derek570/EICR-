"use client";

import { useJobContext } from "../layout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SupplyCharacteristics } from "@/lib/types";
import {
  EARTHING_ARRANGEMENTS,
  LIVE_CONDUCTORS,
  VOLTAGES,
  FREQUENCIES,
  NUMBER_OF_SUPPLIES,
  SPD_BS_EN_OPTIONS,
  SHORT_CIRCUIT_CAPACITY,
  SPD_RATED_CURRENT,
  MAIN_SWITCH_BS_EN,
  NUMBER_OF_POLES,
  VOLTAGE_RATINGS,
  MAIN_SWITCH_CURRENT,
  CONDUCTOR_MATERIALS,
  CONDUCTOR_CSA,
  BONDING_CSA,
  RCD_OPERATING_CURRENT,
} from "@/lib/constants";

const DEFAULT_SUPPLY: SupplyCharacteristics = {
  earthing_arrangement: "TN-C-S",
  live_conductors: "AC - 1-phase (2 wire)",
  number_of_supplies: "1",
  nominal_voltage_u: "230",
  nominal_voltage_uo: "230",
  nominal_frequency: "50",
  prospective_fault_current: "",
  earth_loop_impedance_ze: "",
  supply_polarity_confirmed: "",
  spd_bs_en: "",
  spd_type_supply: "",
  spd_short_circuit: "",
  spd_rated_current: "",
  means_earthing_distributor: false,
  means_earthing_electrode: false,
  main_switch_bs_en: "",
  main_switch_poles: "",
  main_switch_voltage: "",
  main_switch_current: "",
  main_switch_fuse_setting: "",
  main_switch_location: "",
  main_switch_conductor_material: "",
  main_switch_conductor_csa: "",
  rcd_operating_current: "",
  rcd_time_delay: "",
  rcd_operating_time: "",
  rcd_operating_current_test: "",
  rcd_time_delay_test: "",
  rcd_operating_time_test: "",
  earthing_conductor_material: "",
  earthing_conductor_csa: "",
  earthing_conductor_continuity: "",
  bonding_conductor_material: "",
  bonding_conductor_csa: "",
  bonding_conductor_continuity: "",
  bonding_water: "",
  bonding_gas: "",
  bonding_oil: "",
  bonding_structural_steel: "",
  bonding_lightning: "",
  bonding_other: "",
  bonding_other_na: false,
};

function Dropdown({
  id, label, field, options, value, onChange,
}: {
  id: string; label: string; field: string;
  options: string[]; value: string | undefined;
  onChange: (field: string, value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value || ""}
        onChange={(e) => onChange(field, e.target.value)}
        className="w-full h-10 rounded-md border border-gray-300 px-3 bg-white text-sm"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  );
}

function ButtonGroup({
  options, value, onChange,
}: {
  options: string[]; value: string | undefined;
  onChange: (val: string) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`px-3 py-1.5 text-sm rounded border transition-colors ${
            value === opt
              ? opt === "PASS" ? "bg-green-600 text-white border-green-600"
              : opt === "FAIL" ? "bg-red-600 text-white border-red-600"
              : "bg-brand-blue text-white border-brand-blue"
              : "bg-white hover:bg-gray-50 border-gray-300 text-gray-700"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

export default function SupplyPage() {
  const { job, updateJob } = useJobContext();
  const supply: SupplyCharacteristics = { ...DEFAULT_SUPPLY, ...job.supply_characteristics };

  const updateField = (field: string, value: string | boolean) => {
    const updated = { ...supply, [field]: value };

    // TT earthing logic: auto-toggle means of earthing
    if (field === "earthing_arrangement") {
      if (value === "TT") {
        updated.means_earthing_electrode = true;
        updated.means_earthing_distributor = false;
      } else {
        updated.means_earthing_electrode = false;
        updated.means_earthing_distributor = true;
      }
    }

    updateJob({ supply_characteristics: updated });
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <h2 className="text-lg font-semibold">Supply Characteristics</h2>

      {/* Supply & Earthing */}
      <Card>
        <CardHeader><CardTitle className="text-base">Supply Characteristics & Earthing</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <Dropdown id="earthing" label="Earthing Arrangement" field="earthing_arrangement" options={EARTHING_ARRANGEMENTS} value={supply.earthing_arrangement} onChange={updateField} />
            <Dropdown id="live_conductors" label="Live Conductors" field="live_conductors" options={LIVE_CONDUCTORS} value={supply.live_conductors} onChange={updateField} />
            <Dropdown id="num_supplies" label="Number of Supplies" field="number_of_supplies" options={NUMBER_OF_SUPPLIES} value={supply.number_of_supplies} onChange={updateField} />
            <Dropdown id="voltage_u" label="Nominal Voltage U (V)" field="nominal_voltage_u" options={VOLTAGES} value={supply.nominal_voltage_u} onChange={updateField} />
            <Dropdown id="voltage_uo" label="Nominal Voltage Uo (V)" field="nominal_voltage_uo" options={VOLTAGES} value={supply.nominal_voltage_uo} onChange={updateField} />
            <Dropdown id="frequency" label="Nominal Frequency (Hz)" field="nominal_frequency" options={FREQUENCIES} value={supply.nominal_frequency} onChange={updateField} />
            <div className="space-y-1.5">
              <Label htmlFor="pfc">Prospective Fault Current (kA)</Label>
              <Input id="pfc" value={supply.prospective_fault_current || ""} onChange={(e) => updateField("prospective_fault_current", e.target.value)} placeholder="e.g., 2.5" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ze">External Earth Loop Impedance Ze</Label>
              <Input id="ze" value={supply.earth_loop_impedance_ze || ""} onChange={(e) => updateField("earth_loop_impedance_ze", e.target.value)} placeholder="e.g., 0.35" />
            </div>
            <div className="space-y-1.5">
              <Label>Supply Polarity Confirmed</Label>
              <ButtonGroup options={["YES", "NO", "LIM"]} value={supply.supply_polarity_confirmed as string} onChange={(v) => updateField("supply_polarity_confirmed", v)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Supply Protective Device */}
      <Card>
        <CardHeader><CardTitle className="text-base">Supply Protective Device</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4">
            <Dropdown id="spd_bs_en" label="BS/EN" field="spd_bs_en" options={SPD_BS_EN_OPTIONS} value={supply.spd_bs_en} onChange={updateField} />
            <div className="space-y-1.5">
              <Label htmlFor="spd_type">Type</Label>
              <Input id="spd_type" value={supply.spd_type_supply || ""} onChange={(e) => updateField("spd_type_supply", e.target.value)} placeholder="e.g., B, gG" />
            </div>
            <Dropdown id="spd_sc" label="Short Circuit Capacity (kA)" field="spd_short_circuit" options={SHORT_CIRCUIT_CAPACITY} value={supply.spd_short_circuit} onChange={updateField} />
            <Dropdown id="spd_current" label="Rated Current (A)" field="spd_rated_current" options={SPD_RATED_CURRENT} value={supply.spd_rated_current} onChange={updateField} />
          </div>
        </CardContent>
      </Card>

      {/* Means of Earthing */}
      <Card>
        <CardHeader><CardTitle className="text-base">Means of Earthing</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={supply.means_earthing_distributor || false} onChange={(e) => updateField("means_earthing_distributor", e.target.checked)} className="h-4 w-4 rounded border-gray-300" />
              <span className="text-sm">Distributor&apos;s Facility</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={supply.means_earthing_electrode || false} onChange={(e) => updateField("means_earthing_electrode", e.target.checked)} className="h-4 w-4 rounded border-gray-300" />
              <span className="text-sm">Earth Electrode</span>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Main Switch */}
      <Card>
        <CardHeader><CardTitle className="text-base">Main Switch / Fuse / CB / RCD</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4">
            <Dropdown id="ms_bs_en" label="BS/EN" field="main_switch_bs_en" options={MAIN_SWITCH_BS_EN} value={supply.main_switch_bs_en} onChange={updateField} />
            <Dropdown id="ms_poles" label="No. of Poles" field="main_switch_poles" options={NUMBER_OF_POLES} value={supply.main_switch_poles} onChange={updateField} />
            <Dropdown id="ms_voltage" label="Voltage Rating (V)" field="main_switch_voltage" options={VOLTAGE_RATINGS} value={supply.main_switch_voltage} onChange={updateField} />
            <Dropdown id="ms_current" label="Current Rating (A)" field="main_switch_current" options={MAIN_SWITCH_CURRENT} value={supply.main_switch_current} onChange={updateField} />
            <div className="space-y-1.5">
              <Label htmlFor="ms_fuse">Fuse/Setting</Label>
              <Input id="ms_fuse" value={supply.main_switch_fuse_setting || ""} onChange={(e) => updateField("main_switch_fuse_setting", e.target.value)} placeholder="e.g., 100A" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ms_location">Location</Label>
              <Input id="ms_location" value={supply.main_switch_location || ""} onChange={(e) => updateField("main_switch_location", e.target.value)} placeholder="e.g., Under stairs" />
            </div>
            <Dropdown id="ms_material" label="Conductor Material" field="main_switch_conductor_material" options={CONDUCTOR_MATERIALS} value={supply.main_switch_conductor_material} onChange={updateField} />
            <Dropdown id="ms_csa" label="Conductor CSA (mm2)" field="main_switch_conductor_csa" options={CONDUCTOR_CSA} value={supply.main_switch_conductor_csa} onChange={updateField} />
          </div>
        </CardContent>
      </Card>

      {/* RCD */}
      <Card>
        <CardHeader><CardTitle className="text-base">RCD</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Dropdown id="rcd_oc" label="Operating Current" field="rcd_operating_current" options={RCD_OPERATING_CURRENT} value={supply.rcd_operating_current} onChange={updateField} />
              <Input value={supply.rcd_operating_current_test || ""} onChange={(e) => updateField("rcd_operating_current_test", e.target.value)} placeholder="Test result" />
            </div>
            <div className="space-y-2">
              <Dropdown id="rcd_td" label="Time Delay" field="rcd_time_delay" options={["Select...", "0", "S", "N/A", "LIM"]} value={supply.rcd_time_delay} onChange={updateField} />
              <Input value={supply.rcd_time_delay_test || ""} onChange={(e) => updateField("rcd_time_delay_test", e.target.value)} placeholder="Test result (ms)" />
            </div>
            <div className="space-y-2">
              <Dropdown id="rcd_ot" label="Operating Time" field="rcd_operating_time" options={["Select...", "N/A", "LIM"]} value={supply.rcd_operating_time} onChange={updateField} />
              <Input value={supply.rcd_operating_time_test || ""} onChange={(e) => updateField("rcd_operating_time_test", e.target.value)} placeholder="Test result (ms)" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Earthing Conductor */}
      <Card>
        <CardHeader><CardTitle className="text-base">Earthing Conductor</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <Dropdown id="ec_material" label="Material" field="earthing_conductor_material" options={CONDUCTOR_MATERIALS} value={supply.earthing_conductor_material} onChange={updateField} />
            <Dropdown id="ec_csa" label="CSA (mm2)" field="earthing_conductor_csa" options={CONDUCTOR_CSA} value={supply.earthing_conductor_csa} onChange={updateField} />
            <div className="space-y-1.5">
              <Label>Continuity</Label>
              <ButtonGroup options={["PASS", "FAIL", "LIM", "N/A"]} value={supply.earthing_conductor_continuity} onChange={(v) => updateField("earthing_conductor_continuity", v)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main Protective Bonding */}
      <Card>
        <CardHeader><CardTitle className="text-base">Main Protective Bonding</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <Dropdown id="bc_material" label="Material" field="bonding_conductor_material" options={CONDUCTOR_MATERIALS} value={supply.bonding_conductor_material} onChange={updateField} />
            <Dropdown id="bc_csa" label="CSA (mm2)" field="bonding_conductor_csa" options={BONDING_CSA} value={supply.bonding_conductor_csa} onChange={updateField} />
            <div className="space-y-1.5">
              <Label>Continuity</Label>
              <ButtonGroup options={["PASS", "FAIL", "LIM", "N/A"]} value={supply.bonding_conductor_continuity} onChange={(v) => updateField("bonding_conductor_continuity", v)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Bonding of Extraneous Parts */}
      <Card>
        <CardHeader><CardTitle className="text-base">Bonding of Extraneous Parts</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-5 gap-4">
            {(["bonding_water", "bonding_gas", "bonding_oil", "bonding_structural_steel", "bonding_lightning"] as const).map((field) => (
              <div key={field} className="space-y-1.5">
                <Label className="text-center block capitalize">{field.replace("bonding_", "").replace("_", " ")}</Label>
                <ButtonGroup options={["PASS", "FAIL", "LIM", "N/A"]} value={supply[field] as string} onChange={(v) => updateField(field, v)} />
              </div>
            ))}
          </div>
          <div className="border-t pt-4">
            <div className="flex items-center gap-4 mb-2">
              <Label>Other</Label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={supply.bonding_other_na || false} onChange={(e) => { updateField("bonding_other_na", e.target.checked); if (e.target.checked) updateField("bonding_other", ""); }} className="h-4 w-4 rounded border-gray-300" />
                <span className="text-sm text-gray-500">N/A</span>
              </label>
            </div>
            <Input value={supply.bonding_other || ""} onChange={(e) => updateField("bonding_other", e.target.value)} placeholder="Extraneous bonding to other service(s)" disabled={supply.bonding_other_na || false} className={supply.bonding_other_na ? "bg-gray-100" : ""} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
