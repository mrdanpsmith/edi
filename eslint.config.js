import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'dist-app/',
      'coverage/',
      'coverage-py/',
      '.cache/',
      '.npm/',
      'node_modules/',
      'build/',
      'scripts/',
      '.venv/',
      '.venv-win/',
      '.venv-macos/',
      'backend/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
