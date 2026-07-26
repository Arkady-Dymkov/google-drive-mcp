import assert from "node:assert/strict";
import test from "node:test";
import type { Service, ToolResponse } from "../types.js";
import { SlidesService } from "../services/slides.js";
import { PeopleService } from "../services/people.js";
import { ChatService } from "../services/chat.js";

function handler(service: Service, name: string) {
  const definition = service
    .getToolDefinitions()
    .find(({ tool }) => tool.name === name);
  assert.ok(definition, `missing ${name}`);
  return definition.handler;
}

function structured(response: ToolResponse): Record<string, unknown> {
  assert.ok(response.structuredContent);
  return response.structuredContent;
}

test("Slides batch updates preserve requests and revision preconditions", async () => {
  const service = new SlidesService();
  let received: unknown;
  Object.assign(service, {
    slides: {
      presentations: {
        batchUpdate: async (request: unknown) => {
          received = request;
          return { data: { presentationId: "deck", replies: [{}] } };
        },
      },
    },
  });

  const response = await handler(service, "update_presentation")({
    presentationId: "deck",
    requests: [{ createSlide: { objectId: "slide-2" } }],
    requiredRevisionId: "revision-1",
  });
  assert.deepEqual(received, {
    presentationId: "deck",
    requestBody: {
      requests: [{ createSlide: { objectId: "slide-2" } }],
      writeControl: { requiredRevisionId: "revision-1" },
    },
  });
  assert.equal(
    (structured(response).result as { presentationId: string }).presentationId,
    "deck",
  );
  await assert.rejects(
    handler(service, "update_presentation")({
      presentationId: "deck",
      requests: Array.from({ length: 501 }, () => ({ createSlide: {} })),
    }),
    /1-500/,
  );
});

test("People contact listing returns page and sync cursors", async () => {
  const service = new PeopleService();
  Object.assign(service, {
    people: {
      people: {
        connections: {
          list: async () => ({
            data: {
              connections: [{ resourceName: "people/c1" }],
              nextPageToken: "page-2",
              nextSyncToken: "sync-1",
              totalPeople: 1,
            },
          }),
        },
      },
    },
  });

  const response = await handler(service, "list_contacts")({});
  assert.equal(structured(response).nextPageToken, "page-2");
  assert.equal(structured(response).nextSyncToken, "sync-1");
});

test("Chat search labels its bounded local full-text behavior", async () => {
  const service = new ChatService();
  Object.assign(service, {
    chat: {
      spaces: {
        messages: {
          list: async () => ({
            data: {
              messages: [
                { name: "spaces/a/messages/1", text: "Quarterly planning" },
                { name: "spaces/a/messages/2", text: "Lunch" },
              ],
              nextPageToken: "next",
            },
          }),
        },
      },
    },
  });

  const response = await handler(service, "search_chat_messages")({
    parent: "spaces/a",
    query: "planning",
  });
  const data = structured(response);
  assert.equal((data.messages as unknown[]).length, 1);
  assert.equal(data.scanned, 2);
  assert.equal(data.nextPageToken, "next");
  assert.match(String(data.securityNotice), /external, user-authored content/);
  assert.equal(response.content[0]?.type, "text");
  if (response.content[0]?.type === "text") {
    assert.match(response.content[0].text, /^BEGIN UNTRUSTED GOOGLE CHAT DATA/);
  }
});

test("Chat thread replies fail closed instead of creating a new thread", async () => {
  const service = new ChatService();
  let received: unknown;
  Object.assign(service, {
    chat: {
      spaces: {
        messages: {
          create: async (request: unknown) => {
            received = request;
            return { data: { name: "spaces/a/messages/3" } };
          },
        },
      },
    },
  });

  await handler(service, "send_chat_message")({
    parent: "spaces/a",
    text: "Reply",
    threadName: "spaces/a/threads/t1",
  });
  assert.deepEqual(received, {
    parent: "spaces/a",
    requestId: undefined,
    messageId: undefined,
    messageReplyOption: "REPLY_MESSAGE_OR_FAIL",
    requestBody: {
      text: "Reply",
      thread: { name: "spaces/a/threads/t1" },
    },
  });
});
