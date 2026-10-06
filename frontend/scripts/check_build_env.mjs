/**
 * Refuses to build when the Angular CLI is not installed, and says why.
 *
 * `ng` lives in `devDependencies`, and `npm install` and `npm ci` both skip those when
 * `NODE_ENV=production`. On a deployment that sets it, the install succeeds and quietly
 * removes the CLI, and the build then dies on a line that says nothing about the cause:
 *
 *   removed 263 packages, and audited 99 packages in 917ms
 *   > frontend@0.0.0 build
 *   > ng build
 *   sh: 1: ng: not found
 *
 * `NODE_ENV=production` is a reasonable-looking thing to set on a Node service, and for
 * this project it is actively harmful: nothing here needs it, and setting it to make the
 * server strict about a missing `API_ORIGIN` deletes the tool that builds the app. So
 * the check is here, before `ng build`, and it names both halves rather than leaving the
 * reader with "command not found".
 *
 * Runs as `prebuild`, so it also fires for `npm run watch`, which needs the CLI for the
 * same reason.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(projectRoot, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');

// The workspace layout differs from the installed one: with a hoisted install the CLI
// is at the top, but a nested or partially-installed tree can put it somewhere else
// entirely, so ask node to resolve it rather than guessing a path.
let resolvable = true;

try {
  await import('@angular/cli/package.json', { with: { type: 'json' } });
} catch {
  resolvable = false;
}

if (existsSync(cli) || resolvable) {
  process.exit(0);
}

const production = process.env.NODE_ENV === 'production';

console.error('');

if (production) {
  console.error('  The Angular CLI is not installed, and NODE_ENV=production is why.');
  console.error('');
  console.error('  With NODE_ENV=production, npm skips devDependencies, and the CLI is one.');
  console.error('  The install above reported removing packages; that is what removed it.');
  console.error('');
  console.error('  Do not set NODE_ENV=production on the service that builds this app. The');
  console.error('  server does not need it: API_ORIGIN is read directly, so behaviour is');
  console.error('  the same with or without it.');
  console.error('');
  console.error('  Remove it from the service environment, then rebuild. To install with it');
  console.error('  set, devDependencies have to be asked for explicitly:');
  console.error('');
  console.error('    npm ci --include=dev');
  console.error('');
  console.error('  Or install a production tree and build separately:');
  console.error('');
  console.error('    npm ci && npm run build && npm ci --omit=dev');
} else {
  console.error('  The Angular CLI is not installed. Run:');
  console.error('');
  console.error('    npm ci');
  console.error('');
  console.error('  If NODE_ENV or NPM_CONFIG_PRODUCTION is set in the environment that ran');
  console.error('  the install, that is what skipped it — clear it and install again.');
}

console.error('');

process.exit(1);
