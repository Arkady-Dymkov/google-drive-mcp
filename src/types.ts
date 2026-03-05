import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OAuth2Client } from "google-auth-library";

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

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
}
