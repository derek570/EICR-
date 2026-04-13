/**
 * Jest configuration for unit tests.
 *
 * Uses ts-jest directly (not nextJest) to avoid a Next.js 16 + Node.js 25
 * incompatibility where Next.js's patched setImmediate causes a recursive
 * stack overflow during test-runner teardown. Our unit tests target pure
 * Zustand stores and utility functions — they don't need Next.js transforms.
 *
 * If Next.js component/page tests are added in the future, create a separate
 * jest.config.components.js that uses nextJest() and run it via
 * `jest --config jest.config.components.js`.
 */

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    // Stub out static assets that can't be imported in jsdom
    "\\.(css|less|scss|sass)$": "<rootDir>/src/__tests__/__mocks__/styleMock.js",
    "\\.(jpg|jpeg|png|gif|svg|ico|webp)$": "<rootDir>/src/__tests__/__mocks__/fileMock.js",
  },
  transform: {
    "^.+\\.(ts|tsx)$": ["ts-jest", {
      tsconfig: {
        // Relax settings for test files
        jsx: "react-jsx",
      },
    }],
  },
  testMatch: ["<rootDir>/src/__tests__/**/*.test.ts?(x)"],
  // Prevent the "open handles" warning — our tests don't start servers
  forceExit: true,
};
