# iOS Surface Enumeration

## 1. Top-level app shell tabs (root TabView)

The app does NOT use a traditional TabView at the root level. Instead, it uses a single-view hierarchy:
- RootView (CertMateApp.swift:12-14) → ContentView → MainTabView → DashboardView
- DashboardView is the root that contains all primary navigation via NavigationStack
- Segmented navigation buttons in DashboardView toolbar:
  - Alerts button, line 204-210 of DashboardView.swift, navigates to AlertsView (line 226-228)
  - Settings button, line 212-219 of DashboardView.swift, navigates to SettingsHubView (line 223-225)

## 2. EICR/EIC job workflow tabs

When a user opens a job via NavigationLink(value: job) in DashboardView (line 135), they navigate to JobDetailView (line 192). JobDetailView presents a TabView with the following tabs:

**For EICR (Certificate Type .eicr)** — JobDetailView.swift lines 345-355:
1. Overview (tag 0) — displays LiveFillView, line 280
2. Installation (tag 1) — InstallationTab, line 308
3. Supply (tag 2) — SupplyTab, line 309
4. Board (tag 3) — BoardTab, line 310
5. Circuits (tag 4) — CircuitsTab, line 311
6. Observations (tag 5) — ObservationsTab, line 320
7. Inspection (tag 6) — InspectionTab, line 321
8. Staff (tag 7) — InspectorTab, line 322
9. PDF (tag 8) — PDFTab, line 323

**For EIC (Certificate Type .eic)** — JobDetailView.swift lines 332-342:
1. Overview (tag 0) — displays LiveFillView, line 280
2. Installation (tag 1) — InstallationTab, line 308
3. Supply (tag 2) — SupplyTab, line 309
4. Board (tag 3) — BoardTab, line 310
5. Circuits (tag 4) — CircuitsTab, line 311
6. Inspection (tag 5) — InspectionTab, line 314
7. Extent (tag 6) — ExtentTab, line 315
8. Design (tag 7) — DesignTab, line 316
9. Staff (tag 8) — InspectorTab, line 317
10. PDF (tag 9) — PDFTab, line 318

## 3. Settings hub pages

All settings pages are reachable from SettingsHubView.swift. Structure:

**From SettingsHubView NavigationLinks:**
- Company Details, line 114-117, destination CompanyDetailsView, line 115
- Staff Management, line 122-125, destination InspectorListView, line 123
- Company Dashboard (admin only), line 133-136, destination CompanyDashboardView, line 134
- Invite Employee (admin only), line 141-144, destination InviteEmployeeView, line 142
- Cable Size Defaults, line 159-162, destination CableSizeDefaultsView, line 160
- Default Values, line 167-170, destination DefaultValuesView, line 168
- Change Password, line 184-187, destination ChangePasswordView, line 185
- Audio Import, line 201-204, destination AudioImportView, line 202
- Terms & Legal, line 209-212, destination TermsAcceptanceView, line 210

**From SettingsView.swift (legacy sheet):**
- Change Password, line 141-143, destination ChangePasswordView, line 142
- Company Dashboard (admin only), line 181-182, destination CompanyDashboardView, line 182
- Manage Users (system admin only), line 221-223, destination AdminUsersListView, line 222
- System Stats (system admin only), line 250-251, destination AdminStatsView, line 251
- Task Queue (system admin only), line 279-280, destination AdminQueueView, line 280

## 4. Modal sheets and full-screen covers

**PhotoCaptureView full-screen covers:**
- Observation photo capture, JobDetailView.swift:418, activePhotoMode = .observation, captures via PhotoCaptureView line 421
- CCU photo capture with rail guide, JobDetailView.swift:418, activePhotoMode = .ccu, captures via PhotoCaptureView line 425 with withRailGuide closure
- Document extraction camera, JobDetailView.swift:534, showDocExtractCamera, PhotoCaptureView line 535
- Observation photo in EditObservationSheet.swift:207, showCamera, PhotoCaptureView line 208
- Fuseboard camera in CircuitsTab.swift:387, showFuseboardCamera, PhotoCaptureView line 388 with withRailGuide
- Document camera in CircuitsTab.swift:505, showDocumentCamera, PhotoCaptureView line 506
- Audio import camera in AudioImportView.swift:99, showCamera, PhotoCaptureView line 100

