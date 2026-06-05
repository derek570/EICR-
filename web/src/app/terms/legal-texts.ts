/**
 * Legal document text — verbatim port of iOS `LegalTexts.swift`.
 *
 * Three documents are presented to the user during the T&Cs acceptance
 * flow: Terms & Conditions, Privacy Policy, and End User Licence
 * Agreement. The text is identical to iOS so an inspector who reviews
 * one platform's legal copy and accepts it sees the same wording on the
 * other.
 *
 * **When updating this file, also bump `TERMS_VERSION` in
 * `web/src/app/terms/page.tsx` to force re-acceptance on next session.**
 *
 * Note on Apple-specific clauses: T&C section 17 ("Apple-Specific
 * Terms") and EULA sections 10/13 reference Apple as a third-party
 * beneficiary. These survive verbatim on web for now because (a)
 * inspectors who installed the iOS app first already accepted them
 * there, (b) the same operator owns both surfaces so the platform-
 * specific language is informational not contractual on web. A future
 * legal-review pass may carve them out — track via the audit's
 * "deliberate divergence" log if that happens.
 */

export type LegalDocumentId = 'termsAndConditions' | 'privacyPolicy' | 'eula';

export interface LegalDocument {
  id: LegalDocumentId;
  title: string;
  content: string;
}

