#!/usr/bin/env npx tsx
/**
 * UPS Collection Manager CLI
 *
 * Zod-validated CLI for booking UPS parcel collections.
 */

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import { UPSClient } from "./ups-client.js";

// Common form options schema
const formOptionsSchema = z.object({
  date: z.string().optional().describe("Collection date (YYYY-MM-DD, default: smart selection based on time)"),
  packages: cliTypes.int(1, 99).optional().describe("Number of packages (default: 1)"),
  weight: cliTypes.int(1, 1000).optional().describe("Weight in kg (default: 10)"),
  earliestTime: z.string().optional().describe("Earliest collection time HH:MM (default: 12:00)"),
  latestTime: z.string().optional().describe("Latest collection time HH:MM (default: 18:00)"),
  doorCode: z.string().optional().describe("Door code without dashes (required)"),
  specialInstructions: z.string().optional().describe("Custom special instructions (overrides door code)"),
});

// Define commands with Zod schemas
const commands = {
  "fill-form": createCommand(
    formOptionsSchema,
    async (args, client: UPSClient) => {
      return client.fillForm({
        date: args.date as string | undefined,
        packages: args.packages as number | undefined,
        weight: args.weight as number | undefined,
        earliestTime: (args.earliestTime as string | undefined) || "12:00",
        latestTime: (args.latestTime as string | undefined) || "18:00",
        doorCode: args.doorCode as string | undefined,
        specialInstructions: args.specialInstructions as string | undefined,
      });
    },
    "Login to UPS and fill collection form (does not submit)"
  ),

  "book": createCommand(
    formOptionsSchema,
    async (args, client: UPSClient) => {
      return client.book({
        date: args.date as string | undefined,
        packages: args.packages as number | undefined,
        weight: args.weight as number | undefined,
        earliestTime: (args.earliestTime as string | undefined) || "12:00",
        latestTime: (args.latestTime as string | undefined) || "18:00",
        doorCode: args.doorCode as string | undefined,
        specialInstructions: args.specialInstructions as string | undefined,
      });
    },
    "Fill form AND submit in one operation (keeps browser alive)"
  ),

  "screenshot": createCommand(
    z.object({
      filename: z.string().optional().describe("Screenshot filename (default: ups-<timestamp>.png)"),
      fullPage: z.boolean().optional().describe("Capture full scrollable page"),
    }),
    async (args, client: UPSClient) => {
      const { filename, fullPage } = args as { filename?: string; fullPage?: boolean };
      return client.takeScreenshot({ filename, fullPage });
    },
    "Take screenshot of current page"
  ),

  "submit": createCommand(
    z.object({}),
    async (_args, client: UPSClient) => client.submit(),
    "Submit the filled form (after user confirmation)"
  ),

  "reset": createCommand(
    z.object({}),
    async (_args, client: UPSClient) => client.reset(),
    "Close browser and clear session"
  ),
};

// Run CLI
runCli(commands, UPSClient, {
  programName: "ups-cli",
  description: "UPS collection booking",
});
