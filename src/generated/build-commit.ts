// src/generated/build-commit.ts
// The git commit this deploy was built from. scripts/stamp-view-version.mjs rewrites the literal
// below with Netlify's COMMIT_REF during the build, in the ephemeral build checkout only — Netlify
// bundles functions AFTER the build command, so the deployed functions carry the real SHA.
//
// Why baked in: COMMIT_REF, like CONTEXT and BRANCH, is a build variable and is not reliably set at
// function runtime on this site (memory: netlify-context-absent-at-runtime). 'dev' means "unknown",
// and every reader must treat it as "cannot tell", never as a commit.
export const BUILD_COMMIT: string = 'dev';
