---
title: App Review demo account setup
status: copy-paste recipes
last_verified: 2026-05-11 (overnight autonomous run; smoke-tested live against api.certmate.uk)
maintainer: Derek Beckley
purpose: the exact commands to provision the Apple-App-Review-only RDS row before submitting to App Store Connect
read_first: ./app-store-submission-checklist.md §9 (App Review Information) + ./app-review-reviewer-notes.md §3 (demo-account checklist)
audience: morning-Derek, ten minutes before clicking Submit in App Store Connect
---

# App Review demo account — setup recipe

Apple's App Review reviewer signs into the app using credentials you provide in App Store Connect's "App Review Information" form. They will run a complete inspection (or attempt to), so the demo account must be a working real-data account — just one that isn't yours and contains no real homeowner data.

This doc gives the exact recipe.

## 1. Decide the credentials

Pick a dedicated email + a long-but-typable password. Avoid:
- Special characters that get auto-corrected on iPad keyboards (`/`, `\\`, smart quotes)
- Your own email — App Review activity should not pollute your production records
- Anything in a password manager that requires unlock — reviewers type by hand

Suggested:

```
email:    apple-review+demo@beckleyelectrical.co.uk
password: AppleReviewer2026!
name:     Apple Review Demo Inspector
```

The `+demo` alias is delivered to the same inbox as the base address on most mail providers — useful if you ever need to verify a confirmation email but want to keep the demo identity routable. If your provider doesn't support `+` aliasing, use a dedicated alias instead.

## 2. Create the RDS row

You need to be signed in to CertMate as an admin to call the admin-create-user endpoint. Get your admin JWT (any device where you're already logged in; the iOS Keychain has it).

```bash
# Replace ADMIN_JWT with the token from your admin session.
ADMIN_JWT="<your admin JWT>"

curl -X POST https://api.certmate.uk/api/admin/users \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "apple-review+demo@beckleyelectrical.co.uk",
    "name": "Apple Review Demo Inspector",
    "password": "AppleReviewer2026!",
    "company_name": "Apple Review Test Co",
    "role": "user",
    "company_role": "employee"
  }'
```

Expected response: 201 with the created user JSON. Make a note of the `id` field — you'll need it for step 4.

If you don't have an admin JWT to hand: log in to the admin console at `https://certmate.uk/settings/admin/users` and use the "Add user" button there. Same effect.

## 3. Verify the login works from a clean simulator

Before handing the credentials to Apple, prove the round-trip yourself:

1. iPhone or iPad simulator with no CertMate state.
2. Install the latest TestFlight build.
3. Sign in with the demo credentials.
4. Confirm you land on the Dashboard (empty, since this is a fresh account).
5. Sign out. Sign back in. Confirm the second login works without lockout.

If anything fails, fix it before submission — Apple's reviewer will hit the same gate.

## 4. Seed a synthetic job

The demo account starts empty. Apple's reviewer can create a new job from scratch, but it's friendlier to have one already populated so they see the data model immediately.

From the same iPhone/iPad simulator signed into the demo account, run through the new-job flow once:

1. Tap "New Job".
2. Enter address: `1 Apple Review Lane, Cupertino, RG30 4XW`. The Cupertino reference is a hint to the reviewer; the postcode is yours (Tilehurst, Reading) so the postcode-lookup behaviour works.
3. Client name: `DEMO — Apple Review test data, please ignore`. This makes the row easy to recognise in any internal listing and warns anyone who exports the data that it's synthetic.
4. Take a CCU photo from the simulator's photo library — any image works; GPT Vision will return circuits even from a non-CCU image (with low confidence).
5. Tap "Start Recording" and speak any short test phrase that includes a numeric reading, e.g. `earth fault loop impedance zero point one zero ohms`. Tap "Stop Recording".
6. Review the populated certificate, tap "Issue PDF". The local WKWebView render proves the PDF flow works on the demo account.

This leaves the demo account with one filled-out job — exactly what an Apple reviewer needs to evaluate features without having to remember UK electrical terminology.

## 5. Cost-tracker exemption (optional but recommended)

Apple's reviewer may run a few recording sessions during evaluation. If the per-session cost tracker fires alerts on the demo user's activity, your inbox will fill with synthetic cost notifications.

Quick fix: in the RDS `users` row for the demo account, add a tag in the `company_name` field or a flag column that the cost tracker checks. If no such flag exists yet, the simpler path is to email yourself a note "cost alerts from `apple-review+demo@…` are App Review, not production" and ignore them during the review window.

For a more robust fix later, add an `is_test_account BOOLEAN DEFAULT FALSE` column and have the cost-tracker skip alerts for `is_test_account = true` users. Not blocking submission.

## 6. Paste into App Store Connect

In App Store Connect → App Information → App Review Information:

| Field | Value |
|---|---|
| First name | Derek |
| Last name | Beckley |
| Phone | (your personal mobile, not visible to public) |
| Email | (the same Apple Review inbox you check daily) |
| Sign-in required | Yes |
| User name | `apple-review+demo@beckleyelectrical.co.uk` |
| Password | `AppleReviewer2026!` |
| Notes | Copy §1 of `./app-review-reviewer-notes.md` verbatim |

## 7. After App Store approval

The demo account stays put — Apple may use it again for follow-up review or audits. Don't delete it. If you want to refresh the synthetic data, sign in periodically and re-run the new-job flow.

If you ever rotate the password, update App Store Connect AND re-test from a clean simulator. Apple will not warn you that a stored credential has gone stale; they'll just reject with "we couldn't sign in".

## 8. Pre-submission checklist

| ☐ | Item |
|---|---|
| ☐ | Demo user row created in RDS via Step 2; user id noted |
| ☐ | Login round-trip verified from a clean simulator (Step 3) |
| ☐ | One synthetic job present in the demo account, with a clearly non-real address (Step 4) |
| ☐ | Apple reviewer credentials pasted into App Store Connect (Step 6) |
| ☐ | Reviewer notes (§1 of `app-review-reviewer-notes.md`) pasted into the Notes field |
| ☐ | You've signed out and back in once on the same device that's about to do the TestFlight install — verifies the session cleanly drops and the new build picks up state correctly |
