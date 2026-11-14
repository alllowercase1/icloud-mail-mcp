// Runs the connector's tools against Hoodiecrow, a strict, standards-following IMAP test server.
// This checks the IMAP client and MIME handling; it can't prove iCloud-specific behaviour.
import net from "node:net";
import { Duplex } from "node:stream";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { callTool, type MailConfig } from "../src/mail";
import { handleMcp } from "../src/mcp";

const require = createRequire(import.meta.url);
const hoodiecrow = require("hoodiecrow-imap");

const CRLF = (s: string) => s.replace(/\r?\n/g, "\r\n");

const plain = CRLF(`From: Chris Example <chris@example.com>
To: Alex <alex@example.com>
Subject: Tour budget
Date: Tue, 10 Nov 2026 10:00:00 -0500
Message-ID: <a1@example.com>
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Hi Alex,=0A=0AThe budget is attached in the next mail. Caf=C3=A9 at 5?
`);

const multipart = CRLF(`From: =?UTF-8?B?Sm9zw6kgw4FsdmFyZXo=?= <jose@example.com>
To: alex@example.com
Cc: "Ops Team" <ops@example.com>
Subject: =?UTF-8?Q?Contrat_r=C3=A9vis=C3=A9?= and notes
Date: Wed, 11 Nov 2026 09:30:00 +0000
Message-ID: <a2@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: multipart/alternative; boundary="inner"

--inner
Content-Type: text/plain; charset=iso-8859-1
Content-Transfer-Encoding: base64

${Buffer.from("Plain version: résumé attached.\n", "latin1").toString("base64")}
--inner
Content-Type: text/html; charset=utf-8

<p>HTML version</p>
--inner--
--outer
Content-Type: application/pdf; name="contract.pdf"
Content-Disposition: attachment; filename*=UTF-8''Contrat%20r%C3%A9vis%C3%A9.pdf
Content-Transfer-Encoding: base64

JVBERi0xLjQKJcfsj6IKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoK
--outer--
`);

const htmlOnly = CRLF(`From: Newsletter <news@example.com>
To: alex@example.com
Subject: Weekly picks
Date: Thu, 12 Nov 2026 08:00:00 +0000
Message-ID: <a3@example.com>
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: quoted-printable

<html><head><style>p{color:red}</style></head><body><h1>Picks</h1><p>Listen to <a href=3D"https://example.com/x">this track</a> &amp; more.<br>Bye&nbsp;now</p><script>alert(1)</script></body></html>
`);

const sent = CRLF(`From: alex@example.com
To: Sam <sam@example.com>
Subject: Re: Flog Gnaw set times
Date: Thu, 12 Nov 2026 18:00:00 +0000
Message-ID: <s1@example.com>
In-Reply-To: <x@example.com>

Set is at 4:15.
`);

const storage = {
  INBOX: {
    messages: [
      { raw: plain, flags: ["\\Seen"], internaldate: "10-Nov-2026 15:00:00 +0000" },
      { raw: multipart, flags: [], internaldate: "11-Nov-2026 09:30:00 +0000" },
      { raw: htmlOnly, flags: ["\\Flagged"], internaldate: "12-Nov-2026 08:00:00 +0000" },
    ],
  },
  "": {
    separator: "/",
    folders: {
      "Sent Messages": { "special-use": "\\Sent", messages: [{ raw: sent, flags: ["\\Seen"], internaldate: "12-Nov-2026 18:00:00 +0000" }] },
      Archive: {
        "special-use": "\\Archive",
        messages: [
          {
            raw: new Uint8Array(Buffer.from(CRLF("From: a@example.com\nSubject: Berlin\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: 8bit\n\nViele Grüße aus Berlin\n"), "utf8")),
            internaldate: "01-Oct-2026 10:00:00 +0000",
          },
        ],
      },
      // "Reçus" in modified UTF-7
      "Re&AOc-us": { messages: [] },
    },
  },
};

