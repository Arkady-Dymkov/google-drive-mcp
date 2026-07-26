import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { Ajv, type ValidateFunction } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import { createRequire } from "node:module";
import type { OAuth2Client } from "google-auth-library";
import type { Service, ToolDefinition, ToolResponse } from "./types.js";
import { getConfigPath, loadConfig, createAuthClient } from "./auth.js";
import { formatApiError, errorResponse } from "./utils.js";
import { DriveService } from "./services/drive.js";
import { DocsService } from "./services/docs.js";
import { SheetsService } from "./services/sheets.js";
import { CalendarService } from "./services/calendar.js";
import { GmailService } from "./services/gmail.js";
import { SlidesService } from "./services/slides.js";
import { PeopleService } from "./services/people.js";
import { ChatService } from "./services/chat.js";
import {
  LEGACY_SERVICE_IDS,
  WORKSPACE_SERVICE_IDS,
  isWorkspaceServiceId,
  type WorkspaceServiceId,
} from "./scopes.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;
const packageJson = require("../package.json") as { version: string };

const READ_ONLY_PREFIXES = [
  "list_",
  "get_",
  "read_",
  "search_",
  "download_",
  "suggest_",
  "check_",
] as const;
const READ_ONLY_TOOL_NAMES = new Set([
  "batch_get_values",
  "request_file_download",
]);
const DESTRUCTIVE_PREFIXES = [
  "delete_",
  "trash_",
  "clear_",
  "remove_",
  "unmerge_",
] as const;
const IDEMPOTENT_PREFIXES = [
  ...READ_ONLY_PREFIXES,
  "update_",
  "set_",
  "rename_",
  "move_",
  "format_",
  ...DESTRUCTIVE_PREFIXES,
] as const;
const OUTBOUND_TOOL_NAMES = new Set([
  "share_file",
  "update_permission",
  "add_comment",
  "reply_to_comment",
  "resolve_comment",
  "resolve_access_proposal",
  "start_approval",
  "approve_approval",
  "decline_approval",
  "cancel_approval",
  "comment_on_approval",
  "reassign_approval",
  "create_event",
  "update_event",
  "quick_add_event",
  "respond_to_event",
  "move_event",
  "send_email",
  "send_draft",
  "reply_to_email",
  "forward_email",
  "send_chat_message",
]);
const HIGH_RISK_DESTRUCTIVE_TOOL_NAMES = new Set([
  "batch_update_document",
  "batch_update_spreadsheet",
  "update_presentation",
  "update_calendar_labels",
  "update_permission",
  "resolve_access_proposal",
  "decline_approval",
  "cancel_approval",
]);
const NON_IDEMPOTENT_TOOL_NAMES = new Set([
  "batch_update_document",
  "batch_update_spreadsheet",
  "update_presentation",
  "resolve_access_proposal",
  "decline_approval",
  "cancel_approval",
]);

type ToolMode = "all" | "safe-write" | "read-only";

function parseToolMode(): ToolMode {
  const value = process.env.GOOGLE_WORKSPACE_TOOL_MODE ?? "all";
  if (value === "all" || value === "safe-write" || value === "read-only") {
    return value;
  }
  throw new Error(
    "GOOGLE_WORKSPACE_TOOL_MODE must be all, safe-write, or read-only",
  );
}

function parseEnabledServices(
  configured: WorkspaceServiceId[] | undefined,
): Set<WorkspaceServiceId> {
  const envValue = process.env.GOOGLE_WORKSPACE_SERVICES;
  if (!envValue) {
    return new Set(configured ?? LEGACY_SERVICE_IDS);
  }
  if (envValue.trim().toLowerCase() === "all") {
    return new Set(WORKSPACE_SERVICE_IDS);
  }
  const values = envValue
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const invalid = values.filter((value) => !isWorkspaceServiceId(value));
  if (invalid.length) {
    throw new Error(
      `Unknown GOOGLE_WORKSPACE_SERVICES value(s): ${invalid.join(", ")}`,
    );
  }
  return new Set(values as WorkspaceServiceId[]);
}

function inferAnnotations(name: string): ToolAnnotations {
  const hasPrefix = (prefixes: readonly string[]) =>
    prefixes.some((prefix) => name.startsWith(prefix));
  const readOnly =
    hasPrefix(READ_ONLY_PREFIXES) || READ_ONLY_TOOL_NAMES.has(name);
  const destructive =
    /(^|_)(delete|trash|clear|remove|unmerge)(_|$)/.test(name) ||
    HIGH_RISK_DESTRUCTIVE_TOOL_NAMES.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint:
      (hasPrefix(IDEMPOTENT_PREFIXES) || name === "batch_get_values") &&
      !NON_IDEMPOTENT_TOOL_NAMES.has(name),
    openWorldHint: true,
  };
}

