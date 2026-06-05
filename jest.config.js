export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.js'],
  transform: {},
  moduleFileExtensions: ['js', 'json'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/__tests__/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  verbose: true,
  // testTimeout bumped 30s → 90s 2026-05-27 to absorb the first-test
  // cold-start penalty in ESM + jest.unstable_mockModule route tests
  // (loaded-barrel-keys-route, voice-latency-bench, routes-account-consent
  // were observed at 32–63s under full-suite parallel load — 7s targeted).
  // The 90s ceiling is 3× the worst observed under load and still catches
  // a genuinely stuck test inside a single pre-push run.
  testTimeout: 90000,
  // maxWorkers cap reduces module-load contention under the
  // --experimental-vm-modules + unstable_mockModule combination. Default
  // is os.cpus()-1; capping at 50% nearly halves the worst-case I/O
  // queue depth seen during full-suite runs.
  maxWorkers: '50%'
};