export const TERMS_AND_CONDITIONS = `CERTMATE — TERMS AND CONDITIONS
Last Updated: 9 March 2026

1. INTRODUCTION AND AGREEMENT

1.1 These Terms and Conditions ("Terms") constitute a legally binding agreement between you ("User", "you") and the operator of CertMate ("CertMate", "we", "us", "our").

1.2 By downloading, installing, or using the CertMate application ("App") and related services ("Services"), you acknowledge that you have read, understood, and agree to be bound by these Terms, our Privacy Policy, and our End User Licence Agreement (EULA).

1.3 You must be at least 18 years of age and a qualified and competent person within the meaning of the Electricity at Work Regulations 1989 to use the Services. You must hold valid professional liability insurance (see Section 6.5).

1.4 We may modify these Terms with at least 30 days' notice. Continued use after the effective date constitutes acceptance.

2. DESCRIPTION OF SERVICES

2.1 CertMate is an AI-assisted productivity tool that helps qualified UK electricians create Electrical Installation Condition Reports (EICRs), Electrical Installation Certificates (EICs), and related documents. Features include:
(a) Voice recording and real-time transcription via Deepgram;
(b) AI-assisted data extraction via Anthropic's Claude Sonnet;
(c) Consumer unit photo analysis via OpenAI's GPT Vision;
(d) PDF certificate generation;
(e) Local and cloud data storage.

2.2 CertMate does NOT: verify or guarantee certificate accuracy; inspect or test electrical installations; replace professional judgement; guarantee BS 7671 compliance; or verify your qualifications.

2.3 CertMate is not endorsed by the IET, BSI, NICEIC, ECA, NAPIT, or any other regulatory body.

3. ACCOUNTS

Each account is for a single named user. You are responsible for maintaining account security. Account sharing is prohibited and will result in immediate termination.

4. AI-GENERATED CONTENT DISCLAIMER

IMPORTANT: ALL AI-generated, AI-extracted, AI-suggested, or auto-populated content is provided AS ASSISTANCE ONLY and is subject to error, inaccuracy, and misinterpretation.

ALL AI outputs MUST be thoroughly reviewed, verified, and validated by you — a qualified professional — before inclusion in any certificate.

AI systems may: produce incorrect outputs; misinterpret speech or terminology; incorrectly extract data; misidentify components in photos; or generate outputs that do not comply with current BS 7671.

You accept FULL AND SOLE RESPONSIBILITY for reviewing and validating all content in any certificate before issuance.

WE EXPRESSLY DISCLAIM ANY AND ALL RESPONSIBILITY OR LIABILITY FOR ANY INJURY, DEATH, LOSS, DAMAGE, CLAIM, PROSECUTION, REGULATORY ACTION, PROFESSIONAL DISCIPLINARY PROCEEDINGS, OR ANY OTHER OUTCOME ARISING FROM YOUR RELIANCE ON AI-GENERATED CONTENT.

5. VOICE RECORDING

5.1 By enabling the recording feature, you consent to audio capture, real-time streaming to Deepgram for transcription, and processing of transcripts through Claude Sonnet for data extraction.

5.2 If other persons' voices are captured, YOU are solely responsible for obtaining their consent.

5.3 Audio is streamed for real-time transcription and not permanently stored in raw form.

6. PROFESSIONAL RESPONSIBILITY

6.1 You represent that you are a qualified and competent person under the Electricity at Work Regulations 1989.

6.2 You bear FULL AND SOLE LEGAL RESPONSIBILITY for the accuracy, completeness, and compliance of all certificates generated using the Services, including all test results, observations, circuit details, and condition classifications.

6.3 The Services must not be relied upon as a substitute for competent testing, inspection, professional knowledge of BS 7671, or professional judgement.

6.4 Your use of CertMate does not create any relationship between CertMate and your clients.

6.5 PROFESSIONAL LIABILITY INSURANCE: You must maintain valid and adequate professional liability insurance covering your electrical certification activities, including claims arising from certificates generated using the Services. Your policy must not exclude AI-assisted tools. CertMate's insurance does not extend to you. You agree to provide evidence of insurance upon reasonable request.

6.6 You are solely responsible for maintaining appropriate registrations (NICEIC, NAPIT, ECA, etc.) and complying with building regulations and all applicable laws.

7. BS 7671 AND ELECTRICAL STANDARDS

Certificate templates are based on BS 7671:2018 model forms (as amended). CertMate does not guarantee compliance with any edition of BS 7671, IET Wiring Regulations, or other standard. You must independently verify every certificate complies with current standards.

8. PAYMENT TERMS

8.1 The Services are provided on a monthly subscription basis with a set number of certificates included. Additional certificates may be purchased individually.

8.2 Payments are processed through Apple's In-App Purchase system in GBP inclusive of VAT.

8.3 Subscriptions auto-renew unless cancelled via Apple ID settings. Cancellation takes effect at the end of the current billing period. No partial refunds.

8.4 We may change prices with 30 days' notice. Refunds are handled by Apple per their policies.

9. INTELLECTUAL PROPERTY

9.1 CertMate owns all rights to the App, templates, and processing pipelines.

9.2 You retain ownership of your certificate data. You grant us a limited licence to process it for providing the Services.

9.3 You must not: reverse engineer, decompile, or derive source code; copy templates or workflows; train AI models to replicate the Services; create competing derivative works; or scrape content.

10. PROHIBITED ACTIVITIES

You must not: generate certificates for work you didn't carry out; create fraudulent certificates; share your account; interfere with the Services; upload harmful code; or use the Services to compete with CertMate.

11. THIRD-PARTY SERVICES

The Services depend on Deepgram, Anthropic (Claude Sonnet), OpenAI (GPT Vision), AWS, and Apple. We are not responsible for third-party outages, performance, or changes. We may change providers without notice.

12. DATA PROTECTION

Our collection and use of your data is governed by our Privacy Policy. We are the data controller. Third-party AI providers are data processors under formal agreements prohibiting use of your data for model training.

Under UK GDPR and the Data (Use and Access) Act 2025, you have rights to access, correct, delete, restrict, and port your data. Contact us to exercise these rights. We maintain a formal complaints procedure and will acknowledge complaints within 30 days.

13. LIMITATION OF LIABILITY

13.1 Nothing in these Terms excludes liability for: death or personal injury from negligence; fraud; or any liability that cannot be excluded under applicable law.

13.2 Subject to 13.1, our total aggregate liability shall not exceed fees paid in the 12 months preceding the claim.

13.3 We exclude liability for: loss of profits, revenue, or business; loss of data; regulatory fines or sanctions; claims from certificates you issued; professional disciplinary proceedings; indirect or consequential damages; losses from AI-generated content; and losses from service unavailability.

13.4 Nothing in these Terms affects your statutory rights under the Consumer Rights Act 2015.

14. DISCLAIMERS

Subject to your Consumer Rights Act 2015 statutory rights, the Services are provided "AS IS" and "AS AVAILABLE". We do not warrant uninterrupted, error-free, or accurate service. The App is warranted malware-free at download.

15. INDEMNIFICATION

You indemnify CertMate against claims arising from: certificates you issue; breach of these Terms; violation of law; inadequate qualifications or insurance; failure to verify AI content; third-party claims about your work; failure to obtain recording consent; and IP infringement.

16. TERMINATION

You may terminate by cancelling your subscription and deleting the App. We may suspend or terminate your account at any time for breach or at our discretion. Previously generated certificates remain your responsibility. Sections 4, 6, 9, 13, 14, 15, and 18 survive termination.

17. APPLE-SPECIFIC TERMS

These Terms are between you and CertMate, not Apple. CertMate is responsible for the App, maintenance, support, warranties, product claims, and IP infringement claims. Apple and its subsidiaries are third-party beneficiaries with enforcement rights.

18. GOVERNING LAW

These Terms are governed by the laws of England and Wales. Disputes are subject to the exclusive jurisdiction of the courts of England and Wales, subject to mandatory consumer protections.

19. GENERAL PROVISIONS

Entire agreement (with Privacy Policy and EULA). Severability. No waiver. Assignment restricted. Force majeure (including natural disasters, cyber attacks, pandemics, third-party outages). No third-party rights except Apple (Section 17).

20. CONTACT

For questions about these Terms, contact us at the email address provided in the App settings.`;

