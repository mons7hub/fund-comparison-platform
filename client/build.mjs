// Client bundle for the space.
//
// Bundling is owned by the SDK so every space produces an identical
// production-mode React bundle. See @fund-platform/sdk/build for the
// canonical Bun.build() configuration (entrypoint, outdir, NODE_ENV
// define, asset naming, tailwind plugin).

import { buildClient } from "@fund-platform/sdk/build";

await buildClient();
