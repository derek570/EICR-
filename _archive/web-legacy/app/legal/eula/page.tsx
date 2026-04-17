import { LegalContent } from '@/components/legal/legal-content';

export default function EulaPage() {
  return (
    <LegalContent title="End User Licence Agreement (EULA)" lastUpdated="9 March 2026">
      <h2>1. The Application</h2>
      <p>
        CertMate (&ldquo;Licensed Application&rdquo;) is software that enables qualified UK
        electricians to create, edit, and manage EICRs, EICs, and related certification documents
        using AI-assisted voice recording, transcription, data extraction, and photo analysis.
        Developed by Beckley Electrical, trading as CertMate.
      </p>

      <h2>2. Scope of Licence</h2>
      <p>
        We grant you a limited, non-exclusive, non-transferable, revocable licence to use the App on
        Apple-branded devices you own or control. You may not share, redistribute, sublicense,
        reverse engineer, decompile, or create derivative works. Each licence is for a single named
        user only.
      </p>

      <h2>3. Technical Requirements</h2>
      <p>
        Requires iOS 17.0+, internet connection, working microphone and camera, and sufficient
        storage. Core features require connectivity; offline functionality is limited to viewing
        previously generated certificates.
      </p>

      <h2>4. Maintenance and Support</h2>
      <p>
        Support is provided via email on a best-efforts basis during UK business hours. Updates may
        be released from time to time. Apple has no obligation to provide maintenance or support.
      </p>

      <h2>5. Use of Data and AI Features</h2>
      <p>
        By using the App, you consent to data processing as described in our{' '}
        <a href="/legal/privacy" className="text-blue-500 hover:text-blue-600">
          Privacy Policy
        </a>
        . AI features are provided &ldquo;AS IS&rdquo; without warranty of accuracy. Third-party AI
        providers are contractually prohibited from using your data for model training.
      </p>
      <p>
        <strong>
          You bear full and sole legal responsibility for the accuracy, completeness, and regulatory
          compliance of all certificates generated using the App.
        </strong>
      </p>

      <h2>6. Professional Requirements</h2>
      <p>
        You must be a qualified and competent person under the Electricity at Work Regulations 1989,
        maintain professional liability insurance, ensure BS 7671 compliance, and independently
        verify all data before issuing any certificate. The App is not a substitute for professional
        competence.
      </p>

      <h2>7. User-Generated Content</h2>
      <p>
        You retain ownership of your certificate data. If you provide feedback or suggestions, you
        grant us an unrestricted licence to use and incorporate them.
      </p>

      <h2>8. Liability and Indemnification</h2>
      <p>
        Our total aggregate liability shall not exceed amounts paid in the preceding 12 months. We
        shall not be liable for indirect, consequential, or special damages, regulatory fines, or
        third-party claims from certificates you issue. You agree to indemnify CertMate from claims
        arising from your use of the App.
      </p>

      <h2>9. Warranty</h2>
      <p>
        We warrant the App does not knowingly contain malware at the time of download. This warranty
        is void if the App is modified without authorisation. Consumer Rights Act 2015 protections
        apply.
      </p>

      <h2>10. Product Claims</h2>
      <p>CertMate, not Apple, is responsible for all product claims.</p>

      <h2>11. Intellectual Property</h2>
      <p>
        CertMate owns all rights in the App. In the event of IP claims, CertMate (not Apple) is
        responsible.
      </p>

      <h2>12. Legal Compliance</h2>
      <p>You warrant you are not in a sanctioned country or on a prohibited parties list.</p>

      <h2>13. Termination</h2>
      <p>
        This licence terminates automatically on breach. On cancellation, access continues through
        the current billing cycle. Previously generated certificates remain your responsibility.
      </p>

      <h2>14. Third-Party Beneficiaries</h2>
      <p>Apple Inc. and its subsidiaries are third-party beneficiaries of this Agreement.</p>

      <h2>15. Governing Law</h2>
      <p>Governed by the laws of England and Wales.</p>

      <h2>16. Force Majeure</h2>
      <p>We are not liable for failures beyond our reasonable control.</p>

      <h2>17. Insurance</h2>
      <p>
        You must maintain valid professional liability insurance at all times. CertMate&apos;s
        insurance does not extend to you.
      </p>

      <h2>18. Contact</h2>
      <p>
        Support:{' '}
        <a href="mailto:support@certmate.co.uk" className="text-blue-500">
          support@certmate.co.uk
        </a>
      </p>

      <p className="mt-8 font-semibold">
        By downloading, installing, or using CertMate, you acknowledge that you have read,
        understood, and agree to be bound by this End User Licence Agreement.
      </p>
    </LegalContent>
  );
}
