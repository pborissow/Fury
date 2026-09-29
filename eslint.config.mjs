import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// eslint-config-next 16 ships native flat configs. Loading them through
// FlatCompat (the eslintrc bridge used for Next ≤15) crashed ESLint with
// "Converting circular structure to JSON", so `npm run lint` never ran.
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    "node_modules/**",
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "react/no-unescaped-entities": "off",
    },
  },
  // Shared components are reusable outside the Chat tab and must never depend
  // on it (docs/ticket-chattab-refactor.md §4).
  {
    files: ["components/{composer,panes,files,notes}/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["@/components/chat/*", "@/components/ChatTab", "../chat/*", "../ChatTab"],
            message: "Shared components must not depend on Chat-tab code.",
          },
        ],
      }],
    },
  },
]);

export default eslintConfig;
