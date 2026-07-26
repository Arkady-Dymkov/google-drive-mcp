export const WORKSPACE_SERVICE_IDS = [
  "drive",
  "docs",
  "sheets",
  "calendar",
  "gmail",
  "slides",
  "people",
  "chat",
] as const;

export type WorkspaceServiceId = (typeof WORKSPACE_SERVICE_IDS)[number];

export const LEGACY_SERVICE_IDS: WorkspaceServiceId[] = [
  "drive",
  "docs",
  "sheets",
  "calendar",
  "gmail",
];

export const SERVICE_LABELS: Record<WorkspaceServiceId, string> = {
  drive: "Google Drive",
  docs: "Google Docs",
  sheets: "Google Sheets",
  calendar: "Google Calendar",
  gmail: "Gmail",
  slides: "Google Slides",
  people: "Google People / Contacts",
  chat: "Google Chat",
};

const SERVICE_SCOPES: Record<WorkspaceServiceId, string[]> = {
  drive: ["https://www.googleapis.com/auth/drive"],
  docs: [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.file",
  ],
  sheets: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
  ],
  calendar: ["https://www.googleapis.com/auth/calendar"],
  gmail: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.settings.basic",
  ],
  slides: [
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/drive.file",
  ],
  people: [
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/directory.readonly",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
  chat: [
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/chat.messages.create",
  ],
};

export function isWorkspaceServiceId(
  value: string,
): value is WorkspaceServiceId {
  return (WORKSPACE_SERVICE_IDS as readonly string[]).includes(value);
}

export function scopesForServices(
  services: readonly WorkspaceServiceId[],
): string[] {
  return [...new Set(services.flatMap((service) => SERVICE_SCOPES[service]))];
}
