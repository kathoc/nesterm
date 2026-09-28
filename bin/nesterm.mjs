#!/usr/bin/env node

import { main } from '../src/terminal.mjs';

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`nesterm: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
