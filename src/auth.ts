import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { AppConfig } from "./types.js";
import { isWorkspaceServiceId } from "./scopes.js";

const CONFIG_DIR = path.join(homedir(), ".config", "google-drive-mcp");

export function getConfigPath(): string {
  const customConfigPath =
    process.env.GOOGLE_WORKSPACE_CONFIG ?? process.env.GOOGLE_DRIVE_CONFIG;
  const profileName =
    process.env.GOOGLE_WORKSPACE_PROFILE ?? process.env.GOOGLE_DRIVE_PROFILE;

  if (customConfigPath) {
    return customConfigPath.startsWith("~")
      ? path.join(homedir(), customConfigPath.slice(1))
      : customConfigPath;
  }
  if (profileName) {
    // Sanitize to prevent path traversal
    const safeName = profileName.replace(/[^a-z0-9_-]/gi, "-");
    return path.join(CONFIG_DIR, `${safeName}.json`);
  }
  return path.join(CONFIG_DIR, "config.json");
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function loadConfig(configPath: string): AppConfig | null {
  try {
    if (fs.existsSync(configPath)) {
      const stat = fs.statSync(configPath);
      if (!stat.isFile()) {
        throw new Error("Configuration path is not a regular file");
      }
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        try {
          fs.chmodSync(configPath, 0o600);
        } catch (error) {
          console.warn(
            `Configuration permissions could not be tightened for ${configPath}; continuing because the file may be a read-only mounted secret: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const data = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(data) as Partial<AppConfig>;
      if (
        typeof parsed.clientId !== "string" ||
        !parsed.clientId ||
        typeof parsed.clientSecret !== "string" ||
        !parsed.clientSecret
      ) {
        throw new Error("Configuration is missing OAuth client credentials");
      }
      if (
        parsed.refreshToken !== undefined &&
        typeof parsed.refreshToken !== "string"
      ) {
        throw new Error("Configuration refreshToken must be a string");
      }
      if (
        parsed.services !== undefined &&
        (!Array.isArray(parsed.services) ||
          parsed.services.some(
            (service) =>
              typeof service !== "string" || !isWorkspaceServiceId(service),
          ))
      ) {
        throw new Error("Configuration contains an unknown Workspace service");
      }
      return {
        ...parsed,
        redirectUri: parsed.redirectUri || "http://localhost:3000",
      } as AppConfig;
    }
  } catch (error) {
    console.error("Error loading config:", error);
  }
  return null;
}

export function saveConfig(configPath: string, config: AppConfig): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  const tempPath = `${configPath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(tempPath, configPath);
    if (process.platform !== "win32") fs.chmodSync(configPath, 0o600);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

export function createAuthClient(config: AppConfig): OAuth2Client {
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      "Google Workspace credentials not configured. Please run setup first.",
    );
  }

  const auth = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    config.redirectUri || "http://localhost:3000",
  );

  if (!config.refreshToken) {
    throw new Error(
      "No refresh token found. Please complete OAuth flow first.",
    );
  }

  auth.setCredentials({ refresh_token: config.refreshToken });
  return auth;
}
