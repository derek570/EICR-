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
