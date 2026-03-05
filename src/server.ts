import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { OAuth2Client } from "google-auth-library";
import type { Service, ToolDefinition, ToolResponse } from "./types.js";
import { getConfigPath, loadConfig, createAuthClient } from "./auth.js";
import { formatApiError, errorResponse } from "./utils.js";
import { DriveService } from "./services/drive.js";
import { DocsService } from "./services/docs.js";
import { SheetsService } from "./services/sheets.js";
import { CalendarService } from "./services/calendar.js";

export class GoogleDriveMCPServer {
  private server: Server;
  private auth: OAuth2Client | null = null;
  private configPath: string;
  private serverName: string;
  private services: Service[];
  private toolMap = new Map<
    string,
    (args: Record<string, unknown>) => Promise<ToolResponse>
  >();

  constructor() {
    this.configPath = getConfigPath();
    this.serverName =
      process.env.GOOGLE_DRIVE_SERVER_NAME || "google-drive-mcp-server";

    this.services = [
      new DriveService(),
      new DocsService(),
      new SheetsService(),
      new CalendarService(),
    ];

    this.server = new Server(
      { name: this.serverName, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    this.setupHandlers();
  }

  private collectTools(): ToolDefinition[] {
    const allTools: ToolDefinition[] = [];
    for (const service of this.services) {
      allTools.push(...service.getToolDefinitions());
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

    // Build tool dispatch map
    this.toolMap.clear();
    for (const def of this.collectTools()) {
      this.toolMap.set(def.tool.name, def.handler);
    }
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.collectTools().map((def) => def.tool);
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params;

        if (!this.auth) {
          await this.initializeAuth();
        }

        const handler = this.toolMap.get(name);
        if (!handler) {
          return errorResponse(`Unknown tool: ${name}`);
        }

        return await handler((args ?? {}) as Record<string, unknown>);
      } catch (error: unknown) {
        return errorResponse(formatApiError(error));
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(
      `Google Drive MCP Server (${this.serverName}) running on stdio`,
    );
    console.error(`Config: ${this.configPath}`);
  }
}
