import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy — CertMate',
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-8">Last updated: 3 March 2026</p>

        <p className="mb-6">
          CertMate (&quot;EICR-oMatic 3000&quot;) is operated by Beckley Electrical Ltd
          (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;). This policy explains what personal data
          we collect through the CertMate iOS app and web application at certomatic3000.co.uk, why
          we collect it, and how we protect it.
        </p>

        <Section title="1. Data We Collect">
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <strong>Account information</strong> — email address, name, and company name, used to
              identify you and pre-fill certificate fields.
            </li>
            <li>
              <strong>Audio recordings</strong> — voice dictation of inspection test readings,
              captured in-app and streamed to our server for transcription. Audio is not retained
              after the transcript is produced.
            </li>
            <li>
              <strong>Photographs</strong> — photos of consumer units, defects, and installation
              details, uploaded to generate certificate observations and evidence.
            </li>
            <li>
              <strong>Location (coarse)</strong> — used only to pre-fill the property address on new
              certificates. Not tracked or stored beyond that purpose.
            </li>
            <li>
              <strong>Certificate data</strong> — inspection readings, observations, circuit
              schedules, and other data you enter or that is extracted from your audio/photos to
              populate EICR and EIC certificates.
            </li>
          </ul>
        </Section>

        <Section title="2. How We Use Your Data">
          <p className="mb-3">Your data is used solely to provide the CertMate service:</p>
          <ul className="list-disc pl-5 space-y-2">
            <li>Transcribing voice recordings into structured inspection data.</li>
            <li>Analysing photos of consumer units to extract board and device information.</li>
            <li>Generating completed EICR/EIC PDF certificates.</li>
            <li>Storing your certificates so you can retrieve, edit, and download them.</li>
          </ul>
          <p className="mt-3">
            We do not sell your data. We do not use your data for advertising. We do not build
            marketing profiles.
          </p>
        </Section>

        <Section title="3. Third-Party Processors">
          <p className="mb-3">
            To provide the service we share specific data with the following processors, each under
            strict data-processing terms:
          </p>
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <strong>Amazon Web Services (AWS)</strong> — hosting, file storage (S3), and database
              (RDS). All infrastructure is in the <strong>eu-west-2 (London)</strong> region.
            </li>
            <li>
              <strong>Deepgram</strong> — speech-to-text transcription of audio recordings.
            </li>
            <li>
              <strong>Anthropic (Claude)</strong> — extraction of structured certificate data from
              transcripts.
            </li>
            <li>
              <strong>OpenAI (GPT Vision)</strong> — analysis of consumer unit photographs.
            </li>
          </ul>
          <p className="mt-3">
            Audio, photos, and text sent to these providers are processed only for the immediate
            request and are not used to train their AI models.
          </p>
        </Section>

        <Section title="4. Data Storage &amp; Retention">
          <p>
            Your certificates and account data are stored in an encrypted PostgreSQL database and S3
            bucket in AWS eu-west-2 (London). Data is retained for as long as your account is
            active. You may request deletion of your account and all associated data at any time by
            contacting us.
          </p>
        </Section>

        <Section title="5. Data Security">
          <p>
            All data in transit is encrypted via TLS. Data at rest is encrypted using AWS-managed
            keys. Access to production systems is restricted to authorised personnel only. Passwords
            are hashed with bcrypt.
          </p>
        </Section>

        <Section title="6. Your Rights">
          <p className="mb-3">Under UK GDPR you have the right to:</p>
          <ul className="list-disc pl-5 space-y-2">
            <li>Access the personal data we hold about you.</li>
            <li>Rectify inaccurate data.</li>
            <li>Request erasure of your data.</li>
            <li>Restrict or object to processing.</li>
            <li>Data portability — receive your data in a machine-readable format.</li>
          </ul>
          <p className="mt-3">To exercise any of these rights, contact us at the address below.</p>
        </Section>

        <Section title="7. Cookies &amp; Analytics">
          <p>
            The web application uses a session token stored as a browser cookie for authentication.
            We do not use third-party tracking cookies or analytics services.
          </p>
        </Section>

        <Section title="8. Children">
          <p>
            CertMate is a professional tool for qualified electrical inspectors. We do not knowingly
            collect data from anyone under 16.
          </p>
        </Section>

        <Section title="9. Changes to This Policy">
          <p>
            We may update this policy from time to time. Material changes will be communicated via
            the app or email. The &quot;last updated&quot; date at the top reflects the most recent
            revision.
          </p>
        </Section>

        <Section title="10. Contact">
          <p>
            If you have questions about this policy or wish to exercise your data rights, contact:
          </p>
          <p className="mt-3">
            Beckley Electrical Ltd
            <br />
            Email:{' '}
            <a href="mailto:derek@beckleyelectrical.co.uk" className="text-blue-600 underline">
              derek@beckleyelectrical.co.uk
            </a>
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold mb-3">{title}</h2>
      <div className="text-foreground leading-relaxed">{children}</div>
    </section>
  );
}
