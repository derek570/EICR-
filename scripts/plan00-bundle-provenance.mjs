#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_REL = '.planning/voice-latency-conversational-2026-07-31/plan-00-gpt56-port-parity';
const BUNDLE_ROOT = resolve(REPO_ROOT, BUNDLE_REL);
const PROVENANCE_PATH = resolve(BUNDLE_ROOT, 'provenance.json');
const BANNER =
  '> **REFERENCE COPY — NOT EXECUTABLE.** Execute only the canonical handoff final recorded in `provenance.json`; every tracked copy has an adjacent fail-closed EP policy.\n\n';
const POLICY_TEXT = `${JSON.stringify({ schema_version: 1, executable: false }, null, 2)}\n`;

const ARTIFACTS = Object.freeze([
  {
    id: 'plan00_umbrella',
    label: 'Plan 00 umbrella',
    source:
      '/Users/derekbeckley/.claude/handoffs/EICR_Automation--00-gpt56-port-parity-2026-08-03/PLAN-final.md',
    markdown: `${BUNDLE_REL}/PLAN-00-final.md`,
  },
  {
    id: 'plan00a_provider_tool_cost',
    label: 'Plan 00A provider/tool/cost parity',
    source:
      '/Users/derekbeckley/.claude/handoffs/EICR_Automation--00a-provider-tool-cost-parity-2026-08-03/PLAN-final.md',
    markdown: `${BUNDLE_REL}/PLAN-00A-final.md`,
  },
  {
    id: 'plan00b_trusted_semantic_oracle',
    label: 'Plan 00B trusted semantic oracle',
    source:
      '/Users/derekbeckley/.claude/handoffs/EICR_Automation--00b-trusted-semantic-oracle-2026-08-03/PLAN-final.md',
    markdown: `${BUNDLE_REL}/PLAN-00B-final.md`,
  },
  {
    id: 'plan00c_three_day_evidence',
    label: 'Plan 00C three-day evidence gate',
    source:
      '/Users/derekbeckley/.claude/handoffs/EICR_Automation--00c-three-day-evidence-gate-2026-08-03/PLAN-final.md',
    markdown: `${BUNDLE_REL}/PLAN-00C-final.md`,
  },
]);

const EXECUTION_SUBSTITUTIONS = Object.freeze([
  {
    id: 'umbrella_plan00a_execution',
    applies_to: ['plan00_umbrella'],
    from: '/ep --plan=<00A/PLAN-final.md> --no-chain',
    to: '[REFERENCE COPY — Plan 00A execution uses its canonical handoff final only]',
  },
  {
    id: 'umbrella_plan00b_execution',
    applies_to: ['plan00_umbrella'],
    from: '/ep --plan=<00B/PLAN-final.md> --no-chain',
    to: '[REFERENCE COPY — Plan 00B execution uses its canonical handoff final only]',
  },
  {
    id: 'umbrella_plan00c_execution',
    applies_to: ['plan00_umbrella'],
    from: '/ep --plan=<00C/PLAN-final.md> --no-chain',
    to: '[REFERENCE COPY — Plan 00C execution uses its canonical handoff final only]',
  },
  {
    id: 'plan00a_canonical_execution',
    applies_to: ['plan00a_provider_tool_cost'],
    from:
      '/ep --plan=/Users/derekbeckley/.claude/handoffs/EICR_Automation--00a-provider-tool-cost-parity-2026-08-03/PLAN-final.md --no-chain',
    to: '[REFERENCE COPY — Plan 00A execution uses its canonical handoff final only]',
  },
  {
    id: 'plan00b_canonical_execution',
    applies_to: ['plan00b_trusted_semantic_oracle'],
    from:
      '/ep --plan=/Users/derekbeckley/.claude/handoffs/EICR_Automation--00b-trusted-semantic-oracle-2026-08-03/PLAN-final.md --no-chain',
    to: '[REFERENCE COPY — Plan 00B execution uses its canonical handoff final only]',
  },
  {
    id: 'plan00c_canonical_execution',
    applies_to: ['plan00c_three_day_evidence'],
    from:
      '/ep --plan=/Users/derekbeckley/.claude/handoffs/EICR_Automation--00c-three-day-evidence-gate-2026-08-03/PLAN-final.md --no-chain',
    to: '[REFERENCE COPY — Plan 00C execution uses its canonical handoff final only]',
  },
]);
const PATH_SUBSTITUTIONS = Object.freeze(
  ARTIFACTS.map((artifact) => ({
    id: `${artifact.id}_source_path`,
    applies_to: ARTIFACTS.map(({ id }) => id),
    from: artifact.source,
    to: `./${artifact.markdown.split('/').at(-1)}`,
  })),
);
const ORDERED_SUBSTITUTIONS = Object.freeze([...EXECUTION_SUBSTITUTIONS, ...PATH_SUBSTITUTIONS]);

