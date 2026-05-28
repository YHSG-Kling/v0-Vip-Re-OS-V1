// Flat ESLint config for Next.js 16. `next lint` was removed in Next 16, so the
// lint gate runs ESLint directly (see the "lint" script in package.json).
// eslint-config-next exports native flat-config arrays for the core-web-vitals
// ruleset and the TypeScript ruleset.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'

const config = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    ignores: [
      '.next/**',
      'out/**',
      'build/**',
      'dist/**',
      'node_modules/**',
      'next-env.d.ts',
      'supabase/**',
      'public/**',
      '.claude/**',
      'scripts/**/*.cjs',
    ],
  },
  {
    // Ratchet baseline for this existing codebase. `react-hooks/rules-of-hooks`
    // stays a hard error (it catches real bugs and is now at zero violations).
    // The high-volume strictness rules and the aggressive React-Compiler-era
    // react-hooks rules are demoted to warnings so the gate is green today and
    // can be tightened file-by-file over time without blocking CI on
    // pre-existing debt. Scoped to the same file glob eslint-config-next uses to
    // register these plugins, so the rule overrides resolve without redefining
    // the plugins.
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'react/no-unescaped-entities': 'warn',
      'prefer-const': 'warn',
      '@next/next/no-html-link-for-pages': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
]

export default config
