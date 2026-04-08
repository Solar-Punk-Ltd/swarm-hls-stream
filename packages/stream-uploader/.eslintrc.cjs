module.exports = {
  root: true,
  env: { es2020: true, jest: true, node: true },
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'simple-import-sort', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/errors',
    'plugin:import/warnings',
    'plugin:import/typescript',
  ],
  ignorePatterns: ['dist', 'node_modules', '.eslintrc.cjs'],
  settings: {
    'import/resolver': {
      typescript: {},
    },
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    curly: ['error', 'all'],
    'import/no-named-as-default-member': 'off',
    'one-var': ['error', 'never'],
    'simple-import-sort/imports': [
      'error',
      {
        groups: [
          ['^@?\\w'], // Packages
          ['^\\u0000'], // Side effect imports
          ['^\\.\\.(?!/?$)', '^\\.\\./?$'], // Parent imports
          ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'], // Other relative imports
          ['^.+\\.?(css)$'], // Style imports
        ],
      },
    ],
  },
};