export const PRIVACY_POLICY = `CERTMATE — PRIVACY POLICY
Last Updated: 9 March 2026

1. INTRODUCTION

This Privacy Policy explains how CertMate ("we", "us") collects, uses, stores, and protects your personal data. We are the data controller under UK GDPR and the Data Protection Act 2018, as amended by the Data (Use and Access) Act 2025.

2. DATA WE COLLECT

Information you provide: Name, email, phone, professional qualifications, certificate data (client names, addresses, test results, observations, circuit details), voice recordings (streamed for transcription, not permanently stored), photographs of electrical installations, and support communications.

Information collected automatically: Device model, OS version, usage data (features used, session duration), diagnostic logs, IP address, and connection type.

We do not directly collect payment card details — payments are handled by Apple.

3. HOW WE USE YOUR DATA

We process your data to: operate the App and generate certificates; provide AI features (Deepgram transcription, Claude Sonnet extraction, GPT Vision analysis); manage your account and subscription; provide cloud backup; improve the Services; ensure security; respond to support enquiries; and comply with legal obligations.

Legal bases: Contract performance (core features), legitimate interests (analytics, security), consent (voice recording, marketing), and legal obligation (tax records).

4. AI PROCESSING

Your data is processed by these third-party AI services:
• Deepgram (USA) — real-time speech-to-text transcription
• Anthropic / Claude Sonnet (USA) — structured data extraction
• OpenAI / GPT Vision (USA) — consumer unit photo analysis

All act as data processors under formal Data Processing Agreements. They are contractually prohibited from: using your data to train AI models; retaining data beyond processing; or using data for unauthorised purposes.

Deepgram operates with zero data retention after transcription and is SOC 2 Type 2 certified.

5. DATA SHARING

We share data with: AI service providers (as above), AWS (cloud hosting in UK), Apple (payments), professional advisors (as needed), and law enforcement (where legally required).

We do NOT sell your personal data, share it with advertisers, or use it for profiling.

6. INTERNATIONAL TRANSFERS

Data is primarily stored in the UK (AWS eu-west-2, London). AI providers are US-based. We ensure appropriate safeguards via UK-approved Standard Contractual Clauses and contractual GDPR-equivalent protections.

7. DATA RETENTION

Account and certificate data: retained while your account is active, plus 12 months.
Voice recordings (raw audio): not permanently stored; streamed and discarded.
Transcripts: retained while account is active; deleted on closure or request.
Billing records: 6 years (UK tax requirements).
Usage/diagnostic data: 24 months.
Backups: up to 90 days.

You may request deletion at any time.

8. YOUR RIGHTS

Under UK GDPR and the Data (Use and Access) Act 2025, you have the right to: access your data; correct inaccuracies; request deletion; restrict processing; object to processing; data portability; withdraw consent; and not be subject to automated decisions.

We will respond within one month. We maintain a formal complaints procedure and will acknowledge complaints within 30 days.

If unsatisfied, you may complain to the ICO (ico.org.uk, 0303 123 1113).

9. SECURITY

We use encryption (TLS/HTTPS, AES-256), access controls, regular security assessments, and secure cloud infrastructure (AWS ISO 27001, SOC 2). No system is 100% secure.

In the event of a data breach likely to risk your rights, we will notify you and the ICO within 72 hours.

10. CHILDREN

CertMate is for qualified electricians aged 18+. We do not knowingly collect data from under-18s.

11. MARKETING

Service notifications are mandatory while your account is active. Marketing requires your opt-in consent and you can unsubscribe at any time.

12. CHANGES

We may update this policy and will notify you of material changes via email or the App.

13. CONTACT

For data protection enquiries, contact us at the email address provided in the App settings. For ICO complaints: ico.org.uk, 0303 123 1113.`;

