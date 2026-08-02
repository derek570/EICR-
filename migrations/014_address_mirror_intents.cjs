/**
 * Durable owner-scoped state for the one-shot site/client address mirror ask.
 *
 * The jobs.address_mirror_asked bit records that the convenience question was
 * claimed. This row retains enough server-owned identity and source state to
 * resolve that question after a WebSocket reconnect or process restart.
 * Address values are certificate PII: runtime callers must never log the JSON
 * payloads or question text.
 */

exports.up = (pgm) => {
  pgm.createTable('address_mirror_intents', {
    user_id: { type: 'text', notNull: true },
    job_id: {
      type: 'text',
      notNull: true,
      references: 'jobs(id)',
      onDelete: 'CASCADE',
    },
    status: { type: 'text', notNull: true, default: "'pending'" },
    ask_id: { type: 'text', notNull: true },
    legacy_question_type: { type: 'text', notNull: true, default: "'address_mirror'" },
    question_hash: { type: 'text', notNull: true },
    source_family: { type: 'text', notNull: true },
    source_snapshot: { type: 'jsonb', notNull: true },
    source_version_hash: { type: 'text', notNull: true },
    source_writes: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    resolution_token: { type: 'text', notNull: true },
    terminal_outcome: { type: 'jsonb' },
    delivered_at: { type: 'timestamp with time zone' },
    delivery_claim_token: { type: 'text' },
    delivery_claimed_at: { type: 'timestamp with time zone' },
    claimed_at: { type: 'timestamp with time zone', notNull: true, default: pgm.func('NOW()') },
    resolved_at: { type: 'timestamp with time zone' },
  });

  pgm.addConstraint('address_mirror_intents', 'address_mirror_intents_owner_job_unique', {
    unique: ['user_id', 'job_id'],
  });
  pgm.addConstraint(
    'address_mirror_intents',
    'address_mirror_intents_status_check',
    "CHECK (status IN ('pending', 'resolved_yes', 'resolved_no', 'conflict'))"
  );
  pgm.addConstraint(
    'address_mirror_intents',
    'address_mirror_intents_source_family_check',
    "CHECK (source_family IN ('site', 'client'))"
  );
  pgm.addConstraint(
    'address_mirror_intents',
    'address_mirror_intents_source_snapshot_object_check',
    "CHECK (jsonb_typeof(source_snapshot) = 'object')"
  );
  pgm.addConstraint(
    'address_mirror_intents',
    'address_mirror_intents_source_writes_array_check',
    "CHECK (jsonb_typeof(source_writes) = 'array')"
  );
  pgm.createIndex('address_mirror_intents', ['user_id', 'job_id', 'status'], {
    name: 'idx_address_mirror_intents_owner_job_status',
  });
  pgm.createIndex('address_mirror_intents', ['user_id', 'ask_id'], {
    name: 'idx_address_mirror_intents_owner_ask',
  });

  // Direct "same address" commands are independent of the permanent
  // convenience-question latch above. This is an append-only operation
  // ledger, not a single mutable slot: an utterance token remains reserved
  // after later commands so a delayed duplicate can never fall through to
  // model extraction or resolve a newer opposite-direction clarification.
  pgm.createTable('address_mirror_direct_intents', {
    user_id: { type: 'text', notNull: true },
    job_id: {
      type: 'text',
      notNull: true,
      references: 'jobs(id)',
      onDelete: 'CASCADE',
    },
    status: { type: 'text', notNull: true, default: "'pending'" },
    clarification_kind: { type: 'text', notNull: true },
    source_family: { type: 'text', notNull: true },
    target_family: { type: 'text', notNull: true },
    operation_token: { type: 'text', notNull: true },
    question_id: { type: 'text', notNull: true },
    source_snapshot: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    source_writes: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    terminal_outcome: { type: 'jsonb' },
    delivered_at: { type: 'timestamp with time zone' },
    delivery_claim_token: { type: 'text' },
    delivery_claimed_at: { type: 'timestamp with time zone' },
    created_at: { type: 'timestamp with time zone', notNull: true, default: pgm.func('NOW()') },
    resolved_at: { type: 'timestamp with time zone' },
  });
  pgm.addConstraint(
    'address_mirror_direct_intents',
    'address_mirror_direct_intents_operation_unique',
    { unique: ['user_id', 'job_id', 'operation_token'] }
  );
  pgm.addConstraint(
    'address_mirror_direct_intents',
    'address_mirror_direct_intents_status_check',
    "CHECK (status IN ('pending', 'resolved_yes', 'resolved_no', 'conflict', 'cancelled'))"
  );
  pgm.addConstraint(
    'address_mirror_direct_intents',
    'address_mirror_direct_intents_kind_check',
    "CHECK (clarification_kind IN ('direct', 'incomplete', 'conflict'))"
  );
  pgm.addConstraint(
    'address_mirror_direct_intents',
    'address_mirror_direct_intents_source_family_check',
    "CHECK (source_family IN ('site', 'client'))"
  );
  pgm.addConstraint(
    'address_mirror_direct_intents',
    'address_mirror_direct_intents_target_family_check',
    "CHECK (target_family IN ('site', 'client') AND target_family <> source_family)"
  );
  pgm.createIndex('address_mirror_direct_intents', ['user_id', 'job_id', 'status'], {
    name: 'idx_address_mirror_direct_owner_job_status',
  });
  pgm.createIndex('address_mirror_direct_intents', ['user_id', 'job_id', 'delivered_at'], {
    name: 'idx_address_mirror_direct_owner_job_delivery',
  });
  pgm.addConstraint(
    'address_mirror_direct_intents',
    'address_mirror_direct_source_snapshot_object_check',
    "CHECK (jsonb_typeof(source_snapshot) = 'object')"
  );
  pgm.addConstraint(
    'address_mirror_direct_intents',
    'address_mirror_direct_source_writes_array_check',
    "CHECK (jsonb_typeof(source_writes) = 'array')"
  );
};

exports.down = (pgm) => {
  pgm.dropTable('address_mirror_direct_intents');
  pgm.dropTable('address_mirror_intents');
};
