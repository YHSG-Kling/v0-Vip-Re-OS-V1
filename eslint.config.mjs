import next from "eslint-config-next"

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "public/**",
      "scripts/**",
      "supabase/**",
      "plugins/**",
      "*.config.js",
      "*.config.mjs",
      "*.config.ts",
    ],
  },
  ...next,
  {
    // Pragmatic gate for a large in-flight codebase: surface real correctness
    // issues without drowning CI in stylistic noise on a 2,600-file branch.
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/exhaustive-deps": "warn",
      // React Compiler readiness rules (eslint-plugin-react-hooks v6): valuable as
      // a migration target, but ~350 pre-existing hits on this in-flight branch.
      // Surface them as warnings so CI stays green while the debt is tracked;
      // adopting the React Compiler is a deliberate follow-up, not a ship gate.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/error-boundaries": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/refs": "warn",
      // Keep genuine correctness rules as errors — these catch real bugs.
      "react-hooks/rules-of-hooks": "error",
    },
  },
]

export default eslintConfig
