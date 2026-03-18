> Last updated: 2026-02-18
> Related: [Architecture](architecture.md) | [Deployment](deployment.md) | [File Structure](file-structure.md)
> Hub: [../../CLAUDE.md](../../CLAUDE.md)

# Deployment History (Archive)

This file records the completed implementation phases for the EICR-oMatic 3000 cloud deployment. All phases are COMPLETE as of January 2026.

## Final Status

| Issue | Severity | Status |
|-------|----------|--------|
| PWA Replacement (Phase 7) | HIGH | COMPLETE - LIVE |
| Mobile device testing | LOW | Ongoing |

**All major deployment tasks complete.** PWA is live at https://certomatic3000.co.uk

## Resolved Items (Jan 2026)

- **Data extraction → UI mapping** - Added `transformExtractedData()` in `api.js` to properly map pipeline output to UI format:
  - `board_details.agreed_limitations` → `installation_details.agreed_limitations`
  - `board_details.earthing_arrangement` → `supply_characteristics.earthing_arrangement`
  - `board_details.ze` → `supply_characteristics.earth_loop_impedance_ze`
  - `board_details.voltage_rating` → `supply_characteristics.nominal_voltage_u`
  - `board_details.ipf_at_db` → `supply_characteristics.prospective_fault_current`
- **Restored all tabs from Streamlit UI** - PWA now has 10 tabs (EICR) / 11 tabs (EIC): Overview, Installation, Supply, Board, Circuits, Observations, Inspection, Defaults, Inspector, PDF + Extent & Type and Design for EIC
- **Job timestamp with time** - Header now shows date AND time (e.g., "25/01/2026 at 13:09")
- API keys now loaded from AWS Secrets Manager (not `.env`)
- Backend container includes Python + Playwright for full PDF generation
- **Output folder rename bug** - `api.js` now uses `result.finalOutDir` after `process_job.js` renames output folder to property address
- **ALB timeout** - Increased from 60s to 600s (job processing takes ~80s)
- **Backend memory** - Increased from 512MB to 2048MB (Playwright/Chromium needs more RAM)
- **S3 job listing** - Frontend now lists/loads jobs from S3 in cloud mode (was only using local filesystem)
- **Auto-open job** - Frontend automatically opens job after processing completes (no manual reload needed)
- **Circuit data loading** - Added `load_job_csv()` function to load test_results.csv from S3 in cloud mode
- **S3 job folder naming** - Jobs now uploaded to S3 using property address as folder name (not job ID)
- **Circuit column mapping** - `map_circuit_columns()` maps CSV columns (e.g., `description`) to editor columns (e.g., `circuit_designation`)
- **PDF generation in cloud** - Uses temp file and uploads to S3 (was trying to write to non-existent local path)
- **Streamlit config in Docker** - `.streamlit/config.toml` now copied to Docker image (sets `maxUploadSize=200`)

---

## Implementation Phases

### Phase 1: Foundation - COMPLETE
- [x] Set up AWS account
- [x] Create Docker containers (frontend + backend)
- [x] Set up AWS Secrets Manager
- [x] Backend loads secrets from AWS Secrets Manager at startup

### Phase 2: Database & Storage - COMPLETE
- [x] Create RDS PostgreSQL instance
- [x] Migrate SQLite schema to PostgreSQL
- [x] Update `python/database.py` to use psycopg2 (fixed %s placeholders)
- [x] Create S3 bucket for files
- [x] Create `python/storage.py` for S3 file operations
- [x] Create `src/storage.js` for Node.js S3 integration
- [x] Migrate user accounts from local SQLite to cloud PostgreSQL

### Phase 3: Cloud Deployment - COMPLETE
- [x] Set up ECS Fargate cluster
- [x] Configure Application Load Balancer
- [x] Request SSL certificate (AWS ACM)
- [x] Configure CloudWatch logging
- [x] Register domain (certomatic3000.co.uk)
- [x] Configure Route 53 DNS
- [x] Set up HTTPS with auto-redirect from HTTP

### Phase 4: Production Hardening - COMPLETE
- [x] Replace console.log with structured logging
- [x] Set up CI/CD pipeline (GitHub Actions)
- [x] Add monitoring alerts

### Phase 5: Mobile Optimization - COMPLETE
- [x] Add responsive CSS to Streamlit
- [x] Test on iOS/Android devices (initial - refinements needed)
- [x] PWA replacement approved (see Phase 7)

