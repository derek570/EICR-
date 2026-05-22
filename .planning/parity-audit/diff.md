# iOS ↔ Web Parity Diff (2026-04-25)

Source enumerations:
- iOS: `.planning/parity-audit/ios-surface.md`
- Web: `.planning/parity-audit/web-surface.md`

Symmetric: each row checks both directions. Rows marked **No** are gaps. Severity is mine after looking at both sides.

---

## Section 2 — Job workflow tabs (the big one)

iOS branches the tab list by certificate type. Web does not. Web's single unified list = iOS EIC's list.

| iOS EICR | iOS EIC | Web (unified) | Match? | Severity |
|----------|---------|---------------|--------|----------|
| Overview | Overview | Overview | Yes | — |
| Installation | Installation | Installation | Yes | — |
| Supply | Supply | Supply | Yes | — |
| Board | Board | Board | Yes | — |
| Circuits | Circuits | Circuits | Yes | — |
| **Observations** | — | — *(non-tab route only at `/job/[id]/observations`, FAB-triggered)* | **No** | **MAJOR** — main tab on iOS EICR, demoted to hidden route on web |
| Inspection | Inspection | Inspection | Yes | — |
| — | Extent | **Extent** *(shows on EICR too)* | **No** | **MAJOR** — phantom tab on web EICR |
| — | Design | **Design** *(shows on EICR too)* | **No** | **MAJOR** — phantom tab on web EICR (the one you spotted) |
| Staff | Staff | Staff | Yes | — |
| PDF | PDF | PDF | Yes | — |

**Root cause:** `web/src/components/job/job-tab-nav.tsx:49-60` declares one array used for every job regardless of `certificate_type`. The fix is a per-type tab list (or a filter on the unified array), not just deleting Design — Observations also needs promoting back to a main tab for EICR.

---

## Section 3 — Settings

