# Public source boundary

This repository is CLI-only. Never commit or push a browser interface, browser
controller, browser-only tests, build/preview/deploy scripts, or their vendors.
Local ignored implementations are not permission to publish them. Never put
NESTERM changes into another project's repository.

Run `npm run check:public` before committing or pushing. Enable the provided
hooks with `git config core.hooksPath .githooks`. New CLI files need explicit
review and addition to the allowlist in `scripts/check-public-scope.mjs`.
Keep the package allowlist CLI-only. Do not rewrite existing history or tags
without explicit authorization.
