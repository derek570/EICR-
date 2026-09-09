# CertMate iOS — TestFlight Deploy Runbook

> For AWS backend/web deploys, see [deploy-runbook.md](deploy-runbook.md) and [deployment.md](deployment.md). This file covers the native iOS app only.

## Script

Location: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

### What it does

1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches `onnxruntime.framework` `MinimumOSVersion` → `17.0` (matches app deployment target)
4. Re-signs the patched framework with the available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls the ASC API until the build is `VALID`
7. Adds the build to the "Electricians" external TestFlight group
8. Submits for beta review

### How to run

```bash
cd ~/Developer/EICR_Automation/CertMateUnified && \
  ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```

Monitor progress:

```bash
tail -20 /tmp/deploy.log
```

## Pre-TestFlight step — designation-fixture byte-compare (PLAN-B2, MANDATORY)

Before any TestFlight build, run from the EICR repo root:

```bash
scripts/check-designation-fixture-sync.sh
```

Byte-compares `config/designation-canonical-vectors.json` (canonical) against the iOS
copy `CertMateUnified/Tests/CertMateUnifiedTests/Fixtures/designation-canonical-vectors.json`.
This closes the blind spot the paired SHA-256 digest pins cannot cover (a repo changing
BOTH its fixture and its local constant). Non-zero exit = drift: re-copy the canonical
file and update BOTH digest constants together. `IOS_REPO_ROOT` overrides the checkout
location for non-nested layouts.

ConversationAdmissionV1 adds a second mandatory cross-repo check:

```bash
IOS_REPO_ROOT=/path/to/CertMateUnified \
  scripts/check-conversation-admission-fixture-sync.sh
```

It byte-compares `config/conversation-admission-vectors.json` with the XCTest
copy and complements the SHA-256 pins in Jest, Vitest, and XCTest.

DictatedReadbackPolicyV1 adds the mandatory read-back policy check:

```bash
IOS_REPO_ROOT=/path/to/CertMateUnified \
  scripts/check-dictated-readback-fixture-sync.sh
```

It byte-compares `config/dictated-readback-policy-v1.json` with the XCTest copy.
This must pass before TestFlight so backend, web, and iOS use the same mandatory,
silent, optional, cue, and typed-action-outcome vectors.

A01P (2026-09-08) adds the job-state fixture check:

```bash
IOS_REPO_ROOT=/path/to/CertMateUnified \
  scripts/check-job-state-fixture-sync.sh
```

It byte-compares every file in `src/__tests__/fixtures/job-state/` (the shared
API-shaped `input-job.json` plus the two single-board twins) with the XCTest copies
under `Tests/CertMateUnifiedTests/Fixtures/job-state/`. Both clients must start from
identical bytes: web's `buildJobStateForWire` and iOS's decoder-to-builder path each
produce a key-sorted output that the backend Jest suite replays through
`session_start`. A missing file, an extra file, or a differing byte fails closed.
`deploy-testflight.sh` runs this as a named preflight.

A02D (2026-09-09) adds the regex-freshness vector check:

```bash
IOS_REPO_ROOT=/path/to/CertMateUnified \
  scripts/check-regex-freshness-fixture-sync.sh
```

It byte-compares `config/regex-freshness-vectors.json` (RegexFreshOccurrenceV1's
shared raw-final vectors, SHA-256-pinned in Vitest and XCTest) with the XCTest copy
under `Tests/CertMateUnifiedTests/Fixtures/`. A missing file on either side or a
differing byte fails closed. `deploy-testflight.sh` runs this as a named preflight.

## App Store Connect credentials

| Field | Value |
|-------|-------|
| Key file | `~/.appstoreconnect/AuthKey_M535DA575N.p8` |
| Key ID | `M535DA575N` |
| Issuer ID | `fd26ca81-fbad-432a-acf0-3dfb5b266a0e` |
| App ID | `6759958578` |
| Bundle ID | `com.certmate.unified` |
| Development Team ID | `3FWR3VC85U` |

## TestFlight

| Field | Value |
|-------|-------|
| External group | "Electricians" |
| External group ID | `0de0a46a-8d23-46f3-be0f-b615e245dfbe` |
| Public link | https://testflight.apple.com/join/W2dBKTSc |

## ExportOptions.plist

Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`

- Method: `app-store-connect`
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: `true`

## Known fixes baked into the script

### onnxruntime.framework `MinimumOSVersion` (SPM 1.20.0)

The xcframework ships without `MinimumOSVersion` in its `Info.plist`. Must be patched to `17.0` (the app's deployment target) and re-signed before export. Only the Development signing identity (`Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)`) is available locally — that is fine, because `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile (requires `-allowProvisioningUpdates` with the API key for cloud distribution signing).

### Export-failure hang prevention

The export step captures output and checks for `EXPORT FAILED` / `Validation failed`, exiting immediately on failure instead of falling through to the 30-minute polling loop. Previously `|| true` on a `grep` silently ignored failures.
