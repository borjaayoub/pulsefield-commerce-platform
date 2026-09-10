/* eslint-disable @typescript-eslint/no-require-imports */
const baseConfig = require('./jest.config.cjs');

/** @type {import('jest').Config} */
module.exports = {
  ...baseConfig,
  roots: ['<rootDir>/apps/api'],
  testMatch: ['**/*.integration.spec.ts'],
  testPathIgnorePatterns: [],
  collectCoverageFrom: [],
};
