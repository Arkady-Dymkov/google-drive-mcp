// Markdown <-> Google Docs conversion utilities
// No external dependencies

import type { docs_v1 } from "googleapis";

// ============================================================
// Markdown -> HTML (for Drive API upload with MIME conversion)
// ============================================================

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInline(text: string): string {
  let r = esc(text);
  // Inline code (before other formatting so content inside is untouched)
  r = r.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Images ![alt](url)
  r = r.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
  // Links [text](url)
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Bold+italic
  r = r.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  // Bold
  r = r.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic
  r = r.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Strikethrough
  r = r.replace(/~~(.+?)~~/g, "<s>$1</s>");
  return r;
}

function parseTableRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function parseTableBlock(
  lines: string[],
  startIdx: number,
): { html: string; endIdx: number } {
  // Collect all table lines
  const tableLines: string[] = [];
  let i = startIdx;
  while (i < lines.length && lines[i].includes("|")) {
    tableLines.push(lines[i].trim());
    i++;
  }
  if (tableLines.length < 2) return { html: "", endIdx: i };

  const headers = parseTableRow(tableLines[0]);
  // tableLines[1] is the separator (---|---), skip it
  const bodyRows = tableLines.slice(2).map(parseTableRow);

  let html = "<table><thead><tr>";
  for (const cell of headers) {
    html += `<th>${formatInline(cell)}</th>`;
  }
  html += "</tr></thead>";

  if (bodyRows.length > 0) {
    html += "<tbody>";
    for (const row of bodyRows) {
      html += "<tr>";
      for (let c = 0; c < headers.length; c++) {
        html += `<td>${formatInline(row[c] || "")}</td>`;
      }
      html += "</tr>";
    }
    html += "</tbody>";
  }

  html += "</table>";
  return { html, endIdx: i };
}

interface ListItem {
  indent: number;
  text: string;
  ordered: boolean;
}

function parseListBlock(
  lines: string[],
  startIdx: number,
): { html: string; endIdx: number } {
  const items: ListItem[] = [];
  let i = startIdx;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
    if (!m) break;
    items.push({
      indent: m[1].length,
      text: m[3],
      ordered: /^\d+\./.test(m[2]),
    });
    i++;
  }
  return { html: buildNestedList(items, 0, 0), endIdx: i };
}

function buildNestedList(
  items: ListItem[],
  fromIdx: number,
  baseIndent: number,
): string {
  if (fromIdx >= items.length) return "";
  const tag = items[fromIdx].ordered ? "ol" : "ul";
  let html = `<${tag}>`;
  let i = fromIdx;

  while (i < items.length && items[i].indent >= baseIndent) {
    if (items[i].indent > baseIndent) {
      // Nested list — find where it ends
      const nestedStart = i;
      while (i < items.length && items[i].indent > baseIndent) i++;
      // Append nested list inside the previous <li>
      const nested = buildNestedList(
        items,
        nestedStart,
        items[nestedStart].indent,
      );
      // Re-open last li to append nested list
      html = html.replace(/<\/li>$/, nested + "</li>");
    } else {
      html += `<li>${formatInline(items[i].text)}</li>`;
      i++;
    }
  }

  html += `</${tag}>`;
  return html;
}

