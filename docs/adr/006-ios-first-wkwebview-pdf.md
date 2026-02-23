# ADR-006: iOS-First with WKWebView PDF

**Date:** 2026-02-14
**Status:** Accepted

## Context

EICR-oMatic 3000 generates EICR (Electrical Installation Condition Report) and EIC (Electrical Installation Certificate) PDF documents. These certificates are formal regulatory documents that must follow BS 7671 layout conventions and be suitable for submission to clients and regulatory bodies.

The system has two environments where PDF generation is needed:

1. **iOS app (CertMateUnified)** -- The primary workflow. Inspectors complete certificates on their iPhone/iPad and need to generate, preview, and share PDFs immediately on-site, often without reliable internet connectivity.
2. **Server (AWS ECS backend)** -- For web users, bulk generation, and archival. The backend uses Python ReportLab + Playwright (Chromium) for server-side PDF rendering.

### Alternatives considered for iOS PDF generation

1. **Server-side only.** iOS app sends data to the backend, backend generates PDF, iOS downloads it. Rejected because inspectors frequently work in basements, plant rooms, and rural locations with poor connectivity. A server dependency for PDF generation would be a workflow-blocking failure point.
2. **Native iOS PDF rendering (Core Graphics / PDFKit).** Build the certificate layout using iOS drawing APIs. Rejected because the certificate layout is complex (multi-page, tables, conditional sections, signatures, logos) and maintaining two completely separate layout codebases (iOS native + server Python) would be unsustainable.
3. **WKWebView HTML-to-PDF (chosen).** Render an HTML template in a hidden WKWebView, then use the iOS printing subsystem to convert to PDF. The HTML template can be shared conceptually with the server-side renderer, and HTML/CSS is far more expressive for document layout than Core Graphics.

## Decision

Generate PDFs on iOS using a **hidden WKWebView** that renders an HTML certificate template and converts it to PDF via the iOS print rendering pipeline.

The implementation consists of:

- **`EICRHTMLTemplate.swift`** -- Generates complete, self-contained HTML for the EICR/EIC certificate. All CSS is inline. All data is injected via string interpolation from the local GRDB database models (`Job`, `Circuit`, `Observation`, `BoardInfo`, `SupplyCharacteristics`, etc.). The HTML matches BS 7671 layout conventions with proper headers, tables, tick boxes, and signature blocks.
- **`HTMLPDFRenderer.swift`** -- Creates a hidden `WKWebView`, loads the HTML, waits for rendering to complete, then uses `UIPrintPageRenderer` to produce PDF data. Handles A4 page sizing, margins, and multi-page rendering.
- **`PDFGenerator.swift`** -- Orchestrates the generation: loads job data from GRDB, passes it to the HTML template, triggers rendering, and returns the PDF as `Data` for preview or sharing.
- **`PDFPreviewController.swift`** -- Wraps `UIDocumentInteractionController` or `QLPreviewController` for in-app PDF preview and iOS share sheet integration.

The server retains its own PDF generation path (Python ReportLab + Playwright) for web users and bulk operations. The two renderers share the same field mapping and layout structure but are separate codebases -- the iOS template is Swift-generated HTML, while the server uses Python-generated HTML rendered by Playwright's Chromium.

## Consequences

### Positive

- **Fully offline PDF generation.** Inspectors can generate, preview, and share certificates without any network connectivity. This is critical for worksite conditions where cellular/WiFi coverage is unreliable.
- **Instant generation.** WKWebView rendering takes 1-3 seconds on modern iPhones, compared to a server round-trip that requires uploading data, waiting for rendering, and downloading the PDF.
- **Native iOS sharing.** The generated PDF integrates with iOS share sheets, AirDrop, email, Files app, and printing. The inspector can send the certificate to the client before leaving the site.
- **HTML/CSS layout flexibility.** Certificate layouts involve complex tables, conditional sections, and precise formatting. HTML/CSS is well-suited for this and much more maintainable than Core Graphics drawing code.
- **No server load for iOS users.** PDF generation for the primary workflow (iOS inspectors) does not consume backend resources. The server-side renderer is only used for web dashboard users.

### Negative

- **Two PDF codebases.** The iOS HTML template (`EICRHTMLTemplate.swift`) and the server Python renderer are separate implementations. Changes to certificate layout must be applied in both places. Mitigated by the field reference documentation (`docs/reference/field-reference.md`) which documents all 29 circuit columns and their mappings.
- **WKWebView rendering quirks.** WKWebView's print renderer has minor differences from Chromium's (used server-side). Page breaks, font rendering, and table layout may differ slightly between iOS and server-generated PDFs.
- **Template maintenance in Swift.** The HTML template is built via Swift string interpolation in `EICRHTMLTemplate.swift`, which is verbose and lacks HTML syntax highlighting in Xcode. Template changes require building and running the iOS app to test.
- **Memory usage.** Loading a hidden WKWebView for PDF rendering temporarily increases the app's memory footprint. For very large certificates (20+ circuits), this could be significant on older devices.
- **No hot-reload for template changes.** Unlike the server-side renderer, changes to the iOS HTML template require an app rebuild and (for production) App Store review. Mitigated by keeping the template logic straightforward and field-driven.
