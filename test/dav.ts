// Runs the Calendar and Contacts tools against a small mock CalDAV/CardDAV server that answers
// the way iCloud does (principal, home set, multistatus). It can't prove iCloud-specific behaviour.
import http from "node:http";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { callDavTool, expandRRule, parseEvents, type DavConfig } from "../src/dav";

const USER = process.env.DAV_USER || "owner@icloud.com";
const PASS = process.env.DAV_PASS || "abcd-efgh-ijkl-mnop";
let filterUnsupported = false;
const seenMethods = new Set<string>();

const CRLF = (s: string) => s.replace(/\r?\n/g, "\r\n");

const homeIcs = CRLF(`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//iCloud//EN
BEGIN:VTIMEZONE
TZID:America/New_York
END:VTIMEZONE
BEGIN:VEVENT
UID:standup-1
SUMMARY:Standup
DTSTART;TZID=America/New_York:20260105T100000
DTEND;TZID=America/New_York:20260105T101500
RRULE:FREQ=WEEKLY;BYDAY=MO,WE
EXDATE;TZID=America/New_York:20261116T100000
BEGIN:VALARM
ACTION:DISPLAY
SUMMARY:Alarm text must not leak
TRIGGER:-PT10M
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:standup-1
RECURRENCE-ID;TZID=America/New_York:20261118T100000
SUMMARY:Standup (moved)
DTSTART;TZID=America/New_York:20261118T110000
DTEND;TZID=America/New_York:20261118T111500
END:VEVENT
END:VCALENDAR
`);

const dinnerIcs = CRLF(`BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:dinner-1
SUMMARY:Dinner\\, drinks with Chris
LOCATION:Cafe\\, Springfield
DESCRIPTION:Bring the contract.\\nAsk about April
 dates.
DTSTART:20261117T230000Z
DURATION:PT2H
ORGANIZER;CN=Chris Example:mailto:chris@example.com
ATTENDEE;CN=Alex;PARTSTAT=ACCEPTED:mailto:owner@icloud.com
ATTENDEE;CN="Doe, Jane";PARTSTAT=NEEDS-ACTION:mailto:jane@example.com
END:VEVENT
END:VCALENDAR
`);

const allDayIcs = CRLF(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:trip-1
SUMMARY:Trip to LA
DTSTART;VALUE=DATE:20261120
DTEND;VALUE=DATE:20261122
END:VEVENT
END:VCALENDAR
`);

const pastSeriesIcs = CRLF(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:monthly-1
SUMMARY:Three monthly calls
DTSTART:20260901T150000Z
DURATION:PT30M
RRULE:FREQ=MONTHLY;COUNT=3
END:VEVENT
BEGIN:VEVENT
UID:bday-1
SUMMARY:Birthday
DTSTART;VALUE=DATE:19900315
RRULE:FREQ=YEARLY
END:VEVENT
END:VCALENDAR
`);