export const EULA = `CERTMATE — END USER LICENCE AGREEMENT
Last Updated: 9 March 2026

1. THE APPLICATION

CertMate ("Licensed Application") is software enabling qualified UK electricians to create EICRs, EICs, and related certificates using AI-assisted voice recording, transcription, data extraction, and photo analysis.

2. LICENCE

2.1 You are granted a limited, non-exclusive, non-transferable, revocable licence to use the App on Apple devices you own or control.

2.2 You may not: share, redistribute, or sell the App; reverse engineer or decompile it; remove proprietary notices; use it to develop competing products; train AI models to replicate its features; or share your account credentials.

2.3 Each licence is for a single named user. Account sharing results in immediate termination.

3. TECHNICAL REQUIREMENTS

Requires iOS 17.0+, active internet connection, microphone, and camera. Core features (transcription, AI extraction, photo analysis) require connectivity. Offline use is limited to viewing previously generated data. Service interruptions may occur without notice.

4. SUPPORT

Customer support is provided via email on a best-efforts basis during UK business hours. Apple has no support obligation for this App.

5. AI FEATURES AND DATA

5.1 By using the App, you consent to audio streaming to Deepgram, transcript processing by Claude Sonnet, and photo analysis by GPT Vision, as described in our Privacy Policy.

5.2 AI features are provided "AS IS" without warranty of accuracy. You must verify all AI outputs before professional use.

5.3 AI providers are data processors prohibited from using your data for model training.

5.4 Data may be processed in the USA by our AI providers, with appropriate safeguards.

5.5 You bear FULL AND SOLE LEGAL RESPONSIBILITY for the accuracy and compliance of all certificates generated using the App.

6. PROFESSIONAL REQUIREMENTS

6.1 You must be a qualified and competent person under the Electricity at Work Regulations 1989.

6.2 You MUST maintain valid professional liability insurance covering your certification activities. Your policy must not exclude AI-assisted tools. Our insurance does not cover you.

6.3 All certificates must comply with BS 7671 and IET Wiring Regulations. You are solely responsible for compliance.

6.4 Before issuing any certificate, you must independently verify all data, calculations, observations, and compliance with current standards.

6.5 The App is not a substitute for professional competence, testing, or judgement.

7. YOUR CONTENT

You retain ownership of your certificate data. You grant us a limited licence to process it for providing the Services. Feedback you provide may be used to improve the App without obligation.

8. LIABILITY

8.1 Our total liability shall not exceed fees paid in the 12 months preceding the claim.

8.2 We exclude liability for: indirect, consequential, or punitive damages; loss of profits or data; regulatory fines; third-party claims from your certificates; and business losses from app errors.

8.3 Apple has no liability for the App. Apple's sole obligation is to refund the purchase price if the App fails to conform to warranty.

8.4 Nothing excludes liability for: death or personal injury from negligence; or fraud.

9. WARRANTY

The App is warranted malware-free at download (void if modified without authorisation). Report defects within 180 days. Refunds handled by Apple. Your Consumer Rights Act 2015 statutory rights are unaffected.

10. PRODUCT CLAIMS

CertMate, not Apple, is responsible for all claims relating to the App, including product liability, legal compliance, and consumer protection claims.

11. INTELLECTUAL PROPERTY

CertMate owns all rights to the App. In the event of third-party IP claims, CertMate (not Apple) is responsible. You indemnify us for claims from materials you upload.

12. TERMINATION

This licence terminates automatically on breach. On subscription cancellation, access continues through the current billing period. Previously generated certificates remain your responsibility. Key provisions survive termination.

13. APPLE TERMS

Apple and its subsidiaries are third-party beneficiaries of this Agreement with enforcement rights.

14. INSURANCE

You must maintain professional liability insurance at all times while using the App. Our insurance does not extend to you, your clients, or any third party.

15. GOVERNING LAW

Governed by the laws of England and Wales. Disputes resolved in the courts of England and Wales.

16. FORCE MAJEURE

We are not liable for failures from circumstances beyond reasonable control, including natural disasters, cyber attacks, pandemics, third-party outages, and governmental actions.

17. CONTACT

For support, contact us at the email address provided in the App settings.

By downloading, installing, or using CertMate, you agree to this End User Licence Agreement.`;

export const LEGAL_DOCUMENTS: LegalDocument[] = [
  { id: 'termsAndConditions', title: 'Terms & Conditions', content: TERMS_AND_CONDITIONS },
  { id: 'privacyPolicy', title: 'Privacy Policy', content: PRIVACY_POLICY },
  { id: 'eula', title: 'End User Licence Agreement', content: EULA },
];
