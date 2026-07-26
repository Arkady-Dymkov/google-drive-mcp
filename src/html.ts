import { selectAll, selectOne } from "css-select";
import render from "dom-serializer";
import { DomUtils, parseDocument } from "htmlparser2";

type HtmlNode = ReturnType<typeof parseDocument>["children"][number];

function selectFirst(selector: string, nodes: HtmlNode[]): HtmlNode | null {
  return selectOne<HtmlNode, HtmlNode>(selector, nodes);
}

function selectMany(selector: string, nodes: HtmlNode[]): HtmlNode[] {
  return selectAll<HtmlNode, HtmlNode>(selector, nodes);
}

function innerHtml(node: HtmlNode): string {
  return render(DomUtils.getChildren(node));
}

function removeAll(selector: string, nodes: HtmlNode[]): void {
  for (const node of selectMany(selector, nodes)) {
    DomUtils.removeElement(node);
  }
}

/**
 * Remove active or metadata-only elements before untrusted email HTML is
 * converted to Markdown. The returned HTML contains the body contents when a
 * body exists, otherwise the complete sanitized fragment.
 */
export function sanitizeHtmlForMarkdown(html: string): string {
  const document = parseDocument(html);
  const nodes = document.children;
  removeAll(
    "script, style, head, meta, link, object, embed, iframe",
    nodes,
  );
  const body = selectFirst("body", nodes);
  return body ? innerHtml(body) : render(nodes);
}

export interface ExtractedDocumentHtml {
  title: string;
  primaryContentHtml: string;
  fallbackContentHtml: string;
  plainText: string;
  fallbackMarkdown: string;
}

/**
 * Extract the useful parts of Google's unsupported mobilebasic document page.
 * Both a preferred main-content result and a structural fallback are returned
 * so the caller can retain its existing minimum-content trust checks.
 */
export function extractReadableDocumentHtml(
  html: string,
): ExtractedDocumentHtml {
  const document = parseDocument(html);
  const nodes = document.children;
  const textOf = (selector: string) => {
    const node = selectFirst(selector, nodes);
    return node ? DomUtils.textContent(node).trim() : "";
  };

  const title = (
    textOf("title") ||
    textOf("h1") ||
    "Untitled Document"
  )
    .replace(/ - Google Docs$/i, "")
    .trim();

  removeAll("script, style, object, embed, iframe", nodes);

  const mainContent = selectFirst(
    ".doc-content, .document-content, #contents, main",
    nodes,
  );
  const primaryContentHtml = mainContent ? innerHtml(mainContent) : "";

  const fallbackContentHtml = selectMany(
    "h1, h2, h3, h4, h5, h6, p, ul, ol, table",
    nodes,
  )
    .filter((node) => DomUtils.textContent(node).trim().length > 0)
    .map((node) => render(node))
    .join("\n");

  const body = selectFirst("body", nodes);
  const plainText = DomUtils.textContent(body ?? nodes).trim();
  const fallbackMarkdown = selectMany(
    "p, h1, h2, h3, h4, h5, h6",
    nodes,
  )
    .map((node) => {
      const text = DomUtils.textContent(node).trim();
      const tagName = "name" in node ? node.name.toLowerCase() : "";
      if (!text) return "";
      if (/^h[1-6]$/.test(tagName)) {
        return `${"#".repeat(Number(tagName.slice(1)))} ${text}`;
      }
      return text;
    })
    .filter(Boolean)
    .join("\n\n");

  return {
    title,
    primaryContentHtml,
    fallbackContentHtml,
    plainText,
    fallbackMarkdown,
  };
}
