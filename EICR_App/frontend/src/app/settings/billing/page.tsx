'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CheckCircle, XCircle, CreditCard, ExternalLink, Loader2, Zap, Shield } from 'lucide-react';
import { api, User } from '@/lib/api';

interface BillingStatus {
  plan: string;
  status: string;
  stripe_subscription_id?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  billing_configured: boolean;
}

// Default Stripe price ID for Pro plan — set via env or override here
const STRIPE_PRO_PRICE_ID = process.env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID || '';

export default function BillingPage() {
  const searchParams = useSearchParams();
  const [user, setUser] = useState<User | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      setUser(JSON.parse(storedUser) as User);
    }
  }, []);

  useEffect(() => {
    if (!user) return;

    // Show success/cancel messages from Stripe redirect
    if (searchParams.get('success') === 'true') {
      setMessage({
        type: 'success',
        text: 'Payment successful! Your Pro subscription is now active.',
      });
    } else if (searchParams.get('canceled') === 'true') {
      setMessage({ type: 'error', text: 'Checkout was cancelled. No charges were made.' });
    }

    loadBillingStatus();
  }, [user, searchParams]);

  async function loadBillingStatus() {
    try {
      setLoading(true);
      const status = await api.getBillingStatus(user!.id);
      setBilling(status);
    } catch (err) {
      console.error('Failed to load billing status:', err);
      setBilling({
        plan: 'free',
        status: 'inactive',
        billing_configured: false,
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleUpgrade() {
    if (!STRIPE_PRO_PRICE_ID) {
      setMessage({ type: 'error', text: 'Stripe price ID not configured. Contact support.' });
      return;
    }

    try {
      setActionLoading(true);
      const result = await api.createCheckout(user!.id, STRIPE_PRO_PRICE_ID);
      // Redirect to Stripe Checkout
      window.location.href = result.url;
    } catch (err) {
      console.error('Failed to create checkout:', err);
      setMessage({ type: 'error', text: 'Failed to start checkout. Please try again.' });
      setActionLoading(false);
    }
  }

  async function handleManageSubscription() {
    try {
      setActionLoading(true);
      const result = await api.openBillingPortal(user!.id);
      // Redirect to Stripe Customer Portal
      window.location.href = result.url;
    } catch (err) {
      console.error('Failed to open portal:', err);
      setMessage({ type: 'error', text: 'Failed to open billing portal. Please try again.' });
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isPro = billing?.plan === 'pro' && billing?.status === 'active';
  const isCanceling = billing?.cancel_at_period_end === true;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Billing & Subscription</h1>
        <p className="text-muted-foreground mt-1">Manage your CertMate subscription and billing.</p>
      </div>

      {/* Status message */}
      {message && (
        <div
          className={`flex items-center gap-2 p-4 rounded-lg border ${
            message.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle className="h-5 w-5 flex-shrink-0" />
          ) : (
            <XCircle className="h-5 w-5 flex-shrink-0" />
          )}
          <span>{message.text}</span>
        </div>
      )}

      {/* Plan cards */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* Free Tier */}
        <div
          className={`rounded-xl border-2 p-6 ${
            !isPro ? 'border-primary bg-primary/5' : 'border-border bg-card'
          }`}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Free</h2>
            {!isPro && (
              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-primary text-primary-foreground">
                Current Plan
              </span>
            )}
          </div>
          <div className="text-3xl font-bold mb-1">
            &pound;0<span className="text-sm font-normal text-muted-foreground">/month</span>
          </div>
          <p className="text-sm text-muted-foreground mb-6">Get started with basic features.</p>
          <ul className="space-y-2 text-sm">
            <li className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />5 certificates per month
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              Audio transcription
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              PDF generation
            </li>
            <li className="flex items-center gap-2">
              <XCircle className="h-4 w-4 text-muted-foreground/50" />
              <span className="text-muted-foreground">Email certificates</span>
            </li>
            <li className="flex items-center gap-2">
              <XCircle className="h-4 w-4 text-muted-foreground/50" />
              <span className="text-muted-foreground">Client CRM</span>
            </li>
          </ul>
        </div>

        {/* Pro Tier */}
        <div
          className={`rounded-xl border-2 p-6 ${
            isPro ? 'border-primary bg-primary/5' : 'border-border bg-card'
          }`}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Zap className="h-4 w-4 text-yellow-500" />
              Pro
            </h2>
            {isPro && (
              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-primary text-primary-foreground">
                Current Plan
              </span>
            )}
          </div>
          <div className="text-3xl font-bold mb-1">
            &pound;29<span className="text-sm font-normal text-muted-foreground">/month</span>
          </div>
          <p className="text-sm text-muted-foreground mb-6">
            Everything you need for your business.
          </p>
          <ul className="space-y-2 text-sm">
            <li className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              Unlimited certificates
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              Audio transcription
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              PDF generation
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              Email certificates to clients
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              Client &amp; property CRM
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              OCR certificate import
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              Priority support
            </li>
          </ul>
        </div>
      </div>

      {/* Action buttons */}
      <div className="bg-card rounded-xl border p-6 space-y-4">
        {!billing?.billing_configured ? (
          <div className="text-center text-muted-foreground py-4">
            <Shield className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
            <p className="font-medium">Billing not yet configured</p>
            <p className="text-sm">
              Stripe integration is not active on this server. Contact support for help.
            </p>
          </div>
        ) : isPro ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold">Pro Subscription</h3>
                {isCanceling ? (
                  <p className="text-sm text-amber-600">
                    Cancels at end of billing period
                    {billing.current_period_end &&
                      ` (${new Date(billing.current_period_end).toLocaleDateString('en-GB')})`}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {billing.current_period_end
                      ? `Renews ${new Date(billing.current_period_end).toLocaleDateString('en-GB')}`
                      : 'Active subscription'}
                  </p>
                )}
              </div>
              <span className="px-3 py-1 text-sm font-medium rounded-full bg-green-100 text-green-800">
                Active
              </span>
            </div>
            <button
              onClick={handleManageSubscription}
              disabled={actionLoading}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 border rounded-lg hover:bg-accent transition-colors disabled:opacity-50"
            >
              {actionLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ExternalLink className="h-4 w-4" />
              )}
              Manage Subscription
            </button>
          </>
        ) : (
          <>
            <div>
              <h3 className="font-semibold">Upgrade to Pro</h3>
              <p className="text-sm text-muted-foreground">
                Unlock unlimited certificates, email delivery, CRM, and more.
              </p>
            </div>
            <button
              onClick={handleUpgrade}
              disabled={actionLoading || !STRIPE_PRO_PRICE_ID}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 font-medium"
            >
              {actionLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CreditCard className="h-4 w-4" />
              )}
              Upgrade to Pro — &pound;29/month
            </button>
            {!STRIPE_PRO_PRICE_ID && (
              <p className="text-xs text-center text-muted-foreground">
                Stripe price ID not configured. Set NEXT_PUBLIC_STRIPE_PRO_PRICE_ID.
              </p>
            )}
          </>
        )}
      </div>

      {/* Security note */}
      <p className="text-xs text-center text-muted-foreground">
        Payments are securely processed by Stripe. CertMate never stores your card details.
      </p>
    </div>
  );
}
