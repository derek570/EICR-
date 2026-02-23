"use client";

import { useJob } from "../layout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SupplyCharacteristics } from "@/lib/api";
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

export default function SupplyPage() {
  const { job, updateJob } = useJob();
  const supply: SupplyCharacteristics = job.supply_characteristics || {
    // Section 1: Supply Characteristics & Earthing
    earthing_arrangement: "TN-C-S",
    live_conductors: "AC - 1-phase (2 wire)",
    number_of_supplies: "1",
    nominal_voltage_u: "230",
    nominal_voltage_uo: "230",
    nominal_frequency: "50",
    prospective_fault_current: "",
    earth_loop_impedance_ze: "",
    supply_polarity_confirmed: "",
    // Section 2: Supply Protective Device
    spd_bs_en: "",
    spd_type_supply: "",
    spd_short_circuit: "",
    spd_rated_current: "",
    // Section 3: Means of Earthing
    means_earthing_distributor: false,
    means_earthing_electrode: false,
    // Section 4: Main Switch/Fuse/CB/RCD
    main_switch_bs_en: "",
    main_switch_poles: "",
    main_switch_voltage: "",
    main_switch_current: "",
    main_switch_fuse_setting: "",
    main_switch_location: "",
    main_switch_conductor_material: "",
    main_switch_conductor_csa: "",
    // Section 5: RCD
    rcd_operating_current: "",
    rcd_time_delay: "",
    rcd_operating_time: "",
    rcd_operating_current_test: "",
    rcd_time_delay_test: "",
    rcd_operating_time_test: "",
    // Section 6: Earthing Conductor
    earthing_conductor_material: "",
    earthing_conductor_csa: "",
    earthing_conductor_continuity: "",
    // Section 7: Main Protective Bonding
    bonding_conductor_material: "",
    bonding_conductor_csa: "",
    bonding_conductor_continuity: "",
    // Section 8: Bonding of Extraneous Parts
    bonding_water: "",
    bonding_gas: "",
    bonding_oil: "",
    bonding_structural_steel: "",
    bonding_lightning: "",
    bonding_other: "",
    bonding_other_na: false,
  };

  const updateField = <K extends keyof SupplyCharacteristics>(field: K, value: SupplyCharacteristics[K]) => {
    updateJob({ supply_characteristics: { ...supply, [field]: value } });
  };

  // Button group component for YES/NO/LIM
  const YesNoLimButtons = ({ field, value }: { field: keyof SupplyCharacteristics; value: string | undefined }) => (
    <div className="flex gap-1">
      {["YES", "NO", "LIM"].map((opt) => (
        <button
          key={opt}
          onClick={() => updateField(field, opt)}
          className={`px-3 py-1 text-sm rounded border ${
            value === opt
              ? "bg-primary text-primary-foreground"
              : "bg-background hover:bg-muted"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );

  // Button group component for PASS/FAIL/LIM/N/A
  const PassFailButtons = ({ field, value }: { field: keyof SupplyCharacteristics; value: string | undefined }) => (
    <div className="flex gap-1">
      {["PASS", "FAIL", "LIM", "N/A"].map((opt) => (
        <button
          key={opt}
          onClick={() => updateField(field, opt)}
          className={`px-3 py-1 text-sm rounded border ${
            value === opt
              ? opt === "PASS"
                ? "bg-green-600 text-white"
                : opt === "FAIL"
                ? "bg-red-600 text-white"
                : "bg-primary text-primary-foreground"
              : "bg-background hover:bg-muted"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );

  // Quick buttons for N/A and LIM (for RCD dropdowns)
  const NALIMButtons = ({ field, value }: { field: keyof SupplyCharacteristics; value: string | undefined }) => (
    <div className="flex gap-1 mt-1">
      {["N/A", "LIM"].map((opt) => (
        <button
          key={opt}
          onClick={() => updateField(field, opt)}
          className={`px-2 py-0.5 text-xs rounded border ${
            value === opt
              ? "bg-primary text-primary-foreground"
              : "bg-background hover:bg-muted"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );

  // Dropdown component
  const Dropdown = ({
    id,
    label,
    field,
    options,
    value,
  }: {
    id: string;
    label: string;
    field: keyof SupplyCharacteristics;
    options: string[];
    value: string | undefined;
  }) => (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value || ""}
        onChange={(e) => updateField(field, e.target.value)}
        className="w-full h-10 rounded-md border border-input px-3 bg-background"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );

  // Material dropdown with Copper quick-select button
  const MaterialDropdownWithQuickSelect = ({
    id,
    label,
    field,
    value,
  }: {
    id: string;
    label: string;
    field: keyof SupplyCharacteristics;
    value: string | undefined;
  }) => (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value || ""}
        onChange={(e) => updateField(field, e.target.value)}
        className="w-full h-10 rounded-md border border-input px-3 bg-background"
      >
        {CONDUCTOR_MATERIALS.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      <button
        onClick={() => updateField(field, "Copper")}
        className={`mt-1 px-2 py-0.5 text-xs rounded border ${
          value === "Copper"
            ? "bg-amber-600 text-white"
            : "bg-background hover:bg-amber-100 text-amber-700 border-amber-300"
        }`}
      >
        Copper
      </button>
    </div>
  );

  // RCD field with dropdown, N/A/LIM buttons, and test result input
  const RCDFieldWithTest = ({
    id,
    label,
    dropdownField,
    testField,
    options,
    dropdownValue,
    testValue,
    unit,
    showUnit = false,
  }: {
    id: string;
    label: string;
    dropdownField: keyof SupplyCharacteristics;
    testField: keyof SupplyCharacteristics;
    options: string[];
    dropdownValue: string | undefined;
    testValue: string | undefined;
    unit?: string;
    showUnit?: boolean;
  }) => (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={dropdownValue || ""}
        onChange={(e) => updateField(dropdownField, e.target.value)}
        className="w-full h-10 rounded-md border border-input px-3 bg-background"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-1">
        <NALIMButtons field={dropdownField} value={dropdownValue} />
        {showUnit && <span className="text-xs text-muted-foreground ml-2">{unit}</span>}
      </div>
      <div className="relative">
        <Input
          value={testValue || ""}
          onChange={(e) => updateField(testField, e.target.value)}
          placeholder="Test result"
          className="pr-8"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          {"\u03A9"}
        </span>
      </div>
    </div>
  );

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-semibold">Supply Characteristics</h2>

      {/* Section 1: Supply Characteristics & Earthing */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Supply Characteristics & Earthing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <Dropdown
              id="earthing"
              label="Earthing Arrangement"
              field="earthing_arrangement"
              options={EARTHING_ARRANGEMENTS}
              value={supply.earthing_arrangement}
            />
            <Dropdown
              id="live_conductors"
              label="Live Conductors"
              field="live_conductors"
              options={LIVE_CONDUCTORS}
              value={supply.live_conductors}
            />
            <Dropdown
              id="num_supplies"
              label="Number of Supplies"
              field="number_of_supplies"
              options={NUMBER_OF_SUPPLIES}
              value={supply.number_of_supplies}
            />
            <Dropdown
              id="voltage_u"
              label="Nominal Voltage U (V)"
              field="nominal_voltage_u"
              options={VOLTAGES}
              value={supply.nominal_voltage_u}
            />
            <Dropdown
              id="voltage_uo"
              label="Nominal Voltage Uo (V)"
              field="nominal_voltage_uo"
              options={VOLTAGES}
              value={supply.nominal_voltage_uo}
            />
            <Dropdown
              id="frequency"
              label="Nominal Frequency (Hz)"
              field="nominal_frequency"
              options={FREQUENCIES}
              value={supply.nominal_frequency}
            />
            <div>
              <Label htmlFor="pfc">Prospective Fault Current (kA)</Label>
              <Input
                id="pfc"
                value={supply.prospective_fault_current || ""}
                onChange={(e) => updateField("prospective_fault_current", e.target.value)}
                placeholder="e.g., 2.5"
              />
            </div>
            <div>
              <Label htmlFor="ze">External Earth Loop Impedance Ze (Ohm)</Label>
              <Input
                id="ze"
                value={supply.earth_loop_impedance_ze || ""}
                onChange={(e) => updateField("earth_loop_impedance_ze", e.target.value)}
                placeholder="e.g., 0.35"
              />
            </div>
            <div>
              <Label>Supply Polarity Confirmed</Label>
              <YesNoLimButtons field="supply_polarity_confirmed" value={supply.supply_polarity_confirmed as string} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section 2: Supply Protective Device */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Supply Protective Device</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Dropdown
              id="spd_bs_en"
              label="BS/EN"
              field="spd_bs_en"
              options={SPD_BS_EN_OPTIONS}
              value={supply.spd_bs_en}
            />
            <div>
              <Label htmlFor="spd_type">Type</Label>
              <Input
                id="spd_type"
                value={supply.spd_type_supply || ""}
                onChange={(e) => updateField("spd_type_supply", e.target.value)}
                placeholder="e.g., B, gG"
              />
            </div>
            <Dropdown
              id="spd_sc"
              label="Short Circuit Capacity (kA)"
              field="spd_short_circuit"
              options={SHORT_CIRCUIT_CAPACITY}
              value={supply.spd_short_circuit}
            />
            <Dropdown
              id="spd_current"
              label="Rated Current (A)"
              field="spd_rated_current"
              options={SPD_RATED_CURRENT}
              value={supply.spd_rated_current}
            />
          </div>
        </CardContent>
      </Card>

      {/* Section 3: Means of Earthing */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">PARTICULARS OF INSTALLATION</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground mb-2">Means of Earthing</p>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={supply.means_earthing_distributor || false}
                onChange={(e) => updateField("means_earthing_distributor", e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <span className="text-sm">Distributor&apos;s Facility</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={supply.means_earthing_electrode || false}
                onChange={(e) => updateField("means_earthing_electrode", e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <span className="text-sm">Earth Electrode</span>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Section 4: Main Switch/Fuse/CB/RCD */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Main Switch / Fuse / CB / RCD</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Dropdown
              id="main_switch_bs_en"
              label="BS/EN"
              field="main_switch_bs_en"
              options={MAIN_SWITCH_BS_EN}
              value={supply.main_switch_bs_en}
            />
            <Dropdown
              id="main_switch_poles"
              label="No. of Poles"
              field="main_switch_poles"
              options={NUMBER_OF_POLES}
              value={supply.main_switch_poles}
            />
            <Dropdown
              id="main_switch_voltage"
              label="Voltage Rating (V)"
              field="main_switch_voltage"
              options={VOLTAGE_RATINGS}
              value={supply.main_switch_voltage}
            />
            <Dropdown
              id="main_switch_current"
              label="Current Rating (A)"
              field="main_switch_current"
              options={MAIN_SWITCH_CURRENT}
              value={supply.main_switch_current}
            />
            <div>
              <Label htmlFor="main_switch_fuse">Fuse/Setting</Label>
              <Input
                id="main_switch_fuse"
                value={supply.main_switch_fuse_setting || ""}
                onChange={(e) => updateField("main_switch_fuse_setting", e.target.value)}
                placeholder="e.g., 100A"
              />
            </div>
            <div>
              <Label htmlFor="main_switch_location">Location</Label>
              <Input
                id="main_switch_location"
                value={supply.main_switch_location || ""}
                onChange={(e) => updateField("main_switch_location", e.target.value)}
                placeholder="e.g., Under stairs"
              />
            </div>
            <Dropdown
              id="main_switch_material"
              label="Conductor Material"
              field="main_switch_conductor_material"
              options={CONDUCTOR_MATERIALS}
              value={supply.main_switch_conductor_material}
            />
            <Dropdown
              id="main_switch_csa"
              label="Conductor CSA (mm2)"
              field="main_switch_conductor_csa"
              options={CONDUCTOR_CSA}
              value={supply.main_switch_conductor_csa}
            />
          </div>
        </CardContent>
      </Card>

      {/* Section 5: RCD - Enhanced with test results and quick buttons */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">RCD</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <RCDFieldWithTest
              id="rcd_operating_current"
              label="RCD operating current I\u0394n"
              dropdownField="rcd_operating_current"
              testField="rcd_operating_current_test"
              options={RCD_OPERATING_CURRENT}
              dropdownValue={supply.rcd_operating_current}
              testValue={supply.rcd_operating_current_test}
            />
            <RCDFieldWithTest
              id="rcd_time_delay"
              label="RCD time delay I\u0394n"
              dropdownField="rcd_time_delay"
              testField="rcd_time_delay_test"
              options={["Select...", "0", "S", "N/A", "LIM"]}
              dropdownValue={supply.rcd_time_delay}
              testValue={supply.rcd_time_delay_test}
              unit="ms"
              showUnit={true}
            />
            <RCDFieldWithTest
              id="rcd_operating_time"
              label="RCD operating time I\u0394n"
              dropdownField="rcd_operating_time"
              testField="rcd_operating_time_test"
              options={["Select...", "N/A", "LIM"]}
              dropdownValue={supply.rcd_operating_time}
              testValue={supply.rcd_operating_time_test}
              unit="ms"
              showUnit={true}
            />
          </div>
        </CardContent>
      </Card>

      {/* Section 6: Earthing Conductor - with Copper quick-select */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Earthing Conductor</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <MaterialDropdownWithQuickSelect
              id="earthing_conductor_material"
              label="Material"
              field="earthing_conductor_material"
              value={supply.earthing_conductor_material}
            />
            <Dropdown
              id="earthing_conductor_csa"
              label="CSA (mm2)"
              field="earthing_conductor_csa"
              options={CONDUCTOR_CSA}
              value={supply.earthing_conductor_csa}
            />
            <div>
              <Label>Continuity</Label>
              <PassFailButtons field="earthing_conductor_continuity" value={supply.earthing_conductor_continuity} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section 7: Main Protective Bonding - with Copper quick-select */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Main Protective Bonding</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <MaterialDropdownWithQuickSelect
              id="bonding_conductor_material"
              label="Material"
              field="bonding_conductor_material"
              value={supply.bonding_conductor_material}
            />
            <Dropdown
              id="bonding_conductor_csa"
              label="CSA (mm2)"
              field="bonding_conductor_csa"
              options={BONDING_CSA}
              value={supply.bonding_conductor_csa}
            />
            <div>
              <Label>Continuity</Label>
              <PassFailButtons field="bonding_conductor_continuity" value={supply.bonding_conductor_continuity} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section 8: Bonding of Extraneous Parts - Enhanced Other field */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bonding of Extraneous Parts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            <div>
              <Label className="text-center block mb-2">Water</Label>
              <PassFailButtons field="bonding_water" value={supply.bonding_water} />
            </div>
            <div>
              <Label className="text-center block mb-2">Gas</Label>
              <PassFailButtons field="bonding_gas" value={supply.bonding_gas} />
            </div>
            <div>
              <Label className="text-center block mb-2">Oil</Label>
              <PassFailButtons field="bonding_oil" value={supply.bonding_oil} />
            </div>
            <div>
              <Label className="text-center block mb-2">Structural Steel</Label>
              <PassFailButtons field="bonding_structural_steel" value={supply.bonding_structural_steel} />
            </div>
            <div>
              <Label className="text-center block mb-2">Lightning</Label>
              <PassFailButtons field="bonding_lightning" value={supply.bonding_lightning} />
            </div>
          </div>

          {/* Enhanced "Other" field with N/A checkbox */}
          <div className="border-t pt-4 mt-4">
            <div className="flex items-center gap-4 mb-2">
              <Label className="font-medium">Other</Label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={supply.bonding_other_na || false}
                  onChange={(e) => {
                    updateField("bonding_other_na", e.target.checked);
                    if (e.target.checked) {
                      updateField("bonding_other", "");
                    }
                  }}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <span className="text-sm text-muted-foreground">N/A</span>
              </label>
            </div>
            <Input
              id="bonding_other"
              value={supply.bonding_other || ""}
              onChange={(e) => updateField("bonding_other", e.target.value)}
              placeholder="Extraneous bonding to other service(s)"
              disabled={supply.bonding_other_na}
              className={supply.bonding_other_na ? "bg-muted" : ""}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
