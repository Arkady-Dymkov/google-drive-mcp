import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Service, ToolDefinition } from "../types.js";
import { saveConfig, loadConfig } from "../auth.js";
import { jsonResponse } from "../utils.js";
import { GoogleDriveMCPServer } from "../server.js";
import { DriveService } from "../services/drive.js";
import { DocsService } from "../services/docs.js";
import { SheetsService } from "../services/sheets.js";
import { CalendarService } from "../services/calendar.js";
import { GmailService } from "../services/gmail.js";
import { SlidesService } from "../services/slides.js";
import { PeopleService } from "../services/people.js";
import { ChatService } from "../services/chat.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

function services(): Service[] {
  return [
    new DriveService(),
    new DocsService(),
    new SheetsService(),
    new CalendarService(),
    new GmailService(),
    new SlidesService(),
    new PeopleService(),
    new ChatService(),
  ];
}

test("every registered tool has a unique name and valid MCP/JSON schema", () => {
  const definitions = services().flatMap((service) =>
    service.getToolDefinitions(),
  );
  const names = definitions.map(({ tool }) => tool.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool name");
  assert.ok(names.length >= 100, `expected expanded toolset, found ${names.length}`);

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const { tool } of definitions) {
    const parsed = ToolSchema.safeParse(tool);
    assert.equal(
      parsed.success,
      true,
      `${tool.name} is not a valid MCP tool: ${parsed.success ? "" : parsed.error.message}`,
    );
    assert.doesNotThrow(
      () => ajv.compile(tool.inputSchema),
      `${tool.name} has an invalid JSON Schema`,
    );
  }
});

test("server enriches every tool and capability modes remove high-risk operations", () => {
  const previous = {
    config: process.env.GOOGLE_WORKSPACE_CONFIG,
    services: process.env.GOOGLE_WORKSPACE_SERVICES,
    mode: process.env.GOOGLE_WORKSPACE_TOOL_MODE,
  };
  const definitions = services().flatMap((service) => service.getToolDefinitions());

  try {
    process.env.GOOGLE_WORKSPACE_CONFIG = join(
      tmpdir(),
      `adw-google-mcp-missing-${process.pid}.json`,
    );
    process.env.GOOGLE_WORKSPACE_SERVICES = "all";

    process.env.GOOGLE_WORKSPACE_TOOL_MODE = "all";
    const all = new GoogleDriveMCPServer() as unknown as {
      toolDefinitions: ToolDefinition[];
    };
    assert.equal(all.toolDefinitions.length, definitions.length);
    for (const { tool } of all.toolDefinitions) {
      assert.equal(tool.outputSchema?.type, "object", `${tool.name} output schema`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean");
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean");
      assert.equal(typeof tool.annotations?.idempotentHint, "boolean");
      assert.equal(typeof tool.annotations?.openWorldHint, "boolean");
    }
    for (const nonIdempotent of [
      "batch_update_document",
      "batch_update_spreadsheet",
      "update_presentation",
    ]) {
      const tool = all.toolDefinitions.find(
        ({ tool: candidate }) => candidate.name === nonIdempotent,
      )?.tool;
      assert.equal(tool?.annotations?.destructiveHint, true);
      assert.equal(tool?.annotations?.idempotentHint, false);
    }

    process.env.GOOGLE_WORKSPACE_TOOL_MODE = "safe-write";
    const safe = new GoogleDriveMCPServer() as unknown as {
      toolDefinitions: ToolDefinition[];
    };
    const safeNames = new Set(safe.toolDefinitions.map(({ tool }) => tool.name));
    for (const hidden of [
      "batch_update_document",
      "batch_update_spreadsheet",
      "update_presentation",
      "share_file",
      "resolve_comment",
      "respond_to_event",
      "send_email",
      "send_chat_message",
    ]) {
      assert.equal(safeNames.has(hidden), false, `${hidden} must be hidden`);
    }
    assert.equal(safeNames.has("insert_text"), true);
    assert.equal(safeNames.has("read_document"), true);

    process.env.GOOGLE_WORKSPACE_TOOL_MODE = "read-only";
    const readOnly = new GoogleDriveMCPServer() as unknown as {
      toolDefinitions: ToolDefinition[];
    };
    assert.ok(readOnly.toolDefinitions.length > 0);
    assert.ok(
      readOnly.toolDefinitions.every(
        ({ tool }) => tool.annotations?.readOnlyHint === true,
      ),
    );
    assert.equal(
      readOnly.toolDefinitions.some(
        ({ tool }) => tool.name === "batch_get_values",
      ),
      true,
    );
    assert.equal(
      readOnly.toolDefinitions.some(
        ({ tool }) => tool.name === "request_file_download",
      ),
      true,
    );
    assert.equal(
      readOnly.toolDefinitions.some(({ tool }) => tool.name === "insert_text"),
      false,
    );
    assert.equal(
      readOnly.toolDefinitions.some(
        ({ tool }) => tool.name === "find_replace_in_sheet",
      ),
      false,
    );
  } finally {
    if (previous.config === undefined) delete process.env.GOOGLE_WORKSPACE_CONFIG;
    else process.env.GOOGLE_WORKSPACE_CONFIG = previous.config;
    if (previous.services === undefined) delete process.env.GOOGLE_WORKSPACE_SERVICES;
    else process.env.GOOGLE_WORKSPACE_SERVICES = previous.services;
    if (previous.mode === undefined) delete process.env.GOOGLE_WORKSPACE_TOOL_MODE;
    else process.env.GOOGLE_WORKSPACE_TOOL_MODE = previous.mode;
  }
});

test("profile configuration is written atomically with private permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "adw-google-mcp-test-"));
  const configPath = join(directory, "profile.json");
  try {
    const config = {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:3000",
      refreshToken: "refresh-token",
      services: ["docs" as const],
    };
    saveConfig(configPath, config);
    assert.deepEqual(loadConfig(configPath), config);
    assert.doesNotThrow(() => JSON.parse(readFileSync(configPath, "utf8")));
    if (process.platform !== "win32") {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(configPath).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("setup-only OAuth port validation does not break normal CLI commands", () => {
  const result = spawnSync(process.execPath, [join(process.cwd(), "build/index.js"), "--version"], {
    encoding: "utf8",
    env: { ...process.env, GOOGLE_OAUTH_PORT: "invalid" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+/);
});

test("structured responses fail closed above the MCP output bound", () => {
  assert.throws(
    () => jsonResponse({ value: "x".repeat(4 * 1024 * 1024) }),
    /exceeds 4 MiB/,
  );
});
