import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// eslint-config-next v16 ships native flat configs, so these are spread directly
// (FlatCompat is for the old .eslintrc format and blows up against these).
// The codebase already carried `eslint-disable` comments for @typescript-eslint
// rules — those were written against a linter that was never installed or run.
export default [
  ...nextCoreWebVitals,
  ...nextTypescript,
  { ignores: [".next/**", "node_modules/**", "supabase/**"] },
];
