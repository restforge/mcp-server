#!/usr/bin/env node
import { startServer } from './server.js';

startServer().catch((error) => {
  console.error('[restforge-mcp] Fatal error:', error);
  process.exit(1);
});
