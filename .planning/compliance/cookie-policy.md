---
title: CertMate Cookie Policy
status: draft for publication at certmate.uk/cookies
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
source_of_truth: ./facts.md
review_cadence: on change + at least annually
publication_route: certmate.uk/cookies (to be wired into web/src/app/legal/cookies/page.tsx)
---

# Cookie Policy

This page explains what cookies and similar storage technologies CertMate uses on the certmate.uk website and the CertMate web application, and why.

## What this policy covers

UK law treats two kinds of browser storage as legally equivalent for consent purposes (regardless of the technical mechanism used):

- **Cookies** — small text files set by a website that the browser sends back on subsequent requests
- **Similar technologies** — including `localStorage`, `sessionStorage`, and IndexedDB — that store data inside the browser for later use by the same website

For brevity this policy refers to all of these as "cookies" unless a specific distinction matters.

## Our approach

**CertMate uses only the minimum storage required to run the service.** We do not use:

- Analytics cookies (no Google Analytics, Plausible, PostHog, Mixpanel, or any equivalent)
- Marketing or advertising cookies
- Social-network sharing cookies
- Third-party cookies of any kind
- Cookies for cross-site tracking

Because every cookie we set is strictly necessary for delivering the service you have requested, **you are not required to give consent** under the UK Privacy and Electronic Communications Regulations (PECR) and **no cookie banner appears**. You may still choose to clear or block these cookies in your browser settings — see the section on managing cookies below.

## Cookies we set

| Name | Type | Purpose | Lifetime | What happens if you block it |
|---|---|---|---|---|
| `token` | First-party cookie | Mirrors the authentication token also held in `localStorage` (see below) so the server middleware can perform a fast expiry check on every request. Marked `SameSite=Lax` for cross-site-request protection. | Same as the underlying login session (currently up to 30 days, renewed on use). | You can use the rest of certmate.uk but will be redirected to the login page on every protected route. |

## Browser storage we use (localStorage / sessionStorage)

These technologies are not cookies, but UK PECR applies the same consent rules to them. All of the entries below are strictly necessary.

| Storage | Key | Where | Purpose | What happens if you clear it |
|---|---|---|---|---|
| `localStorage` | `cm_token` | certmate.uk | Holds the authentication token used by the web app to call the API. Same token also held in the `token` cookie above. | You will be logged out and asked to sign in again. |
| `localStorage` | `cm_user` | certmate.uk | Holds your inspector profile (name, email, role) so the app can render the user interface without an extra API round-trip on every page load. | You will be temporarily logged out; the next sign-in will repopulate it. |
| `localStorage` | various preference keys (e.g. circuit view preference, last-used CCU capture mode, PWA install hint dismissal) | certmate.uk | Remembers user-interface preferences you have explicitly set. These contain no personal data — only your preferences. | Your preferences reset to defaults. |
| `localStorage` | tour state | certmate.uk | Tracks which onboarding tour steps you have completed so the app doesn't re-show them. | Onboarding tour replays on next visit. |
| `sessionStorage` | error timestamp guard | certmate.uk | Prevents an infinite reload loop after an error. Cleared automatically when you close the tab. | None — automatically managed by the app. |
| `sessionStorage` | CCU match handoff data | certmate.uk | Holds the result of a consumer-unit photo match while you navigate from the capture screen to the review screen. Cleared automatically. | The match-review screen will redirect you back to the capture screen. |
| IndexedDB | `certmate-cache` | certmate.uk | Offline read-through cache so the app works when your network drops mid-inspection. Holds the same job data the API serves; never holds tokens or credentials. | You will need an internet connection until the next sync. |
| IndexedDB | mutations outbox | certmate.uk | Holds API writes that were made while offline, so they can be replayed when connectivity returns. | Any unsynced offline work will be lost. |

## Cookies that other parts of the service may set on different domains

When you use the iOS app, the iOS device sends authentication tokens stored in its system Keychain — not via web cookies — so this policy does not apply to that path.

When the CertMate web app sends data to one of our [sub-processors](./sub-processors.md) (for example, when AI extraction reaches OpenAI), the request goes via our backend rather than directly from your browser, so those sub-processors do not have an opportunity to set cookies in your browser.

## Managing cookies in your browser

You can delete or block cookies set by any website (including certmate.uk) using your browser's settings:

- **Apple Safari** — Settings → Safari → Privacy & Security → Clear History and Website Data, or Manage Website Data for finer control
- **Google Chrome** — Settings → Privacy and security → Cookies and other site data
- **Microsoft Edge** — Settings → Cookies and site permissions
- **Mozilla Firefox** — Settings → Privacy & Security → Cookies and Site Data

Blocking the `token` cookie or clearing `cm_token` from `localStorage` will log you out. Blocking the IndexedDB stores will turn off offline mode. Everything will still work online.

## Children

CertMate is not designed for or marketed to children. We do not knowingly collect data about children through cookies or any other route. If you believe a child's data has reached the service inadvertently, please contact `privacy@certmate.uk` and we will delete it.

## Changes to this policy

We will update this policy if we add, remove, or materially change any cookie. The "Last verified" date in the frontmatter at the top of this page reflects the most recent review. We do not use third-party analytics or advertising cookies and we commit not to introduce them without a material rewrite of this page and a corresponding update to our [Privacy Policy](./privacy-policy.md).

## Contact

For questions about this policy or how we use cookies, contact `privacy@certmate.uk`.

For complaints about our cookie practices, you may also contact the UK Information Commissioner's Office at [ico.org.uk/concerns](https://ico.org.uk/concerns/).