**Sheet modals:**
- Add Observation, ObservationsTab.swift:52, showAddForm, AddObservationSheet line 53
- Edit Observation, ObservationsTab.swift:55, editingObservation, EditObservationSheet line 56
- Edit Observation (Inspection tab), InspectionTab.swift:40, editingObservation, EditObservationSheet line 41
- Defaults Manager, JobDetailView.swift:430, showDefaultsEditor, DefaultsManagerView line 431
- Apply Defaults, JobDetailView.swift:433, showApplyDefaults, ApplyDefaultsSheet line 434
- CCU Extraction Mode, JobDetailView.swift:478, extractionVM.showModeSheet, CCUExtractionModeSheet line 479
- Circuit Match Review, JobDetailView.swift:486, extractionVM.showMatchReview, CircuitMatchReviewView line 487
- Job Photos Picker, EditObservationSheet.swift:215, showJobPhotosPicker, JobPhotosPickerSheet line 216
- PDF Preview, PDFTab.swift:53, showPreview, PDF preview sheet line 54
- General Condition Picker, LiveFillView.swift:109, showGeneralConditionPicker, OptionPickerSheet line 110
- Purpose of Report Picker, LiveFillView.swift:124, showPurposeOfReportPicker, OptionPickerSheet line 125
- Installation Type Picker, LiveFillView.swift:147, showInstallationTypePicker, OptionPickerSheet line 148
- Invite Employee, CompanyDashboardView.swift:250, showInviteEmployee, InviteEmployeeView line 252
- Terms Document View, TermsAcceptanceView.swift:94, showingDocument, LegalDocumentView line 95
- Edit User (admin), AdminUsersListView.swift:125, selectedUser, AdminEditUserView line 126
- Create User (admin), AdminUsersListView.swift:132, showCreateUser, AdminCreateUserView line 133
- New Preset Defaults, DefaultsManagerView.swift:246, showNewPreset, DefaultValuesView line 247
- Edit Preset Defaults, DefaultsManagerView.swift:251, editingPreset, DefaultValuesView line 252
- Circuit Reassignment, CircuitMatchReviewView.swift:64, reassignBinding, reassignSheet line 65
- Preset Picker, DashboardView.swift:262, showPresetPicker, PresetPickerSheet line 270
- Settings sheet, DashboardView.swift:236, showSettings, SettingsView line 237
- Company Details sheet, DashboardView.swift:242, showCompanyDetails, CompanyDetailsView line 243
- Inspector List sheet, DashboardView.swift:245, showInspectorList, InspectorListView line 247
- Company Dashboard sheet, DashboardView.swift:250, showCompanyDashboard, CompanyDashboardView line 253

## 5. Admin/management surfaces

**System Admin Only (isAdmin == true):**
- Manage Users, SettingsView.swift:221-223, AdminUsersListView, accessed via NavigationLink
- System Stats, SettingsView.swift:250-251, AdminStatsView, accessed via NavigationLink
- Task Queue, SettingsView.swift:279-280, AdminQueueView, accessed via NavigationLink

**Company Admin (isCompanyAdmin == true):**
- Company Dashboard, SettingsView.swift:181-182, CompanyDashboardView (conditional on line 25)
- Company Dashboard, SettingsHubView.swift:133-136, CompanyDashboardView (conditional on line 128)
- Invite Employee, SettingsHubView.swift:141-144, InviteEmployeeView (conditional on line 128)
- Invite Employee button in CompanyDashboardView.swift:204-205, InviteEmployeeView presentation (conditional on line 203)

## 6. Recording / capture flows

**Voice Recording & Live Fill:**
- Recording initiation and session management in RecordingOverlay.swift (triggered from JobDetailView line 291)
- LiveFillView.swift displays during active recording (JobDetailView line 280)
- Transcript display in TranscriptBarView.swift (JobDetailView line 277)
- Recording controls in RecordingOverlay.swift with observation photo capture callback (JobDetailView line 291)

**CCU (Fuseboard) Extraction:**
- Mode selection sheet, JobDetailView.swift:478-484, CCUExtractionModeSheet triggers PhotoCaptureView
- Circuit match review, JobDetailView.swift:486-498, CircuitMatchReviewView for confirming matches
- Fuseboard camera in CircuitsTab.swift:387-391, for native capture
- Mode selection in CircuitsTab.swift:429-436, CCUExtractionModeSheet
- Match review in CircuitsTab.swift:457-471, CircuitMatchReviewView

**Document Extraction:**
- Document source dialog, JobDetailView.swift:519-533, confirmationDialog with options: Take Photo / Choose from Library / Choose from Files
- Document camera capture, JobDetailView.swift:534-538, PhotoCaptureView via fullScreenCover
- Document library picker, JobDetailView.swift:539-548, PhotosPicker with onChange handler
- Document file picker, JobDetailView.swift:549-565, fileImporter with .image and .pdf support

**Observation Photo Capture:**
- Add observation form with photo capture, ObservationsTab.swift:52-56, AddObservationSheet
- Edit observation with photo options, ObservationsTab.swift:55-56, EditObservationSheet
- Camera in edit form, EditObservationSheet.swift:207, PhotoCaptureView via fullScreenCover
- Photos library picker in edit form, EditObservationSheet.swift:215, JobPhotosPickerSheet

**Audio Import:**
- Audio import view, SettingsHubView.swift:201-204, AudioImportView destination
- Audio recording in AudioImportView.swift:99, PhotoCaptureView for audio metadata photo

## 7. Top-level routes I might have missed

**NavigationDestination (isPresented):**
- SettingsHubView, DashboardView.swift:223-225
- AlertsView, DashboardView.swift:226-228
- Job detail from alerts, AlertsView.swift:58-60, navigationDestination for Job.self

**NavigationLink with value:**
- Job detail from dashboard job row, DashboardView.swift:135-137, NavigationLink(value: job)
- Job detail from alerts job row, AlertsView.swift:119-121, NavigationLink(value: job)

**PresetPickerSheet:**
- DashboardView.swift:262-288, shown during new job creation if multiple presets available

**No additional TabView found** - confirmed that MainTabView is just a container for DashboardView (MainTabView.swift lines 5-12).

