const services = [
  ["Drive", "../build/services/drive.js", "DriveService"],
  ["Docs", "../build/services/docs.js", "DocsService"],
  ["Sheets", "../build/services/sheets.js", "SheetsService"],
  ["Calendar", "../build/services/calendar.js", "CalendarService"],
  ["Gmail", "../build/services/gmail.js", "GmailService"],
  ["Slides", "../build/services/slides.js", "SlidesService"],
  ["People", "../build/services/people.js", "PeopleService"],
  ["Chat", "../build/services/chat.js", "ChatService"],
];

let total = 0;
for (const [label, modulePath, exportName] of services) {
  const module = await import(new URL(modulePath, import.meta.url));
  const service = new module[exportName]();
  const names = service
    .getToolDefinitions()
    .map(({ tool }) => tool.name)
    .sort();
  total += names.length;
  console.log(`${label} (${names.length})`);
  console.log(names.map((name) => `  ${name}`).join("\n"));
}
console.log(`Total: ${total}`);
