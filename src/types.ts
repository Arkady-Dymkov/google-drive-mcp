import type {
  CallToolResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { OAuth2Client } from "google-auth-library";
import type { WorkspaceServiceId } from "./scopes.js";

export type ToolResponse = CallToolResult;

export interface ToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>) => Promise<ToolResponse>;
}

export interface Service {
  initialize(auth: OAuth2Client): void;
  getToolDefinitions(): ToolDefinition[];
}

export interface AppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken?: string;
  services?: WorkspaceServiceId[];
  scopes?: string[];
}