const hash = (text) => createHash('sha256').update(text).digest('hex');
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const substitutionsFor = (id) => ORDERED_SUBSTITUTIONS.filter(({ applies_to }) => applies_to.includes(id));

function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} differs from deterministic provenance`);
}

function render(source, artifactId) {
  let output = source;
  for (const substitution of substitutionsFor(artifactId)) {
    output = output.split(substitution.from).join(substitution.to);
  }
  if (/\/ep --plan=(?:\/|<)/.test(output)) {
    throw new Error(`${artifactId} retained an executable EP command`);
  }
  if (output.includes('/Users/derekbeckley/')) throw new Error(`${artifactId} retained a machine-local path`);
  return `${BANNER}${output}`;
}

function restore(reference, artifactId) {
  if (!reference.startsWith(BANNER)) throw new Error(`${artifactId} is missing the reference-only banner`);
  let source = reference.slice(BANNER.length);
  for (const substitution of [...substitutionsFor(artifactId)].reverse()) {
    source = source.split(substitution.to).join(substitution.from);
  }
  return source;
}

function build() {
  return ARTIFACTS.map((artifact) => {
    if (!existsSync(artifact.source)) throw new Error(`canonical source unavailable: ${artifact.source}`);
    const sourceText = readFileSync(artifact.source, 'utf8');
    const markdownText = render(sourceText, artifact.id);
    return {
      ...artifact,
      sourceText,
      source_sha256: hash(sourceText),
      markdownText,
      markdown_sha256: hash(markdownText),
      policy: `${artifact.markdown}.ep-policy.json`,
      policy_sha256: hash(POLICY_TEXT),
    };
  });
}

function provenanceFor(artifacts) {
  return {
    schema_version: 1,
    generator: 'scripts/plan00-bundle-provenance.mjs',
    reference_banner: BANNER.trimEnd(),
    ordered_path_substitutions: ORDERED_SUBSTITUTIONS,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      label: artifact.label,
      source_identifier: artifact.source,
      source_sha256: artifact.source_sha256,
      committed_markdown_path: artifact.markdown,
      committed_markdown_sha256: artifact.markdown_sha256,
      committed_policy_path: artifact.policy,
      committed_policy_sha256: artifact.policy_sha256,
    })),
  };
}

function verifyLinks(markdownPath) {
  const markdown = readFileSync(markdownPath, 'utf8');
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#', 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    if (target.startsWith('/')) throw new Error(`${markdownPath} has absolute link ${target}`);
    const destination = resolve(dirname(markdownPath), target);
    const rel = relative(REPO_ROOT, destination);
    if (rel === '..' || rel.startsWith('../')) throw new Error(`${target} resolves outside checkout`);
    if (!existsSync(destination)) throw new Error(`${markdownPath} has broken link ${target}`);
  }
}

function verifyPolicies() {
  const actual = readdirSync(BUNDLE_ROOT).filter((name) => name.endsWith('-final.md')).sort();
  const expected = ARTIFACTS.map(({ markdown }) => markdown.split('/').at(-1)).sort();
  equal(JSON.stringify(actual), JSON.stringify(expected), 'tracked final set');
  for (const finalName of actual) {
    const policyPath = resolve(BUNDLE_ROOT, `${finalName}.ep-policy.json`);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    equal(
      JSON.stringify(policy),
      JSON.stringify({ schema_version: 1, executable: false }),
      `${finalName} policy`,
    );
  }
}

function writeBundle() {
  const artifacts = build();
  for (const artifact of artifacts) {
    writeFileSync(resolve(REPO_ROOT, artifact.markdown), artifact.markdownText);
    writeFileSync(resolve(REPO_ROOT, artifact.policy), POLICY_TEXT);
  }
  writeFileSync(PROVENANCE_PATH, stableJson(provenanceFor(artifacts)));
  console.log(`wrote ${artifacts.length} deterministic Plan 00 reference copies`);
}

function verifyBundle(requireSources) {
  const provenanceText = readFileSync(PROVENANCE_PATH, 'utf8');
  const provenance = JSON.parse(provenanceText);
  equal(provenance.schema_version, 1, 'provenance schema');
  equal(provenance.generator, 'scripts/plan00-bundle-provenance.mjs', 'provenance generator');
  equal(
    JSON.stringify(provenance.ordered_path_substitutions),
    JSON.stringify(ORDERED_SUBSTITUTIONS),
    'ordered substitution map',
  );
  const sourcesAvailable = ARTIFACTS.every(({ source }) => existsSync(source));
  if (requireSources && !sourcesAvailable) throw new Error('canonical handoff sources are unavailable');
  const canonical = sourcesAvailable ? build() : null;

  for (const artifact of ARTIFACTS) {
    const recorded = provenance.artifacts.find(({ id }) => id === artifact.id);
    if (!recorded) throw new Error(`provenance missing ${artifact.id}`);
    equal(recorded.source_identifier, artifact.source, `${artifact.id} source identifier`);
    equal(recorded.committed_markdown_path, artifact.markdown, `${artifact.id} markdown path`);
    const markdown = readFileSync(resolve(REPO_ROOT, artifact.markdown), 'utf8');
    const policy = readFileSync(resolve(REPO_ROOT, recorded.committed_policy_path), 'utf8');
    equal(hash(markdown), recorded.committed_markdown_sha256, `${artifact.id} markdown hash`);
    equal(hash(policy), recorded.committed_policy_sha256, `${artifact.id} policy hash`);
    equal(policy, POLICY_TEXT, `${artifact.id} policy bytes`);
    equal(hash(restore(markdown, artifact.id)), recorded.source_sha256, `${artifact.id} source hash`);
    if (canonical) {
      const expected = canonical.find(({ id }) => id === artifact.id);
      equal(expected.source_sha256, recorded.source_sha256, `${artifact.id} canonical source hash`);
      equal(expected.markdownText, markdown, `${artifact.id} regenerated markdown`);
    }
    verifyLinks(resolve(REPO_ROOT, artifact.markdown));
  }
  if (canonical) equal(provenanceText, stableJson(provenanceFor(canonical)), 'provenance bytes');
  verifyPolicies();
  verifyLinks(resolve(REPO_ROOT, '.planning/voice-latency-conversational-2026-07-31/INDEX.md'));
  verifyLinks(
    resolve(REPO_ROOT, '.planning/voice-latency-conversational-2026-07-31/plan-00-gpt56-port-parity.md'),
  );
  console.log(
    `verified ${ARTIFACTS.length} Plan 00 reference copies (${sourcesAvailable ? 'canonical sources hashed' : 'committed reconstruction'})`,
  );
}

const mode = process.argv[2] ?? '--verify';
if (mode === '--write') writeBundle();
else if (mode === '--verify') verifyBundle(true);
else if (mode === '--verify-committed') verifyBundle(false);
else throw new Error(`unknown mode: ${mode}`);
