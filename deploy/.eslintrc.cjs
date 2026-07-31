// Plain JavaScript rather than the TypeScript setup the packages under `packages/` use, because this
// package holds shell-script tests and no TypeScript at all. The rules that do not depend on types
// are kept identical to those, so a file moving between the two does not change meaning.
module.exports = {
  root: true,
  env: { es2022: true, node: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['simple-import-sort', 'import'],
  extends: ['eslint:recommended', 'plugin:import/errors', 'plugin:import/warnings'],
  ignorePatterns: ['node_modules', '.eslintrc.cjs'],
  rules: {
    'no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    curly: ['error', 'all'],
    'import/no-named-as-default-member': 'off',
    // The test helpers build stub scripts as strings, so `import/no-unresolved` cannot follow the
    // paths inside them and has nothing to resolve. Node's own resolver is the real check here.
    'import/no-unresolved': 'off',
    'one-var': ['error', 'never'],
    'simple-import-sort/imports': [
      'error',
      {
        groups: [
          ['^@?\\w'], // Packages
          ['^\\u0000'], // Side effect imports
          ['^\\.\\.(?!/?$)', '^\\.\\./?$'], // Parent imports
          ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'], // Other relative imports
        ],
      },
    ],
  },
};