export function markdownToHtml(markdown: string): string {
  // Extract fenced code blocks first
  const codeBlocks: string[] = [];
  const processed = markdown.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, _lang, code) => {
      codeBlocks.push(`<pre><code>${esc(code.trimEnd())}</code></pre>`);
      return `\x00CB${codeBlocks.length - 1}\x00`;
    },
  );

  const lines = processed.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code block placeholder
    const cbMatch = trimmed.match(/^\x00CB(\d+)\x00$/);
    if (cbMatch) {
      output.push(codeBlocks[parseInt(cbMatch[1])]);
      i++;
      continue;
    }

    // Empty line
    if (trimmed === "") {
      i++;
      continue;
    }

    // Heading
    const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      output.push(`<h${level}>${formatInline(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(trimmed) && !/\S/.test(trimmed.replace(/[-*_]/g, ""))) {
      output.push("<hr>");
      i++;
      continue;
    }

    // Table (line with | and next line is separator)
    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      /^\|?\s*[-:|]+[-:|\s]+$/.test(lines[i + 1].trim())
    ) {
      const result = parseTableBlock(lines, i);
      output.push(result.html);
      i = result.endIdx;
      continue;
    }

    // List item (ordered or unordered)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const result = parseListBlock(lines, i);
      output.push(result.html);
      i = result.endIdx;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      output.push(
        `<blockquote><p>${formatInline(quoteLines.join(" "))}</p></blockquote>`,
      );
      continue;
    }

    // Paragraph — collect consecutive non-special lines
    const paraLines: string[] = [trimmed];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,6}\s/.test(lines[i].trim()) &&
      !/^\s*([-*+]|\d+\.)\s/.test(lines[i]) &&
      !lines[i].trim().startsWith(">") &&
      !/^[-*_]{3,}$/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith("\x00CB")
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    output.push(`<p>${formatInline(paraLines.join(" "))}</p>`);
  }

  return output.join("\n");
}

// ============================================================
// Google Docs JSON -> Markdown
// ============================================================

const ORDERED_GLYPH_TYPES = new Set([
  "DECIMAL",
  "ZERO_DECIMAL",
  "UPPER_ALPHA",
  "ALPHA",
  "UPPER_ROMAN",
  "ROMAN",
]);

function isOrderedList(
  lists: Record<string, docs_v1.Schema$List>,
  listId: string,
  nestingLevel: number,
): boolean {
  const listProps = lists[listId]?.listProperties;
  if (!listProps?.nestingLevels) return false;
  const level = listProps.nestingLevels[nestingLevel];
  if (!level) return false;
  // If glyphType is set and is a number type, it's ordered
  if (level.glyphType && ORDERED_GLYPH_TYPES.has(level.glyphType)) return true;
  // If glyphSymbol is set (bullet char like ●), it's unordered
  if (level.glyphSymbol) return false;
  return false;
}

function extractFormattedText(elements: docs_v1.Schema$ParagraphElement[]): string {
  let text = "";
  for (const el of elements) {
    if (!el.textRun) continue;
    const content = el.textRun.content || "";
    const style = el.textRun.textStyle;

    let chunk = content;
    // Don't format trailing newlines
    const trailingNewline = chunk.endsWith("\n");
    if (trailingNewline) chunk = chunk.slice(0, -1);
    if (chunk === "") {
      if (trailingNewline) text += "\n";
      continue;
    }

    // Detect monospace font → inline code
    const fontFamily = style?.weightedFontFamily?.fontFamily?.toLowerCase() || "";
    const isCode =
      fontFamily.includes("mono") ||
      fontFamily.includes("courier") ||
      fontFamily.includes("consolas");

    if (isCode) {
      chunk = `\`${chunk}\``;
    } else {
      if (style?.bold) chunk = `**${chunk}**`;
      if (style?.italic) chunk = `*${chunk}*`;
      if (style?.strikethrough) chunk = `~~${chunk}~~`;
    }

    if (style?.link?.url) {
      chunk = `[${chunk}](${style.link.url})`;
    }

    text += chunk;
    if (trailingNewline) text += "\n";
  }
  return text;
}

function convertTable(table: docs_v1.Schema$Table): string {
  const rows = table.tableRows || [];
  if (rows.length === 0) return "";

  const mdRows: string[][] = [];
  for (const row of rows) {
    const cells: string[] = [];
    for (const cell of row.tableCells || []) {
      let cellText = "";
      for (const el of cell.content || []) {
        if (el.paragraph) {
          cellText += extractFormattedText(el.paragraph.elements || []);
        }
      }
      cells.push(cellText.replace(/\n/g, " ").trim());
    }
    mdRows.push(cells);
  }

  if (mdRows.length === 0) return "";

  const colCount = Math.max(...mdRows.map((r) => r.length));
  const normalize = (row: string[]) => {
    while (row.length < colCount) row.push("");
    return row;
  };

  const header = normalize(mdRows[0]);
  let md = `| ${header.join(" | ")} |\n`;
  md += `| ${header.map(() => "---").join(" | ")} |\n`;

  for (let r = 1; r < mdRows.length; r++) {
    const row = normalize(mdRows[r]);
    md += `| ${row.join(" | ")} |\n`;
  }

  return md + "\n";
}

export function documentToMarkdown(
  doc: docs_v1.Schema$Document,
): string {
  const body = doc.body;
  if (!body?.content) return "";

  const lists: Record<string, docs_v1.Schema$List> = (doc.lists as Record<string, docs_v1.Schema$List>) || {};
  let md = "";

  for (const element of body.content) {
    if (element.table) {
      md += convertTable(element.table);
      continue;
    }

    if (element.sectionBreak) {
      md += "\n---\n\n";
      continue;
    }

    if (!element.paragraph) continue;

    const para = element.paragraph;
    const elements = para.elements || [];
    const text = extractFormattedText(elements);

    // Skip empty paragraphs
    if (!text.trim()) {
      md += "\n";
      continue;
    }

    // Heading
    const namedStyle = para.paragraphStyle?.namedStyleType;
    if (namedStyle?.startsWith("HEADING_")) {
      const level = parseInt(namedStyle.replace("HEADING_", ""));
      if (level >= 1 && level <= 6) {
        md += `${"#".repeat(level)} ${text.trim()}\n\n`;
        continue;
      }
    }
    if (namedStyle === "TITLE") {
      md += `# ${text.trim()}\n\n`;
      continue;
    }
    if (namedStyle === "SUBTITLE") {
      md += `## ${text.trim()}\n\n`;
      continue;
    }

    // List item
    if (para.bullet) {
      const nestingLevel = para.bullet.nestingLevel || 0;
      const indent = "  ".repeat(nestingLevel);
      const listId = para.bullet.listId || "";
      const ordered = isOrderedList(lists, listId, nestingLevel);
      const marker = ordered ? "1." : "-";
      md += `${indent}${marker} ${text.trim()}\n`;
      continue;
    }

    // Normal paragraph
    md += `${text.trim()}\n\n`;
  }

  return md.replace(/\n{4,}/g, "\n\n\n").trim();
}
