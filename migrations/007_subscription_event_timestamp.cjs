/**
 * CX-9: Add last_event_at column to subscriptions table for out-of-order
 * webhook event detection. Stores the Stripe event.created timestamp so
 * the webhook handler can reject stale events that arrive after newer ones.
 */

exports.up = (pgm) => {
  pgm.addColumn('subscriptions', {
    last_event_at: {
      type: 'integer',
      comment: 'Stripe event.created Unix timestamp of the last processed webhook event',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('subscriptions', 'last_event_at');
};