| iOS | Web | Match? | Severity |
|-----|-----|--------|----------|
| Company Details (`SettingsHubView.swift:114`) | `/settings/company` | Yes | — |
| Staff Management (`SettingsHubView.swift:122`) | `/settings/staff`, `/settings/staff/[inspectorId]` | Yes | — |
| Company Dashboard, admin (`SettingsHubView.swift:133`) | `/settings/company/dashboard` | Yes | — |
| Invite Employee, admin (`SettingsHubView.swift:141`) | `/settings/invite` (+ sheet on dashboard) | Yes | — |
| Cable Size Defaults (`SettingsHubView.swift:159`) | `/settings/defaults/cable` | Yes | — |
| Default Values (`SettingsHubView.swift:167`) | `/settings/defaults/values`, `/settings/defaults` | Yes | — |
| Change Password (`SettingsHubView.swift:184`) | `/settings/change-password` | Yes | — |
| **Audio Import** (`SettingsHubView.swift:201` → `AudioImportView.swift`) | — | **No** | **MAJOR** — entire surface missing on web |
| **Terms & Legal** (`SettingsHubView.swift:209` → `TermsAcceptanceView`) | — *(`/settings/about` exists but is not a legal-docs viewer)* | **No** | **MEDIUM** — verify whether About covers it |
| **Manage Users**, system admin (`SettingsView.swift:221`) | `/settings/admin/users` (+ `/new`, `/[userId]`) | Yes | — *(named differently — fine)* |
| **System Stats**, system admin (`SettingsView.swift:250`) | — *(`/settings/company/dashboard` has a Stats tab, but it's company-scoped, not system-wide)* | **No** | **MEDIUM** — system-admin observability gap |
| **Task Queue**, system admin (`SettingsView.swift:279`) | — | **No** | **MEDIUM** — system-admin job-queue view gap |
| — | `/settings/about` (`web-surface.md:39`) | extra | LOW — docs page, not a parity bug per se |
| — | `/settings/debug` (`web-surface.md:43`) | extra | LOW — dev-only |
| — | `/settings/diagnostics` (`web-surface.md:47`) | extra | LOW — web-specific telemetry |
| — | `/settings/system` (Offline Sync Admin, `web-surface.md:51`) | extra | OK — PWA-only concern, iOS sync is native |

---

## Section 4 — Modals / sheets

iOS uses sheets heavily; web uses pages for most equivalents. That's architectural and fine. The substantive parity questions are about **destinations**, not chrome.

| iOS surface | Web equivalent | Match? | Severity |
|-------------|----------------|--------|----------|
| Add/Edit Observation sheet (`ObservationsTab.swift:52-56`) | `observation-sheet.tsx:62` | Yes | — |
| **Apply Defaults sheet** (`JobDetailView.swift:433`) | — *(no in-job "apply defaults" affordance found in enumeration)* | **No** | **MEDIUM** — verify presence on a job page |
| CCU Extraction Mode sheet | `ccu-mode-sheet.tsx` | Yes | — |
| Circuit Match Review sheet | `/job/[id]/circuits/match-review` page | Yes (page vs sheet OK) | — |
| **Job Photos Picker** (in EditObservation, `EditObservationSheet.swift:215`) | — *(observation-sheet has camera + library `<input>`, no in-job-photo picker)* | **No** | **MINOR** — verify whether it exists |
| PDF Preview sheet (`PDFTab.swift:53`) | PDF tab page | Yes | — |
| General Condition / Purpose of Report / Installation Type pickers (`LiveFillView.swift:109/124/147`) | inline `<select>` (presumed; not enumerated explicitly) | **Verify** | LOW — likely inline selects, but worth confirming |
| Edit User / Create User sheets | `/settings/admin/users/new`, `/settings/admin/users/[userId]` | Yes | — |
| New / Edit Preset Defaults sheets (`DefaultsManagerView.swift:246/251`) | `/settings/defaults/values` form (presumed) | **Verify** | MEDIUM — confirm presets can be created/edited from web |
| Terms Document viewer (`TermsAcceptanceView.swift:94`) | — | **No** | **MEDIUM** — depends on whether web requires terms acceptance |
| **Preset Picker on new job** (`DashboardView.swift:262`) | — *(dashboard `Start EICR` / `Start EIC` flow not enumerated as offering a picker)* | **No** | **MEDIUM** — verify the new-job flow on web |

---

## Section 5 — Admin / management

| iOS | Web | Match? | Severity |
|-----|-----|--------|----------|
| Manage Users (system admin) | `/settings/admin/users` | Yes | — |
| **System Stats** (system admin) | — | **No** | **MEDIUM** — already flagged in Settings |
| **Task Queue** (system admin) | — | **No** | **MEDIUM** — already flagged in Settings |
| Company Dashboard (company admin) | `/settings/company/dashboard` | Yes | — |
| Invite Employee (company admin) | `/settings/invite` (+ sheet) | Yes | — |
| — | Offline Sync Admin (`/settings/system`) | extra | OK — PWA-only |

---

## Section 6 — Capture flows

| iOS | Web | Match? | Severity |
|-----|-----|--------|----------|
| Voice Recording & Live Fill | `recording-chrome.tsx` + FAB | Yes | — |
| CCU (Fuseboard) Extraction | `circuits/page.tsx` + `ccu-mode-sheet.tsx` | Yes | — |
| Document Extraction (Take / Library / Files dialog → camera/picker/file importer) | `circuits/page.tsx` "Extract Doc" inline file input | **Partial** | **MEDIUM** — verify all three iOS sources (camera, library, files) are present on web |
| Observation Photo Capture | `observation-sheet.tsx` two-input pattern | Yes | — |
| **Audio Import** (`AudioImportView.swift`) | — | **No** | **MAJOR** — entire surface missing on web |
| Signature pad (inside Inspector edit) | `signature-canvas.tsx` (inside `/settings/staff/[inspectorId]`) | Yes | — |

---

## Severity-grouped summary

### MAJOR (real parity bugs)
1. **Web tab nav is unified, not per-certificate-type.** Web EICR shows phantom Extent + Design tabs and demotes Observations from a main tab to a non-tab route. Fix at `web/src/components/job/job-tab-nav.tsx:49-60`.
2. **Audio Import is entirely missing on web.** iOS exposes it from the Settings hub and uses `AudioImportView.swift` for an alternate ingest path. No web equivalent.

### MEDIUM (worth verifying / probably bugs)
3. **System Stats and Task Queue (system-admin pages) missing on web.**
4. **Apply Defaults in-job sheet missing.** iOS lets an inspector apply a saved preset to a job (`JobDetailView.swift:433`). Web's enumeration didn't surface an equivalent affordance.
5. **Preset picker on new job creation missing.** iOS shows `PresetPickerSheet` when starting a new EICR/EIC if multiple presets exist (`DashboardView.swift:262`). Web's "Start EICR / Start EIC" flow wasn't enumerated as offering this.
6. **Document extraction sources may be reduced on web.** iOS has Take Photo / Library / Files. Web has an inline file input — confirm all three sources are reachable.
7. **Preset Defaults create/edit chrome.** iOS has dedicated sheets (`DefaultsManagerView.swift:246/251`). Confirm web `/settings/defaults/values` covers create+edit, not just edit-existing.
8. **Terms / Legal viewer.** iOS has a dedicated `TermsAcceptanceView`. Web has `/settings/about` — confirm whether legal docs are viewable from web.

### LOW / architectural (probably fine, just note)
9. Web has `/settings/about`, `/settings/debug`, `/settings/diagnostics`, `/settings/system` — none have iOS equivalents but all are web-platform-specific.
10. Web uses pages where iOS uses sheets (Edit User, Match Review, etc.) — same destination, different chrome. Not a bug.
11. iOS option-picker sheets (General Condition, Purpose of Report, Installation Type) are likely inline `<select>` on web. Confirm but not blocking.

---

## What this audit didn't cover

- **Form field parity** (29 circuit columns, property fields, observations fields, tests fields). That's its own audit — should be a third pass with `field_schema.json` ↔ iOS `Constants.swift` as the ground truth on each side.
- **Behavioural parity** (e.g. does the recording auto-sleep on web? does extraction priority match the 3-tier rule? does CCU per-slot extraction get used by web?). Visual surface only here.
- **PDF output parity** (server ReportLab path vs iOS WKWebView template). The PDFs themselves are not byte-identical and won't be from this enumeration.
- **MEDIUM rows above are flagged from absence in the enumeration, not from confirmed code lookups.** Each one needs a 30-second grep to upgrade to bug or downgrade to non-issue.
