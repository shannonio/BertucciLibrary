/**
 * One-time bootstrap: lay out the header row in the Google Sheet and write
 * every catalog item into it.
 *
 *   npm run sheet:init
 *
 * Safe to re-run — it overwrites the grid from the DB. Only do that when the DB
 * is the version you want to keep; normally the Sheet is the source of truth.
 */
import 'dotenv/config';
import { initSheet, isConfigured, configProblem, sheetUrl, serviceAccountEmail } from '../server/sheets.js';

if (!isConfigured()) {
  console.error(`\n  ${configProblem()}\n`);
  console.error('  Set GOOGLE_SHEET_ID in .env, and make sure the service-account');
  console.error('  JSON key is present. See the README for the full setup.\n');
  process.exit(1);
}

console.log('\n  Writing the catalog into the Google Sheet...\n');

try {
  const { rows, tab } = await initSheet();
  console.log(`  Done — ${rows} items written to the "${tab}" tab.`);
  console.log(`  ${sheetUrl()}\n`);
  console.log('  The Sheet is now the source of truth. Edit it freely; the app');
  console.log('  pulls changes on open, and pushes its own changes immediately.\n');
} catch (err) {
  console.error(`\n  Failed: ${err.message}\n`);
  if (String(err.message).includes('403')) {
    console.error(`  Share the Sheet with ${serviceAccountEmail()} as an Editor.\n`);
  }
  process.exit(1);
}
