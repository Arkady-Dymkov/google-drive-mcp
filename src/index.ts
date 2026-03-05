#!/usr/bin/env node

import { GoogleDriveMCPServer } from "./server.js";
import { runSetup } from "./setup.js";

const isSetup = process.argv.includes("--setup");

if (isSetup) {
  runSetup().catch((error) => {
    console.error(
      "Fatal error:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
} else {
  const server = new GoogleDriveMCPServer();
  server.run().catch(console.error);
}