// "Work" behaves like a server that expands recurrences itself
const workIcs = CRLF(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:review-1
RECURRENCE-ID:20261119T140000Z
SUMMARY:Weekly review
DTSTART:20261119T140000Z
DTEND:20261119T150000Z
END:VEVENT
END:VCALENDAR
`);

const chrisVcf = CRLF(`BEGIN:VCARD
VERSION:3.0
N:Example;Chris;;;
FN:Chris Example
ORG:alllowercase\\, LLC;Management
TITLE:Partner
item1.EMAIL;type=INTERNET;type=pref:chris@example.com
item1.X-ABLabel:_$!<Work>!$_
EMAIL;type=INTERNET;type=HOME:chris.home@example.com
TEL;type=CELL;type=VOICE;type=pref:(917) 555-0142
item2.ADR;type=HOME:;;12 Main St;Springfield;NY;11201;USA
item2.X-ABLabel:_$!<Home>!$_
BDAY:1990-04-02
NOTE:Met at SXSW.\\nLikes oat milk.
PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHB
 wgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy
END:VCARD
`);
const joseVcf = CRLF(`BEGIN:VCARD
VERSION:3.0
N:Álvarez;José;;;
FN:José Álvarez
EMAIL;type=INTERNET:jose@example.com
TEL;type=WORK:+44 20 7946 0958
END:VCARD
`);
const opsVcf = CRLF(`BEGIN:VCARD
VERSION:3.0
N:;;;;
ORG:Ops Team;
X-ABShowAs:COMPANY
EMAIL:ops@example.com
END:VCARD
`);
const CARDS: Record<string, string> = { "chris.vcf": chrisVcf, "jose%20alvarez.vcf": joseVcf, "ops.vcf": opsVcf };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ms = (responses: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav" xmlns:A="http://apple.com/ns/ical/">${responses}</multistatus>`;
const resp = (href: string, props: string) =>
  `<response><href>${href}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`;

let base = "";
let principalOverride = "";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seenMethods.add(req.method!);
    const send = (status: number, text: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/xml; charset=utf-8", ...headers });
      res.end(text);
    };
    const expected = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
    if (req.headers.authorization !== expected) return send(401, "", { "WWW-Authenticate": 'Basic realm="x"' });
    const url = req.url!.split("?")[0];

    if (req.method === "PROPFIND" && (url === "/" || url === "/card/")) {
      const href = principalOverride || "/123/principal/";
      return send(207, ms(resp(url, `<current-user-principal><href>${href}</href></current-user-principal>`)));
    }
    if (req.method === "PROPFIND" && url === "/card-root/") return send(301, "", { Location: "/card/" });
    if (req.method === "PROPFIND" && url === "/123/principal/") {
      if (body.includes("calendar-home-set"))
        return send(207, ms(resp(url, `<C:calendar-home-set><href>${base}/123/calendars/</href></C:calendar-home-set>`)));
      return send(207, ms(resp(url, `<CR:addressbook-home-set><href>/123/carddav/</href></CR:addressbook-home-set>`)));
    }
    if (req.method === "PROPFIND" && url === "/123/calendars/") {
      assert.equal(req.headers.depth, "1");
      return send(
        207,
        ms(
          resp("/123/calendars/", `<resourcetype><collection/></resourcetype>`) +
            resp("/123/calendars/home/", `<displayname>Home</displayname><resourcetype><collection/><C:calendar/></resourcetype><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set><A:calendar-color>#FF2968</A:calendar-color>`) +
            resp("/123/calendars/work/", `<displayname>Work &amp; Tour</displayname><resourcetype><collection/><C:calendar/></resourcetype><C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set>`) +
            resp("/123/calendars/tasks/", `<displayname>Reminders</displayname><resourcetype><collection/><C:calendar/></resourcetype><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>`) +
            resp("/123/calendars/inbox/", `<resourcetype><collection/><C:schedule-inbox/></resourcetype>`),
        ),
      );
    }
    if (req.method === "REPORT" && url === "/123/calendars/home/") {
      assert.match(body, /calendar-query/);
      assert.match(body, /time-range start="\d{8}T\d{6}Z"/);
      return send(
        207,
        ms(
          resp("/123/calendars/home/standup.ics", `<C:calendar-data>${esc(homeIcs)}</C:calendar-data>`) +
            resp("/123/calendars/home/dinner.ics", `<C:calendar-data><![CDATA[${dinnerIcs}]]></C:calendar-data>`) +
            resp("/123/calendars/home/trip.ics", `<C:calendar-data>${esc(allDayIcs)}</C:calendar-data>`) +
            resp("/123/calendars/home/past.ics", `<C:calendar-data>${esc(pastSeriesIcs)}</C:calendar-data>`),
        ),
      );
    }
    if (req.method === "REPORT" && url === "/123/calendars/work/") {
      return send(207, ms(resp("/123/calendars/work/review.ics", `<C:calendar-data>${esc(workIcs)}</C:calendar-data>`)));
    }
    if (req.method === "PROPFIND" && url === "/123/carddav/") {
      return send(
        207,
        ms(
          resp("/123/carddav/", `<resourcetype><collection/></resourcetype>`) +
            resp("/123/carddav/card/", `<displayname>Card</displayname><resourcetype><collection/><CR:addressbook/></resourcetype>`),
        ),
      );
    }
    if (req.method === "REPORT" && url === "/123/carddav/card/") {
      const m = /<card:text-match[^>]*>([^<]*)</.exec(body);
      if (m && filterUnsupported) return send(501, "");
      const needle = m ? m[1].toLowerCase() : "";
      const rows = Object.entries(CARDS)
        .filter(([, v]) => !needle || v.toLowerCase().includes(needle))
        .map(([k, v]) => resp(`/123/carddav/card/${k}`, `<getetag>"1"</getetag><CR:address-data>${esc(v)}</CR:address-data>`))
        .join("");
      return send(207, ms(rows));
    }
    if (req.method === "GET" && url.startsWith("/123/carddav/card/")) {
      const v = CARDS[url.slice("/123/carddav/card/".length)];
      if (!v) return send(404, "");
      res.writeHead(200, { "Content-Type": "text/vcard" });
      return res.end(v);
    }
    send(405, "");
  });
});

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error("  FAIL " + name);
    throw e;
  }
}

