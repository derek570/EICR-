/**
 * P1: Add processed_events table for Stripe webhook deduplication.
 *
 * Stripe retries webhook delivery on failure, which can cause duplicate
 * processing. This table tracks event IDs so the webhook handler can
 * skip already-processed events.
 */

exports.up = (pgm) => {
  pgm.createTable('processed_events', {
    event_id: {
      type: 'text',
      primaryKey: true,
      notNull: true,
    },
    processed_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // Index for cleanup queries (delete events older than X days)
  pgm.createIndex('processed_events', 'processed_at', {
    name: 'idx_processed_events_processed_at',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('processed_events', { ifExists: true });
};