function validationMessage(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => {
      const path = error.instancePath || "arguments";
      return `${path} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
}

export class GoogleDriveMCPServer {
  private server: Server;
  private auth: OAuth2Client | null = null;
  private configPath: string;
  private serverName: string;
  private services: Service[];
  private enabledServiceIds: WorkspaceServiceId[];
  private toolMode: ToolMode;
  private toolDefinitions: ToolDefinition[];
  private toolMap = new Map<
    string,
    (args: Record<string, unknown>) => Promise<ToolResponse>
  >();
  private validators = new Map<string, ValidateFunction>();

  constructor() {
    this.configPath = getConfigPath();
    this.serverName =
      process.env.GOOGLE_WORKSPACE_SERVER_NAME ||
      process.env.GOOGLE_DRIVE_SERVER_NAME ||
      "google-workspace-mcp-server";
    this.toolMode = parseToolMode();

    const configuredServices = loadConfig(this.configPath)?.services;
    const enabled = parseEnabledServices(configuredServices);
    const registrations: Array<{
      id: WorkspaceServiceId;
      service: Service;
    }> = [
      { id: "drive", service: new DriveService() },
      { id: "docs", service: new DocsService() },
      { id: "sheets", service: new SheetsService() },
      { id: "calendar", service: new CalendarService() },
      { id: "gmail", service: new GmailService() },
      { id: "slides", service: new SlidesService() },
      { id: "people", service: new PeopleService() },
      { id: "chat", service: new ChatService() },
    ];
    const active = registrations.filter(({ id }) => enabled.has(id));
    this.enabledServiceIds = active.map(({ id }) => id);
    this.services = active.map(({ service }) => service);

    this.toolDefinitions = this.buildToolRegistry();

    this.server = new Server(
      { name: this.serverName, version: packageJson.version },
      { capabilities: { tools: {} } },
    );

    this.setupHandlers();
  }

  private buildToolRegistry(): ToolDefinition[] {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const allTools: ToolDefinition[] = [];
    const names = new Set<string>();

    for (const service of this.services) {
      for (const definition of service.getToolDefinitions()) {
        const name = definition.tool.name;
        if (names.has(name)) {
          throw new Error(`Duplicate MCP tool name: ${name}`);
        }
        names.add(name);

        const enriched: ToolDefinition = {
          ...definition,
          tool: {
            ...definition.tool,
            title:
              definition.tool.title ??
              name
                .split("_")
                .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                .join(" "),
            annotations: {
              ...inferAnnotations(name),
              ...definition.tool.annotations,
            },
            outputSchema: definition.tool.outputSchema ?? {
              type: "object",
              additionalProperties: true,
            },
          },
        };
        const annotations = enriched.tool.annotations ?? inferAnnotations(name);
        if (
          this.toolMode === "read-only" &&
          !annotations.readOnlyHint
        ) {
          continue;
        }
        if (
          this.toolMode === "safe-write" &&
          (annotations.destructiveHint || OUTBOUND_TOOL_NAMES.has(name))
        ) {
          continue;
        }

        this.validators.set(name, ajv.compile(enriched.tool.inputSchema));
        this.toolMap.set(name, enriched.handler);
        allTools.push(enriched);
      }
    }
    return allTools;
  }

  private async initializeAuth(): Promise<void> {
    const config = loadConfig(this.configPath);
    if (!config) {
      throw new Error(
        `Config not found at ${this.configPath}. Run setup first: npx adw-google-mcp --setup`,
      );
    }

    this.auth = createAuthClient(config);

    for (const service of this.services) {
      service.initialize(this.auth);
    }

  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.toolDefinitions.map((def) => def.tool);
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params;

        const handler = this.toolMap.get(name);
        if (!handler) {
          return errorResponse(`Unknown tool: ${name}`);
        }

        const toolArgs = (args ?? {}) as Record<string, unknown>;
        const validate = this.validators.get(name);
        if (!validate || !validate(toolArgs)) {
          return errorResponse(
            `Invalid arguments for ${name}: ${validate ? validationMessage(validate) : "schema unavailable"}`,
          );
        }

        if (!this.auth) {
          await this.initializeAuth();
        }

        const result = await handler(toolArgs);
        if (!result.structuredContent) {
          const text = result.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n");
          if (text) result.structuredContent = { text };
        }
        return result;
      } catch (error: unknown) {
        return errorResponse(formatApiError(error));
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(
      `Google Workspace MCP Server ${packageJson.version} (${this.serverName}) running on stdio with ${this.toolDefinitions.length} tools`,
    );
    console.error(
      `Services: ${this.enabledServiceIds.join(", ")} | Tool mode: ${this.toolMode}`,
    );
    console.error(`Config: ${this.configPath}`);
  }
}
