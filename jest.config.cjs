/** @type {import('jest').Config} */
module.exports = {
  roots: ['<rootDir>/apps', '<rootDir>/packages'],
  testMatch: ['**/*.spec.ts'],
  testPathIgnorePatterns: ['\\.integration\\.spec\\.ts$'],
  testEnvironment: 'node',
  clearMocks: true,
  collectCoverageFrom: [
    'apps/**/*.{ts,tsx}',
    'packages/**/*.{ts,tsx}',
    '!**/*.spec.ts',
    '!**/dist/**',
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@pulse-field/contracts$': '<rootDir>/packages/contracts/src/index.ts',
    '^@pulse-field/foundation$': '<rootDir>/packages/foundation/src/index.ts',
    '^@pulse-field/design-tokens$': '<rootDir>/packages/design-tokens/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.jest.json',
      },
    ],
  },
};
