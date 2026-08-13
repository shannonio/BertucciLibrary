/**
 * Pull the Google Sheet into the local catalog. The Sheet wins.
 *
 *   npm run sheet:pull
 *   npm run sheet:pull -- --force    # allow a large batch of deletions
 *
 * Deleting data/library.db and running this rebuilds the whole catalog from the
 * Sheet, ids intact.
 */
import 'dotenv/config';
import { pull, isConfigured, configProblem, flushOutbox } from '../server/sheets.js';
import { outboxSize } from '../server/db.js';

const force = process.argv.includes('--force');

if (!isConfigured()) {
  console.error(`\n  ${configProblem()}\n`);
  process.exit(1);
}

console.log('\n  Pulling from the Google Sheet...\n');

try {
  // Push anything queued first, so local changes aren't clobbered by a pull
  // that doesn't know about them yet.
  if (outboxSize()) {
    const pushed = await flushOutbox();
    console.log(`  pushed pending local changes: ${JSON.stringify(pushed)}`);
  }

  const r = await pull({ force });

  if (r.skipped) {
    console.log(`  Skipped: ${r.reason}\n`);
    process.exit(0);
  }

  console.log(`  rows read:  ${r.rows}`);
  console.log(`  updated:    ${r.updated}`);
  console.log(`  inserted:   ${r.inserted}`);
  console.log(`  deleted:    ${r.deleted}`);

  if (r.refusedDeletes) {
    console.log(`\n  REFUSED to delete ${r.refusedDeletes} items.`);
    console.log(`  That's more than the safety threshold of ${r.threshold}, which usually`);
    console.log('  means the Sheet was read partially or cleared by accident rather');
    console.log('  than that you deleted them on purpose.');
    console.log('\n  If you really did mean to remove them:');
    console.log('    npm run sheet:pull -- --force\n');
  } else {
    console.log('');
  }
} catch (err) {
  console.error(`\n  Failed: ${err.message}\n`);
  process.exit(1);
}
