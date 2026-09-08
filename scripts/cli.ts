#!/usr/bin/env npx tsx

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import { UPSClient, type CollectionOptions } from "./ups-client.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const collectionOptionsSchema = z.object({
  date: z.string().optional().describe("Collection date: YYYY-MM-DD, today, tomorrow, or smart default"),
  packages: cliTypes.int(1, 99).optional().describe("Number of packages (default: 1)"),
  weight: cliTypes.int(1, 1000).optional().describe("Total weight in kg (default: 10)"),
  earliest: z.string().optional().describe("Earliest collection time HH:MM (default: 12:00)"),
  latest: z.string().optional().describe("Latest collection time HH:MM (default: 18:00)"),
  earliestTime: z.string().optional().describe("Backward-compatible alias for --earliest"),
  latestTime: z.string().optional().describe("Backward-compatible alias for --latest"),
  doorCode: z.string().optional().describe("Door code; fetched from Slack when omitted, or left blank when unavailable"),
  skipDoorCode: z.boolean().optional().describe("Book without a door code; special instructions default to blank"),
  specialInstructions: z.string().optional().describe("Override UPS special instructions"),
  forbidDate: z.string().optional().describe("Forbidden collection date(s): YYYY-MM-DD, today, tomorrow, or comma-separated list"),
  forbiddenDate: z.string().optional().describe("Backward-compatible alias for --forbid-date"),
});

const resetOptionsSchema = z.object({
  clearProfile: z.boolean().optional().describe("Also delete the persistent UPS Chrome profile"),
});

const emptyOptionsSchema = z.object({});

export const commands = {
  "book": createCommand(
    collectionOptionsSchema,
    async (args, client: UPSClient, globals) => {
      const options = args as CollectionOptions;
      return globals.dryRun ? client.dryRun(options) : client.book(options);
    },
    "Book a UPS collection after strict pre-submit validation",
    {
      sideEffect: "external_send",
      requiresConfirmation: true,
      dryRunSupported: true,
    },
  ),

  "dry-run": createCommand(
    collectionOptionsSchema,
    async (args, client: UPSClient) => client.dryRun(args as CollectionOptions),
    "Fill through Date & Time, capture checkpoint artifacts, and stop before payment/submission",
    {
      sideEffect: "write",
      idempotent: false,
    },
  ),

  "reset-session": createCommand(
    resetOptionsSchema,
    async (args, client: UPSClient) => client.resetSession(args as { clearProfile?: boolean }),
    "Close the dedicated UPS Chrome CDP session",
    {
      sideEffect: "destructive",
      requiresConfirmation: false,
      operationResultExit: true,
    },
  ),

  "status": createCommand(
    emptyOptionsSchema,
    async (_args, client: UPSClient) => client.status(),
    "Inspect the latest UPS booking attempt manifest without touching UPS",
    {
      sideEffect: "read",
    },
  ),

  "inspect-last": createCommand(
    emptyOptionsSchema,
    async (_args, client: UPSClient) => client.status(),
    "Alias for status; read-only latest UPS attempt inspection",
    {
      sideEffect: "read",
    },
  ),
};

let isCliEntry = false;
try {
  isCliEntry =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isCliEntry = false;
}

if (isCliEntry) {
  runCli(commands, UPSClient, {
    programName: "ups-cli",
    description: "UPS collection booking via persistent Chrome CDP automation",
  });
}
