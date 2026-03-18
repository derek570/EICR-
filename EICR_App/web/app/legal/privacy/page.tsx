import { LegalContent } from '@/components/legal/legal-content';

export default function PrivacyPage() {
  return (
    <LegalContent title="Privacy Policy" lastUpdated="9 March 2026">
      <h2>1. Introduction</h2>
      <p>
        This Privacy Policy explains how Beckley Electrical, trading as CertMate, collects, uses,
        stores, shares, and protects your personal data when you use the CertMate mobile application
        and related services. We are the data controller for the purposes of the UK GDPR and the
        Data Protection Act 2018, as amended by the Data (Use and Access) Act 2025.
      </p>

      <h2>2. Data We Collect</h2>
      <h3>2.1 Information You Provide</h3>
      <p>
        Account information (name, email, phone), professional details (qualifications, scheme
        registration, insurance), certificate data (client details, addresses, test results,
        observations, circuit schedules), voice recordings (streamed for transcription, not
        permanently stored), photographs, billing information (via Apple), and support
        communications.
      </p>

      <h3>2.2 Information Collected Automatically</h3>
      <p>Device information, usage data, log and diagnostic data, and network information.</p>

      <h2>3. How We Use Your Data</h2>
      <p>
        We process your data for: providing the Services (contract performance), AI-assisted
        features (contract performance), account management, billing, cloud backup and sync, service
        improvement (legitimate interests), security and fraud prevention (legitimate interests),
        customer support, legal compliance (legal obligation), and marketing (consent only).
      </p>

      <h2>4. AI Processing and Third-Party Processors</h2>
      <p>When using recording and photo features, data is processed by:</p>
      <table>
        <thead>
          <tr>
            <th>Service</th>
            <th>Provider</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Deepgram Nova-3</td>
            <td>Deepgram, Inc. (USA)</td>
            <td>Real-time speech-to-text</td>
          </tr>
          <tr>
            <td>Claude Sonnet</td>
            <td>Anthropic, PBC (USA)</td>
            <td>Data extraction from transcripts</td>
          </tr>
          <tr>
            <td>GPT Vision</td>
            <td>OpenAI, Inc. (USA)</td>
            <td>Consumer unit photo analysis</td>
          </tr>
        </tbody>
      </table>
      <p>
        All providers are contractually prohibited from using your data to train their AI models or
        retaining it beyond processing time.
      </p>

      <h2>5. Data Sharing</h2>
      <p>
        We share data only with our processors (Deepgram, Anthropic, OpenAI, AWS, Apple),
        professional advisors, and law enforcement where legally required. We do not sell your
        personal data, share it with advertisers, or use it for profiling.
      </p>

      <h2>6. International Data Transfers</h2>
      <p>
        Data is primarily stored in the UK (AWS eu-west-2, London). AI processing may occur in the
        USA, protected by UK-approved Standard Contractual Clauses.
      </p>

      <h2>7. Data Retention</h2>
      <p>
        Account data is retained while active plus 12 months. Raw audio is not permanently stored.
        Billing records are kept for 6 years (UK tax requirements). Usage data is retained for 24
        months. Backups are kept up to 90 days.
      </p>

      <h2>8. Your Rights</h2>
      <p>
        Under the UK GDPR and Data (Use and Access) Act 2025, you have rights to: access,
        rectification, erasure, restrict processing, object to processing, data portability,
        withdraw consent, and not be subject to automated decisions. Contact us at{' '}
        <a href="mailto:support@certomatic3000.co.uk" className="text-blue-500">
          support@certomatic3000.co.uk
        </a>{' '}
        to exercise your rights. We will respond within one month.
      </p>

      <h2>9. Data Security</h2>
      <p>
        We apply encryption in transit (TLS/HTTPS) and at rest (AES-256), access controls, regular
        security assessments, and secure cloud infrastructure (AWS with ISO 27001, SOC 2
        certifications). In the event of a data breach, we will notify you and the ICO within 72
        hours where required.
      </p>

      <h2>10. Children&apos;s Data</h2>
      <p>
        CertMate is for qualified electricians aged 18+. We do not knowingly collect data from
        anyone under 18.
      </p>

      <h2>11. Cookies and Tracking</h2>
      <p>The App does not use cookies. Analytics can be opted out of in App settings.</p>

      <h2>12. Marketing Communications</h2>
      <p>Marketing is consent-only. You can unsubscribe at any time.</p>

      <h2>13. Changes to This Policy</h2>
      <p>We will notify you of material changes by email and/or through the App.</p>

      <h2>14. Contact</h2>
      <p>
        Email:{' '}
        <a href="mailto:support@certomatic3000.co.uk" className="text-blue-500">
          support@certomatic3000.co.uk
        </a>
      </p>
      <p>For ICO complaints: Information Commissioner&apos;s Office, ico.org.uk, 0303 123 1113</p>

      <p className="mt-8 font-semibold">
        By using CertMate, you acknowledge that you have read and understood this Privacy Policy.
      </p>
    </LegalContent>
  );
}
