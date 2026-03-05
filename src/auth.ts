import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { AppConfig } from "./types.js";

const CONFIG_DIR = path.join(homedir(), ".config", "google-drive-mcp");

export function getConfigPath(): string {
  const customConfigPath = process.env.GOOGLE_DRIVE_CONFIG;
  const profileName = process.env.GOOGLE_DRIVE_PROFILE;

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
      const data = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("Error loading config:", error);
  }
  return null;
}

export function saveConfig(configPath: string, config: AppConfig): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function createAuthClient(config: AppConfig): OAuth2Client {
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      "Google Drive credentials not configured. Please run setup first.",
    );
  }

  const auth = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    config.redirectUri || "urn:ietf:wg:oauth:2.0:oob",
  );

  if (!config.refreshToken) {
    throw new Error(
      "No refresh token found. Please complete OAuth flow first.",
    );
  }

  auth.setCredentials({ refresh_token: config.refreshToken });
  return auth;
}