async function main() {
  if (process.env.DAV_SERVE_PORT) {
    // serve only, for test/e2e.ts running through `wrangler dev`
    await new Promise<void>((r) => server.listen(Number(process.env.DAV_SERVE_PORT), "127.0.0.1", r));
    base = `http://127.0.0.1:${process.env.DAV_SERVE_PORT}`;
    console.log("mock CalDAV/CardDAV on " + base);
    return;
  }
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cfg = (over: Partial<DavConfig> = {}): DavConfig => ({
    user: USER,
    password: PASS,
    caldavUrl: base + "/",
    carddavUrl: base + "/card-root/",
    ...over,
  });
  const call = (name: string, args: Record<string, unknown> = {}, c = cfg()) => callDavTool(name, args, c) as Promise<any>;

  await test("list_calendars lists event calendars only", async () => {
    const r = await call("list_calendars");
    assert.deepEqual(r.calendars.map((c: any) => c.name), ["Home", "Work & Tour"]);
    assert.equal(r.calendars[0].id, "home");
    assert.equal(r.calendars[0].color, "#FF2968");
    assert.ok(!("href" in r.calendars[0]));
  });

  await test("list_events: range, time zone, recurrence, exceptions, all-day", async () => {
    const r = await call("list_events", { start: "2026-11-16", end: "2026-11-23", timezone: "America/New_York" });
    assert.deepEqual(
      r.events.map((e: any) => [e.title, e.start, e.end]),
      [
        ["Dinner, drinks with Chris", "2026-11-17T18:00:00-05:00", "2026-11-17T20:00:00-05:00"],
        ["Standup (moved)", "2026-11-18T11:00:00-05:00", "2026-11-18T11:15:00-05:00"],
        ["Weekly review", "2026-11-19T09:00:00-05:00", "2026-11-19T10:00:00-05:00"],
        ["Trip to LA", "2026-11-20", "2026-11-21"],
      ],
    );
    const dinner = r.events[0];
    assert.equal(dinner.location, "Cafe, Springfield");
    assert.equal(dinner.notes, "Bring the contract.\nAsk about Aprildates.");
    assert.deepEqual(dinner.organizer, { name: "Chris Example", email: "chris@example.com" });
    assert.deepEqual(dinner.attendees[1], { name: "Doe, Jane", email: "jane@example.com", status: "needs-action" });
    assert.equal(r.events[1].recurring, true);
    assert.equal(r.events[3].all_day, true);
    assert.equal(r.total, 4);
    assert.ok(!JSON.stringify(r).includes("Alarm text"));
  });

  await test("list_events: weekly series keeps local time across the DST change", async () => {
    const r = await call("list_events", { start: "2026-10-26", end: "2026-11-05", timezone: "America/New_York", calendar: "home", query: "standup" });
    assert.deepEqual(r.events.map((e: any) => e.start), [
      "2026-10-26T10:00:00-04:00",
      "2026-10-28T10:00:00-04:00",
      "2026-11-02T10:00:00-05:00",
      "2026-11-04T10:00:00-05:00",
    ]);
  });

  await test("list_events: COUNT ends a series; UTC default; calendar and query filters", async () => {
    const sept = await call("list_events", { start: "2026-09-01", end: "2027-01-01", query: "monthly" });
    assert.deepEqual(sept.events.map((e: any) => e.start), ["2026-09-01T15:00:00Z", "2026-10-01T15:00:00Z", "2026-11-01T15:00:00Z"]);
    const bday = await call("list_events", { start: "2027-03-01", end: "2027-04-01", query: "birthday" });
    assert.deepEqual(bday.events.map((e: any) => e.start), ["2027-03-15"]);
    const work = await call("list_events", { start: "2026-11-16", end: "2026-11-23", calendar: "Work & Tour" });
    assert.deepEqual(work.events.map((e: any) => e.title), ["Weekly review"]);
    await assert.rejects(call("list_events", { calendar: "Nope" }), /No calendar named/);
  });

  await test("list_events: bad input is refused", async () => {
    await assert.rejects(call("list_events", { timezone: "Mars/Olympus" }), /Unknown time zone/);
    await assert.rejects(call("list_events", { start: "2026-01-01", end: "2028-01-01" }), /at most 400 days/);
    await assert.rejects(call("list_events", { start: "2026-02-01", end: "2026-01-01" }), /end must be after start/);
    await assert.rejects(call("list_events", { start: "next week" }), /Could not read the date/);
  });

  await test("search_contacts by name, company, email; labels; photo skipped", async () => {
    const r = await call("search_contacts", { query: "chris" });
    assert.equal(r.total, 1);
    const c = r.contacts[0];
    assert.equal(c.name, "Chris Example");
    assert.equal(c.organization, "alllowercase, LLC, Management");
    assert.deepEqual(c.emails, [{ label: "Work", value: "chris@example.com" }, { label: "home", value: "chris.home@example.com" }]);
    assert.deepEqual(c.phones, [{ label: "cell", value: "(917) 555-0142" }]);
    assert.ok(!JSON.stringify(r).includes("9j/4AAQ"));
    const ops = await call("search_contacts", { query: "ops team" });
    assert.equal(ops.contacts[0].name, "Ops Team");
    const jose = await call("search_contacts", { query: "ÁLVAREZ" });
    assert.equal(jose.total, 1);
    assert.equal(jose.contacts[0].id, "card/jose alvarez.vcf");
  });

  await test("search_contacts by phone in any format, and when the server can't filter", async () => {
    const r = await call("search_contacts", { query: "917-555-0142" });
    assert.deepEqual(r.contacts.map((c: any) => c.name), ["Chris Example"]);
    const intl = await call("search_contacts", { query: "+1 (917) 5550142" });
    assert.deepEqual(intl.contacts.map((c: any) => c.name), ["Chris Example"]);
    filterUnsupported = true;
    try {
      const fb = await call("search_contacts", { query: "jose@" });
      assert.deepEqual(fb.contacts.map((c: any) => c.name), ["José Álvarez"]);
    } finally {
      filterUnsupported = false;
    }
    await assert.rejects(call("search_contacts", { query: "  " }), /Give a query/);
  });

  await test("get_contact returns the full card; ids can't escape the address book", async () => {
    const c = await call("get_contact", { id: "card/chris.vcf" });
    assert.equal(c.birthday, "1990-04-02");
    assert.equal(c.notes, "Met at SXSW.\nLikes oat milk.");
    assert.deepEqual(c.addresses, [{ label: "Home", value: "12 Main St, Springfield, NY 11201, USA" }]);
    assert.equal(c.title, "Partner");
    const j = await call("get_contact", { id: "card/jose alvarez.vcf" });
    assert.equal(j.name, "José Álvarez");
    await assert.rejects(call("get_contact", { id: "card/missing.vcf" }), /No contact with that id/);
    for (const bad of ["../principal/", "/123/principal/", "https://evil.example/x", "card/../../x", "card/x?y"]) {
      await assert.rejects(call("get_contact", { id: bad }), /Give a contact id/);
    }
  });

  await test("wrong password: clear error, password not echoed", async () => {
    await assert.rejects(call("list_calendars", {}, cfg({ user: "other@icloud.com", password: "wrong-secret-xyz" })), (e: Error) => {
      assert.match(e.message, /iCloud rejected the sign-in/);
      assert.ok(!e.message.includes("wrong-secret-xyz"));
      return true;
    });
  });

  await test("credentials are never sent to a host outside icloud.com", async () => {
    principalOverride = "https://evil.example/123/principal/";
    try {
      await assert.rejects(call("list_calendars", {}, cfg({ caldavUrl: base + "/?fresh" })), /Refusing to send credentials to evil.example/);
    } finally {
      principalOverride = "";
    }
  });

  await test("only read methods were ever used", async () => {
    assert.deepEqual([...seenMethods].sort(), ["GET", "PROPFIND", "REPORT"]);
  });

  await test("expandRRule: last Friday monthly, DAILY COUNT, UNTIL", async () => {
    const ev = (rule: string, start = "DTSTART:20260130T170000Z") =>
      parseEvents(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n${start}\r\nRRULE:${rule}\r\nEND:VEVENT\r\nEND:VCALENDAR`, "UTC")[0];
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    const lastFri = expandRRule(ev("FREQ=MONTHLY;BYDAY=-1FR"), Date.UTC(2026, 0, 1), Date.UTC(2026, 4, 1)).map(day);
    assert.deepEqual(lastFri, ["2026-01-30", "2026-02-27", "2026-03-27", "2026-04-24"]);
    const daily = expandRRule(ev("FREQ=DAILY;INTERVAL=2;COUNT=3"), 0, Date.UTC(2027, 0, 1)).map(day);
    assert.deepEqual(daily, ["2026-01-30", "2026-02-01", "2026-02-03"]);
    const until = expandRRule(ev("FREQ=WEEKLY;UNTIL=20260213T170000Z"), 0, Date.UTC(2027, 0, 1)).map(day);
    assert.deepEqual(until, ["2026-01-30", "2026-02-06", "2026-02-13"]);
    const yearlyFeb29 = expandRRule(ev("FREQ=YEARLY", "DTSTART;VALUE=DATE:20240229"), 0, Date.UTC(2029, 0, 1)).map(day);
    assert.deepEqual(yearlyFeb29, ["2024-02-29", "2028-02-29"]);
  });

  console.log(`\n${passed} calendar/contacts tests passed`);
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