async function main() {
  const server = hoodiecrow({ storage, plugins: ["SPECIAL-USE"], debug: !!process.env.IMAPDEBUG });
  await new Promise<void>((r) => server.server.listen(0, "127.0.0.1", r));
  const port = (server.server.address() as net.AddressInfo).port;

  const cfg = (password = "testpass"): MailConfig => ({
    user: "testuser",
    password,
    openTransport: async () => {
      const sock = net.connect(port, "127.0.0.1");
      await new Promise<void>((r, j) => {
        sock.once("connect", r);
        sock.once("error", j);
      });
      const web = Duplex.toWeb(sock) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
      return { readable: web.readable, writable: web.writable, close: () => void sock.destroy() };
    },
  });

  let passed = 0;
  const test = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passed++;
      console.log("ok  ", name);
    } catch (e) {
      console.log("FAIL", name);
      throw e;
    }
  };

  await test("list_mailboxes with counts, special-use and UTF-7 names", async () => {
    const r = (await callTool("list_mailboxes", { include_counts: true }, cfg())) as any;
    const names = r.mailboxes.map((m: any) => m.name);
    assert.ok(names.includes("INBOX"));
    assert.ok(names.includes("Sent Messages"));
    assert.ok(names.includes("Reçus"), JSON.stringify(names));
    const inbox = r.mailboxes.find((m: any) => m.name === "INBOX");
    assert.equal(inbox.messages, 3);
    assert.equal(inbox.unread, 2);
    assert.equal(r.mailboxes.find((m: any) => m.name === "Sent Messages").role, "sent");
  });

  await test("search: newest first, no filters", async () => {
    const r = (await callTool("search_messages", {}, cfg())) as any;
    assert.equal(r.total_matches, 3);
    assert.deepEqual(r.messages.map((m: any) => m.subject), ["Weekly picks", "Contrat révisé and notes", "Tour budget"]);
    assert.equal(r.messages[1].from, "José Álvarez <jose@example.com>");
    assert.equal(r.messages[0].flagged, true);
    assert.equal(r.messages[2].unread, false);
  });

  await test("search: from + since + limit", async () => {
    const r = (await callTool("search_messages", { from: "chris", since: "2026-11-01", limit: 5 }, cfg())) as any;
    assert.equal(r.total_matches, 1);
    assert.equal(r.messages[0].subject, "Tour budget");
  });

  await test("search: unread_only and before", async () => {
    const r = (await callTool("search_messages", { unread_only: true, before: "2026-11-12" }, cfg())) as any;
    assert.deepEqual(r.messages.map((m: any) => m.subject), ["Contrat révisé and notes"]);
  });

  await test("search: non-ASCII text uses CHARSET UTF-8 literal", async () => {
    // (Hoodiecrow matches undecoded headers, so this checks an 8-bit body instead of an encoded subject.)
    const r = (await callTool("search_messages", { mailbox: "Archive", text: "Grüße" }, cfg())) as any;
    assert.equal(r.total_matches, 1, JSON.stringify(r));
    const r2 = (await callTool("get_message", { mailbox: "Archive", uid: r.messages[0].uid }, cfg())) as any;
    assert.equal(r2.body, "Viele Grüße aus Berlin");
  });

  await test("search: limit returns newest", async () => {
    const r = (await callTool("search_messages", { limit: 1 }, cfg())) as any;
    assert.equal(r.returned, 1);
    assert.equal(r.messages[0].subject, "Weekly picks");
    assert.ok(r.note);
  });

  await test("search in Sent Messages", async () => {
    const r = (await callTool("search_messages", { mailbox: "Sent Messages", to: "sam" }, cfg())) as any;
    assert.equal(r.messages[0].subject, "Re: Flog Gnaw set times");
  });

  await test("search in empty non-ASCII mailbox", async () => {
    const r = (await callTool("search_messages", { mailbox: "Reçus" }, cfg())) as any;
    assert.equal(r.total_matches, 0);
  });

  await test("get_message: quoted-printable plain text", async () => {
    const r = (await callTool("get_message", { uid: 1 }, cfg())) as any;
    assert.equal(r.subject, "Tour budget");
    assert.ok(r.body.includes("Café at 5?"), r.body);
    assert.deepEqual(r.attachments, []);
  });

  await test("get_message: multipart picks text/plain, decodes latin1 base64, lists attachment", async () => {
    const r = (await callTool("get_message", { uid: 2 }, cfg())) as any;
    assert.equal(r.body, "Plain version: résumé attached.");
    assert.equal(r.body_format, "text/plain");
    assert.equal(r.attachments.length, 1);
    assert.equal(r.attachments[0].filename, "Contrat révisé.pdf");
    assert.equal(r.attachments[0].content_type, "application/pdf");
    assert.deepEqual(r.cc, ["Ops Team <ops@example.com>"]);
  });

  await test("get_message does not mark as read", async () => {
    const r = (await callTool("search_messages", { unread_only: true }, cfg())) as any;
    assert.ok(r.messages.some((m: any) => m.uid === 2), "uid 2 should still be unread");
  });

  await test("get_message: html-only converted to text", async () => {
    const r = (await callTool("get_message", { uid: 3, max_chars: 500 }, cfg())) as any;
    assert.ok(r.body.includes("Picks"));
    assert.ok(r.body.includes("this track (https://example.com/x) & more."), r.body);
    assert.ok(r.body.includes("Bye now"));
    assert.ok(!r.body.includes("alert"));
    assert.ok(!r.body.includes("color:red"));
  });

  await test("get_message: missing uid gives clear error", async () => {
    await assert.rejects(callTool("get_message", { uid: 999 }, cfg()), /No message with uid 999/);
  });

  await test("wrong password gives sign-in error without leaking it", async () => {
    await assert.rejects(callTool("list_mailboxes", {}, cfg("wrong-secret-xyz")), (e: Error) => {
      assert.match(e.message, /iCloud rejected the sign-in/);
      assert.ok(!e.message.includes("wrong-secret-xyz"));
      return true;
    });
  });

  await test("bad date is rejected", async () => {
    await assert.rejects(callTool("search_messages", { since: "Nov 1" }, cfg()), /since must be a date/);
  });

  // MCP JSON-RPC layer
  const rpc = async (body: unknown) => {
    const res = await handleMcp(new Request("https://x/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), cfg(), { user: "", password: "", caldavUrl: "https://caldav.icloud.com/", carddavUrl: "https://contacts.icloud.com/" });
    return { status: res.status, body: res.status === 202 ? null : ((await res.json()) as any) };
  };

  await test("MCP initialize, notifications, tools/list, tools/call", async () => {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.ok(init.body.result.capabilities.tools);
    const note = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(list.body.result.tools.map((t: any) => t.name), ["list_mailboxes", "search_messages", "get_message", "list_calendars", "list_events", "search_contacts", "get_contact"]);
    assert.ok(list.body.result.tools.every((t: any) => t.annotations.readOnlyHint === true));
    const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_messages", arguments: { subject: "budget" } } });
    assert.ok(!call.body.result.isError);
    assert.equal(JSON.parse(call.body.result.content[0].text).messages[0].subject, "Tour budget");
    const err = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_message", arguments: { uid: 999 } } });
    assert.equal(err.body.result.isError, true);
    const unknown = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "send_email", arguments: {} } });
    assert.equal(unknown.body.error.code, -32602);
  });

  console.log(`\n${passed} tests passed`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
