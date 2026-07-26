import assert from "node:assert/strict";
import test from "node:test";
import {
  extractReadableDocumentHtml,
  sanitizeHtmlForMarkdown,
} from "../html.js";

test("email HTML sanitization removes active and metadata-only elements", () => {
  const sanitized = sanitizeHtmlForMarkdown(`
    <html>
      <head><title>Hidden</title><style>.secret { color: red; }</style></head>
      <body>
        <h1>Hello &amp; welcome</h1>
        <script>alert("script payload")</script>
        <iframe src="https://example.invalid">iframe payload</iframe>
        <p>Safe body</p>
      </body>
    </html>
  `);

  assert.match(sanitized, /<h1>Hello &amp; welcome<\/h1>/);
  assert.match(sanitized, /<p>Safe body<\/p>/);
  assert.doesNotMatch(sanitized, /Hidden|secret|script payload|iframe payload/i);
  assert.doesNotMatch(sanitized, /<(?:head|style|script|iframe)\b/i);
});

test("mobilebasic extraction prefers main content and preserves safe fallbacks", () => {
  const extracted = extractReadableDocumentHtml(`
    <html>
      <head><title>Project Notes - Google Docs</title></head>
      <body>
        <nav><p>Navigation</p></nav>
        <main class="doc-content">
          <h2>Plan</h2>
          <p>Ship the parser migration safely.</p>
          <script>doNotReturn()</script>
        </main>
      </body>
    </html>
  `);

  assert.equal(extracted.title, "Project Notes");
  assert.match(extracted.primaryContentHtml, /<h2>Plan<\/h2>/);
  assert.match(extracted.primaryContentHtml, /Ship the parser migration safely/);
  assert.doesNotMatch(extracted.primaryContentHtml, /doNotReturn|script/i);
  assert.match(extracted.fallbackContentHtml, /<p>Navigation<\/p>/);
  assert.match(extracted.fallbackMarkdown, /## Plan/);
  assert.match(extracted.plainText, /Ship the parser migration safely/);
  assert.doesNotMatch(extracted.plainText, /doNotReturn/);
});

test("mobilebasic extraction falls back to structural content without a main", () => {
  const extracted = extractReadableDocumentHtml(`
    <h1>Fallback title</h1>
    <p>First paragraph.</p>
    <ul><li>One</li><li>Two</li></ul>
  `);

  assert.equal(extracted.title, "Fallback title");
  assert.equal(extracted.primaryContentHtml, "");
  assert.match(extracted.fallbackContentHtml, /First paragraph/);
  assert.match(extracted.fallbackContentHtml, /<ul>/);
  assert.match(extracted.fallbackMarkdown, /^# Fallback title/m);
  assert.match(extracted.fallbackMarkdown, /First paragraph/);
});