### Phase 6: Test Coverage - COMPLETE
- [x] Set up pytest for Python (pytest.ini, conftest.py)
- [x] Set up Jest for Node.js (jest.config.js)
- [x] Python unit tests (models, auth, database, secrets_manager, generate_full_pdf)
- [x] Node.js unit tests (merge_salvage, storage)
- [x] Python integration tests (auth_flow, job_workflow)
- [x] CI/CD pipeline updated with test stages

### Phase 7: PWA Replacement - COMPLETE (LIVE)
Replaced Streamlit frontend with Next.js PWA for offline-first mobile editing.
See `docs/plans/2026-01-24-pwa-replacement-design.md` for full design.

**Phase 7A: Core Job Editor** - COMPLETE
- [x] Create job detail page with tab navigation (`/job/[id]`)
- [x] Build CircuitGrid component with TanStack Table (16 columns displayed)
- [x] Implement cell editing with click-to-edit inputs
- [x] Add observations editor page with color-coded cards
- [x] Add board info editor page
- [x] Add backend API endpoints (GET/PUT `/api/job/:userId/:jobId`)

**Phase 7B: Offline Support** - COMPLETE
See `docs/plans/2026-01-24-phase7b-offline-support.md` for implementation plan.
- [x] Add Dexie.js for IndexedDB storage
- [x] Create Zustand store for job state
- [x] Implement offline detection and indicator
- [x] Add sync logic (PUT full job when online)
- [x] Add service worker with next-pwa
- [x] Create PWA manifest with icons

**Phase 7C: PDF & Settings** - COMPLETE
- [x] Add PDF generation endpoint to backend (`POST /api/job/:userId/:jobId/generate-pdf`)
- [x] Create PDF preview/download page (in Next.js PWA)
- [x] Build user defaults editor (`/settings/defaults`)
- [x] Build company settings page (`/settings/company`)
- [x] Add "Apply Defaults" feature to circuit grid
- [x] Add settings API endpoints:
  - `GET/PUT /api/settings/:userId/defaults` - User circuit defaults
  - `GET/PUT /api/settings/:userId/company` - Company settings
  - `GET /api/schema/fields` - Field schema for defaults editor

**Phase 7D: Polish & Deploy** - COMPLETE
- [x] Mobile UX refinements (touch, scroll, keyboard)
  - Circuit grid: 44px touch targets, scroll shadow indicator, scroll position bar
  - Sticky first 2 columns with visual separator
- [x] Add loading states and error handling
  - Error boundary with friendly crash recovery UI
  - API retry logic with exponential backoff (1s→2s→4s)
  - Save button shows "Saving..." text
  - PDF generation shows time estimate
  - Expandable offline queue panel with per-job retry
- [x] Create Dockerfile for Next.js PWA (`Dockerfile.pwa`)
- [x] Add `output: standalone` to next.config.ts
- [x] Deploy Next.js PWA to replace Streamlit frontend
- [x] Stop Streamlit deployment
- [ ] Final testing on mobile devices

**Phase 7E: Restore Streamlit Tabs** - COMPLETE
Restored all tabs from original Streamlit UI to match feature parity.
- [x] Installation Details tab (client info, premises, next inspection)
- [x] Supply Characteristics tab (earthing, voltage, frequency)
- [x] EICR Inspection Schedule tab (BS7671 sections 1-7)
- [x] EIC Inspection Schedule tab (14-item checklist)
- [x] Defaults tab (apply defaults to current job circuits)
- [x] Inspector Profile tab (select inspector for certificate)
- [x] Extent & Type tab (EIC only - installation type)
- [x] Design & Construction tab (EIC only - BS7671 departures)
- [x] Certificate-type aware tab navigation (EICR: 10 tabs, EIC: 11 tabs)
- [x] Job timestamp shows date AND time in header

**Phase 7F: Linked Observations** - COMPLETE
See `docs/plans/2026-01-25-linked-observations-design.md` for full design.
- [x] Inline observation form on inspection schedule items
- [x] Auto-create observation when selecting C1/C2/C3
- [x] Bidirectional sync (tick deletes observation, delete observation sets tick)
- [x] Photo picker component (select from job photos)
- [x] Photo upload component (camera support on mobile)
- [x] Backend photo endpoints (GET/POST /api/job/:userId/:jobId/photos)
- [x] Observation card shows regulation reference and photos
- [x] Schedule items show "Observation linked" indicator

**Deployed to production:** 25 January 2026 - PWA and Backend redeployed

---

## Full Plan Reference
See `/Users/Derek/.claude/plans/wild-prancing-abelson.md` for detailed implementation steps.
