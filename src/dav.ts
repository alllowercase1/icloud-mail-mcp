// Read-only iCloud Calendar (CalDAV) and Contacts (CardDAV) tools.
// Only PROPFIND, REPORT and GET are ever sent: nothing here can create, change or delete
// an event or a contact. The Apple ID and app-specific password are only sent to the
// configured server and to hosts under icloud.com that it redirects to.

export interface DavConfig {
  user: string;
  password: string;
  caldavUrl: string; // e.g. https://caldav.icloud.com/
  carddavUrl: string; // e.g. https://contacts.icloud.com/
  fetch?: typeof fetch;
}

export class DavError extends Error {}

const MAX_RANGE_DAYS = 400;
const MAX_EXPANSIONS = 3000;

// ---------------------------------------------------------------- tools

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const DAV_TOOLS = [
  {
    name: "list_calendars",
    title: "List iCloud calendars",
    description: "List the owner's iCloud calendars (name, id, color). Use a calendar's name or id to narrow list_events.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_events",
    title: "List iCloud Calendar events",
    description:
      "List events from the owner's iCloud calendars that overlap a date range, soonest first, with recurring events expanded into their occurrences. " +
      "Times are given in the requested IANA time zone (default UTC) as ISO 8601 with offset; all-day events give dates only, with an inclusive end date.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "Range start, YYYY-MM-DD (start of that day in `timezone`) or a full ISO 8601 date-time. Default: today." },
        end: { type: "string", description: "Range end (exclusive), same formats. Default: 7 days after start. At most 400 days after start." },
        timezone: { type: "string", description: 'IANA time zone for dates and output, e.g. "America/New_York". Default "UTC".' },
        calendar: { type: "string", description: "Only this calendar (name or id from list_calendars). Default: all calendars." },
        query: { type: "string", description: "Only events whose title, location or notes contain this (case-insensitive)." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Max events to return. Default 100." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_contacts",
    title: "Search iCloud Contacts",
    description:
      "Search the owner's iCloud Contacts by name, nickname, company, email or phone number (case-insensitive, partial matches). " +
      "Returns names, companies, emails and phones; use get_contact with the id for addresses, birthday and notes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for. A phone number can be given in any format." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max contacts to return. Default 25." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_contact",
    title: "Read an iCloud contact",
    description: "Read one contact by id (from search_contacts): names, company, emails, phones, addresses, birthday, websites, related people and notes.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The contact id from search_contacts." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, annotations: { title: t.title, ...ANNOTATIONS } }));

export async function callDavTool(name: string, args: Record<string, unknown>, cfg: DavConfig): Promise<unknown> {
  if (!cfg.user || !cfg.password) {
    throw new DavError("The connector is not configured: set the ICLOUD_USER and ICLOUD_APP_PASSWORD secrets.");
  }
  switch (name) {
    case "list_calendars":
      return { calendars: (await listCalendars(cfg)).map(({ href: _h, ...c }) => c) };
    case "list_events":
      return listEvents(cfg, args);
    case "search_contacts":
      return searchContacts(cfg, args);
    case "get_contact":
      return getContact(cfg, args);
    default:
      throw new DavError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- tiny XML parser

export interface XNode {
  name: string; // local name, namespace prefix removed
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? m;
  });
}
const localName = (n: string) => n.slice(n.indexOf(":") + 1);

export function parseXml(src: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XNode[] = [root];
  const re =
    /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=>\/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
    else if (m[3]) {
      if (m[2] === "/") {
        const want = localName(m[3]);
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].name === want) {
            stack.length = i;
            break;
          }
        }
      } else {
        const attrs: Record<string, string> = {};
        const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let a: RegExpExecArray | null;
        while ((a = ar.exec(m[4] || ""))) attrs[localName(a[1])] = decodeEntities(a[2] ?? a[3] ?? "");
        const node: XNode = { name: localName(m[3]), attrs, children: [], text: "" };
        top.children.push(node);
        if (m[5] !== "/") stack.push(node);
      }
    }
  }
  return root;
}

export function findAll(node: XNode | undefined, name: string, out: XNode[] = []): XNode[] {
  if (!node) return out;
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
export const find = (node: XNode | undefined, name: string) => findAll(node, name)[0];
const textOf = (node: XNode | undefined) => (node ? node.text.trim() : "");

interface DavResponse {
  href: string;
  prop: XNode; // merged props from 2xx propstats
}

function multistatus(xml: string): DavResponse[] {
  const doc = parseXml(xml);
  return findAll(doc, "response").map((r) => {
    const href = textOf(r.children.find((c) => c.name === "href"));
    const prop: XNode = { name: "prop", attrs: {}, children: [], text: "" };
    for (const ps of r.children.filter((c) => c.name === "propstat")) {
      const status = textOf(ps.children.find((c) => c.name === "status"));
      if (status && !/\s2\d\d\b/.test(status)) continue;
      for (const p of ps.children.filter((c) => c.name === "prop")) prop.children.push(...p.children);
    }
    return { href, prop };
  });
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------- HTTP

function basicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "Basic " + btoa(bin);
}

/** Credentials only ever go to the configured server's host or to hosts under icloud.com. */
function hostAllowed(url: URL, roots: string[]): boolean {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return false;
  if (url.hostname === "icloud.com" || url.hostname.endsWith(".icloud.com")) return true;
  return roots.some((r) => new URL(r).host === url.host);
}

async function davRequest(
  cfg: DavConfig,
  method: "PROPFIND" | "REPORT" | "GET",
  target: string,
  body?: string,
  depth?: "0" | "1",
): Promise<{ status: number; text: string; url: string }> {
  const doFetch = cfg.fetch ?? fetch;
  let url = new URL(target);
  for (let hop = 0; hop < 5; hop++) {
    if (!hostAllowed(url, [cfg.caldavUrl, cfg.carddavUrl])) throw new DavError(`Refusing to send credentials to ${url.host}.`);
    const headers: Record<string, string> = { Authorization: basicAuth(cfg.user, cfg.password), "User-Agent": "icloud-mail-mcp/1.1" };
    if (body !== undefined) headers["Content-Type"] = "application/xml; charset=utf-8";
    if (depth) headers["Depth"] = depth;
    const res = await doFetch(url.href, { method, headers, body, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("Location");
      await res.body?.cancel();
      if (!loc) throw new DavError(`iCloud returned a redirect without a location (${res.status}).`);
      url = new URL(loc, url);
      continue;
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new DavError(
        res.status === 401
          ? "iCloud rejected the sign-in for Calendar/Contacts. Check the ICLOUD_USER and ICLOUD_APP_PASSWORD secrets."
          : `iCloud refused the request (403) for ${url.pathname}.`,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      const err = new DavError(`iCloud returned HTTP ${res.status} for ${method} ${url.pathname}.`);
      (err as any).status = res.status;
      throw err;
    }
    return { status: res.status, text, url: url.href };
  }
  throw new DavError("Too many redirects from iCloud.");
}

const propfind = (props: string, ns = "") =>
  `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"${ns}><d:prop>${props}</d:prop></d:propfind>`;

const NS_CAL = ' xmlns:c="urn:ietf:params:xml:ns:caldav"';
const NS_CARD = ' xmlns:card="urn:ietf:params:xml:ns:carddav"';
const NS_APPLE = ' xmlns:a="http://apple.com/ns/ical/"';

const homeCache = new Map<string, string>();

async function homeSet(cfg: DavConfig, kind: "cal" | "card"): Promise<string> {
  const root = kind === "cal" ? cfg.caldavUrl : cfg.carddavUrl;
  const key = `${kind}|${root}|${cfg.user}`;
  const cached = homeCache.get(key);
  if (cached) return cached;
  const r1 = await davRequest(cfg, "PROPFIND", root, propfind("<d:current-user-principal/>"), "0");
  const pHref = textOf(find(find(parseXml(r1.text), "current-user-principal"), "href"));
  if (!pHref) throw new DavError("iCloud did not say where this account's data lives (no principal).");
  const principal = new URL(pHref, r1.url).href;
  const prop = kind === "cal" ? "<c:calendar-home-set/>" : "<card:addressbook-home-set/>";
  const r2 = await davRequest(cfg, "PROPFIND", principal, propfind(prop, kind === "cal" ? NS_CAL : NS_CARD), "0");
  const hHref = textOf(find(find(parseXml(r2.text), kind === "cal" ? "calendar-home-set" : "addressbook-home-set"), "href"));
  if (!hHref) throw new DavError(`iCloud did not return a ${kind === "cal" ? "calendar" : "contacts"} home.`);
  let home = new URL(hHref, r2.url).href;
  if (!home.endsWith("/")) home += "/";
  homeCache.set(key, home);
  return home;
}

const lastSegment = (href: string) => {
  const parts = new URL(href, "https://x/").pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] || "");
};

// ---------------------------------------------------------------- calendars

interface CalendarInfo {
  id: string;
  name: string;
  color?: string;
  description?: string;
  href: string;
}

async function listCalendars(cfg: DavConfig): Promise<CalendarInfo[]> {
  const home = await homeSet(cfg, "cal");
  const r = await davRequest(
    cfg,
    "PROPFIND",
    home,
    propfind("<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><a:calendar-color/><c:calendar-description/>", NS_CAL + NS_APPLE),
    "1",
  );
  const out: CalendarInfo[] = [];
  for (const resp of multistatus(r.text)) {
    const rt = find(resp.prop, "resourcetype");
    if (!rt || !rt.children.some((c) => c.name === "calendar")) continue;
    const comps = findAll(find(resp.prop, "supported-calendar-component-set"), "comp").map((c) => (c.attrs.name || "").toUpperCase());
    if (comps.length && !comps.includes("VEVENT")) continue; // reminders-only lists
    const href = new URL(resp.href, r.url).href;
    const id = lastSegment(href);
    const color = textOf(find(resp.prop, "calendar-color")) || undefined;
    const description = textOf(find(resp.prop, "calendar-description")) || undefined;
    out.push({ id, name: textOf(find(resp.prop, "displayname")) || id, ...(color ? { color } : {}), ...(description ? { description } : {}), href });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- time zones (Intl only; no tz database shipped)

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function wallParts(ms: number, tz: string) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = parseInt(part.value, 10);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

function tzOffsetMs(ms: number, tz: string): number {
  if (tz === "UTC") return 0;
  const w = wallParts(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (tz === "UTC") return guess;
  let t = guess - tzOffsetMs(guess, tz);
  const off2 = tzOffsetMs(t, tz);
  if (guess - off2 !== t) t = guess - off2;
  return t;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function formatInZone(ms: number, tz: string): string {
  const w = wallParts(ms, tz);
  const off = Math.round(tzOffsetMs(ms, tz) / 60000);
  const sign = off < 0 ? "-" : "+";
  const offStr = off === 0 && tz === "UTC" ? "Z" : `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${offStr}`;
}

// ---- calendar arithmetic on civil dates

function daysFromCivil(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function civilFromDays(n: number) {
  const dt = new Date(n * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const weekdayOf = (days: number) => ((days % 7) + 7 + 4) % 7; // 1970-01-01 was a Thursday

// ---- iCalendar / vCard line handling

interface CLine {
  group?: string;
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n[ \t]|\n[ \t]/g, "").split(/\r?\n/).filter((l) => l.length);
}

function parseContentLine(line: string): CLine | null {
  // NAME;PARAM=a;PARAM="b:c":value   (colon inside quotes does not end the name part)
  let i = 0;
  let inQ = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (ch === ":" && !inQ) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const segs: string[] = [];
  let cur = "";
  inQ = false;
  for (const ch of head) {
    if (ch === '"') inQ = !inQ;
    if (ch === ";" && !inQ) {
      segs.push(cur);
      cur = "";
    } else cur += ch;
  }
  segs.push(cur);
  let name = segs.shift()!.toUpperCase();
  let group: string | undefined;
  const dot = name.indexOf(".");
  if (dot > 0) {
    group = name.slice(0, dot);
    name = name.slice(dot + 1);
  }
  const params: Record<string, string> = {};
  for (const s of segs) {
    const eq = s.indexOf("=");
    const k = (eq < 0 ? "TYPE" : s.slice(0, eq)).toUpperCase();
    const v = (eq < 0 ? s : s.slice(eq + 1)).replace(/"/g, "");
    params[k] = params[k] ? `${params[k]},${v}` : v;
  }
  return { group, name, params, value };
}

const unescapeText = (v: string) => v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));

/** Split a structured value on unescaped `sep`, then unescape each part. */
function splitStructured(v: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "\\" && i + 1 < v.length) {
      cur += v[i] + v[i + 1];
      i++;
    } else if (v[i] === sep) {
      out.push(unescapeText(cur));
      cur = "";
    } else cur += v[i];
  }
  out.push(unescapeText(cur));
  return out;
}

// ---- events

interface ICalTime {
  ms: number;
  allDay: boolean;
  wall?: { y: number; m: number; d: number; h: number; mi: number; s: number };
  tz: string; // zone the wall time is in ("UTC" for Z values and all-day)
}

function parseICalTime(line: CLine, defaultTz: string): ICalTime | null {
  const v = line.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (m[4] === undefined || line.params.VALUE === "DATE") {
    return { ms: Date.UTC(y, mo - 1, d), allDay: true, wall: { y, m: mo, d, h: 0, mi: 0, s: 0 }, tz: "UTC" };
  }
  const [h, mi, s] = [+m[4], +m[5], +(m[6] || 0)];
  let tz = m[7] ? "UTC" : line.params.TZID || defaultTz;
  if (!validTimeZone(tz)) tz = defaultTz;
  return { ms: zonedToUtc(y, mo, d, h, mi, s, tz), allDay: false, wall: { y, m: mo, d, h, mi, s }, tz };
}

function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = (((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 + +(m[4] || 0)) * 60 + +(m[5] || 0)) * 60000 + +(m[6] || 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}

interface VEvent {
  uid: string;
  summary: string;
  start: ICalTime;
  durationMs: number;
  location?: string;
  description?: string;
  url?: string;
  status?: string;
  organizer?: { name?: string; email?: string };
  attendees: { name?: string; email?: string; status?: string }[];
  rrule?: Record<string, string>;
  exdates: number[];
  rdates: ICalTime[];
  recurrenceId?: number;
}

function personFrom(line: CLine) {
  const email = line.value.replace(/^mailto:/i, "").trim() || undefined;
  const name = line.params.CN || undefined;
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}

export function parseEvents(ics: string, defaultTz: string): VEvent[] {
  const events: VEvent[] = [];
  const stack: string[] = [];
  let cur: CLine[] | null = null;
  for (const raw of unfold(ics)) {
    const line = parseContentLine(raw);
    if (!line) continue;
    if (line.name === "BEGIN") {
      stack.push(line.value.toUpperCase());
      if (line.value.toUpperCase() === "VEVENT") cur = [];
      continue;
    }
    if (line.name === "END") {
      const ended = stack.pop();
      if (ended === "VEVENT" && cur) {
        const ev = buildEvent(cur, defaultTz);
        if (ev) events.push(ev);
        cur = null;
      }
      continue;
    }
    if (cur && stack[stack.length - 1] === "VEVENT") cur.push(line);
  }
  return events;
}

function buildEvent(lines: CLine[], defaultTz: string): VEvent | null {
  const get = (n: string) => lines.find((l) => l.name === n);
  const dtstart = get("DTSTART");
  const start = dtstart && parseICalTime(dtstart, defaultTz);
  if (!start) return null;
  let durationMs = start.allDay ? 86400000 : 0;
  const dtend = get("DTEND");
  const dur = get("DURATION");
  const end = dtend && parseICalTime(dtend, defaultTz);
  if (end) durationMs = Math.max(0, end.ms - start.ms);
  else if (dur) durationMs = Math.max(0, parseDuration(dur.value) ?? durationMs);
  const rr = get("RRULE");
  let rrule: Record<string, string> | undefined;
  if (rr) {
    rrule = {};
    for (const part of rr.value.split(";")) {
      const [k, v] = part.split("=");
      if (k && v) rrule[k.toUpperCase()] = v.toUpperCase();
    }
  }
  const exdates: number[] = [];
  const rdates: ICalTime[] = [];
  for (const l of lines) {
    if (l.name !== "EXDATE" && l.name !== "RDATE") continue;
    for (const v of l.value.split(",")) {
      const t = parseICalTime({ ...l, value: v }, defaultTz);
      if (t) (l.name === "EXDATE" ? exdates.push(t.ms) : rdates.push(t));
    }
  }
  const rid = get("RECURRENCE-ID");
  const ridT = rid && parseICalTime(rid, defaultTz);
  const text = (n: string) => {
    const l = get(n);
    const v = l ? unescapeText(l.value).trim() : "";
    return v || undefined;
  };
  const org = get("ORGANIZER");
  return {
    uid: get("UID")?.value.trim() || "",
    summary: text("SUMMARY") || "(no title)",
    start,
    durationMs,
    location: text("LOCATION"),
    description: text("DESCRIPTION"),
    url: text("URL"),
    status: text("STATUS")?.toLowerCase(),
    organizer: org ? personFrom(org) : undefined,
    attendees: lines
      .filter((l) => l.name === "ATTENDEE")
      .map((l) => ({ ...personFrom(l), ...(l.params.PARTSTAT ? { status: l.params.PARTSTAT.toLowerCase() } : {}) })),
    rrule,
    exdates,
    rdates,
    recurrenceId: ridT ? ridT.ms : undefined,
  };
}

/** Start times (UTC ms) of a recurring event's occurrences that start before `untilMs`. */
export function expandRRule(ev: VEvent, windowStartMs: number, windowEndMs: number): number[] {
  const r = ev.rrule!;
  const freq = r.FREQ;
  const interval = Math.max(1, parseInt(r.INTERVAL || "1", 10) || 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  let untilMs = Infinity;
  if (r.UNTIL) {
    const u = parseICalTime({ name: "UNTIL", params: {}, value: r.UNTIL }, ev.start.tz);
    if (u) untilMs = u.allDay && !ev.start.allDay ? u.ms + 86400000 - 1 : u.ms;
  }
  const w = ev.start.wall!;
  const tz = ev.start.tz;
  const toMs = (days: number) => {
    const c = civilFromDays(days);
    return ev.start.allDay ? Date.UTC(c.y, c.m - 1, c.d) : zonedToUtc(c.y, c.m, c.d, w.h, w.mi, w.s, tz);
  };
  const startDays = daysFromCivil(w.y, w.m, w.d);
  const byDay = (r.BYDAY || "")
    .split(",")
    .filter(Boolean)
    .map((s) => {
      const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(s);
      return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS.indexOf(m[2]) } : null;
    })
    .filter((x): x is { n: number; wd: number } => !!x && x.wd >= 0);
  const byMonthDay = (r.BYMONTHDAY || "").split(",").filter(Boolean).map((x) => parseInt(x, 10)).filter((x) => x !== 0 && Math.abs(x) <= 31);
  const byMonth = (r.BYMONTH || "").split(",").filter(Boolean).map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= 12);

  // days in one month matching BYDAY (with ordinals) / BYMONTHDAY, or the start's day of month
  const daysInMonthMatching = (y: number, m: number): number[] => {
    const dim = daysInMonth(y, m);
    const first = daysFromCivil(y, m, 1);
    let days: number[] = [];
    if (byMonthDay.length) {
      days = byMonthDay.map((md) => (md > 0 ? md : dim + md + 1)).filter((md) => md >= 1 && md <= dim).map((md) => first + md - 1);
    }
    if (byDay.length) {
      const matches: number[] = [];
      for (const { n, wd } of byDay) {
        const all: number[] = [];
        for (let d = 0; d < dim; d++) if (weekdayOf(first + d) === wd) all.push(first + d);
        if (n === 0) matches.push(...all);
        else {
          const pick = n > 0 ? all[n - 1] : all[all.length + n];
          if (pick !== undefined) matches.push(pick);
        }
      }
      days = byMonthDay.length ? days.filter((d) => matches.includes(d)) : matches;
    }
    if (!byMonthDay.length && !byDay.length) {
      if (w.d <= dim) days = [first + w.d - 1];
    }
    return [...new Set(days)].sort((a, b) => a - b);
  };

  const out: number[] = [];
  let produced = 0;
  const lastDay = Math.floor(Math.min(windowEndMs, untilMs) / 86400000) + 2;
  const earlyDay = Math.floor((windowStartMs - ev.durationMs) / 86400000) - 2; // surely before the window
  const untilDay = Math.floor(untilMs / 86400000) - 2;
  const emit = (days: number[]): boolean => {
    for (const d of days) {
      if (d < startDays) continue;
      if (d < earlyDay && d < untilDay) {
        // cheap path for occurrences long before the window: only count them
        if (produced >= count) return false;
        produced++;
        continue;
      }
      const ms = toMs(d);
      if (ms > untilMs || produced >= count || d > lastDay) return false;
      produced++;
      if (ms + ev.durationMs >= windowStartMs && ms < windowEndMs) out.push(ms);
      if (out.length >= MAX_EXPANSIONS) return false;
    }
    return true;
  };

  for (let k = 0; k < 100000; k++) {
    let days: number[];
    if (freq === "DAILY") {
      days = [startDays + k * interval];
      if (byMonth.length && !byMonth.includes(civilFromDays(days[0]).m)) days = [];
    } else if (freq === "WEEKLY") {
      const wkst = WEEKDAYS.indexOf(r.WKST || "MO");
      const weekStart = startDays - ((weekdayOf(startDays) - (wkst < 0 ? 1 : wkst) + 7) % 7) + k * 7 * interval;
      const wds = byDay.length ? byDay.map((b) => b.wd) : [weekdayOf(startDays)];
      days = [...new Set(wds.map((wd) => weekStart + ((wd - weekdayOf(weekStart) + 7) % 7)))].sort((a, b) => a - b);
    } else if (freq === "MONTHLY") {
      const total = w.y * 12 + (w.m - 1) + k * interval;
      const y = Math.floor(total / 12);
      const m = (total % 12) + 1;
      days = byMonth.length && !byMonth.includes(m) ? [] : daysInMonthMatching(y, m);
    } else if (freq === "YEARLY") {
      const y = w.y + k * interval;
      const months = byMonth.length ? byMonth : [w.m];
      days = [];
      for (const m of months) {
        if (!byMonth.length && !byDay.length && !byMonthDay.length) {
          if (w.d <= daysInMonth(y, m)) days.push(daysFromCivil(y, m, w.d));
        } else days.push(...daysInMonthMatching(y, m));
      }
      days.sort((a, b) => a - b);
    } else {
      return [ev.start.ms].filter((ms) => ms + ev.durationMs >= windowStartMs && ms < windowEndMs);
    }
    if (days.length && days[0] > lastDay) break;
    if (!emit(days)) break;
  }
  return out;
}

function parseRangeBound(v: unknown, tz: string, fallback: number): number {
  if (typeof v !== "string" || !v.trim()) return fallback;
  const s = v.trim();
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) return zonedToUtc(+d[1], +d[2], +d[3], 0, 0, 0, tz);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new DavError(`Could not read the date "${s}". Use YYYY-MM-DD or ISO 8601.`);
  // a date-time without an offset is read in the requested zone
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
    if (m) return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), tz);
  }
  return t;
}

const utcStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

async function listEvents(cfg: DavConfig, args: Record<string, unknown>) {
  const tz = typeof args.timezone === "string" && args.timezone.trim() ? args.timezone.trim() : "UTC";
  if (!validTimeZone(tz)) throw new DavError(`Unknown time zone "${tz}". Use an IANA name like America/New_York.`);
  const now = Date.now();
  const today = wallParts(now, tz);
  const startMs = parseRangeBound(args.start, tz, zonedToUtc(today.y, today.mo, today.d, 0, 0, 0, tz));
  const endMs = parseRangeBound(args.end, tz, startMs + 7 * 86400000);
  if (endMs <= startMs) throw new DavError("end must be after start.");
  if (endMs - startMs > MAX_RANGE_DAYS * 86400000) throw new DavError(`The range can be at most ${MAX_RANGE_DAYS} days.`);
  const limit = Math.min(500, Math.max(1, Number(args.limit) || 100));
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";

  let calendars = await listCalendars(cfg);
  const want = typeof args.calendar === "string" ? args.calendar.trim().toLowerCase() : "";
  if (want) {
    calendars = calendars.filter((c) => c.id.toLowerCase() === want || c.name.toLowerCase() === want);
    if (!calendars.length) throw new DavError(`No calendar named "${args.calendar}". Use list_calendars to see the names.`);
  }

  const s = utcStamp(startMs);
  const e = utcStamp(endMs);
  const body =
    `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:"${NS_CAL}>` +
    `<d:prop><d:getetag/><c:calendar-data><c:expand start="${s}" end="${e}"/></c:calendar-data></d:prop>` +
    `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${s}" end="${e}"/></c:comp-filter></c:comp-filter></c:filter>` +
    `</c:calendar-query>`;

  // All-day events are dates, not instants: compare them using midnight in the requested zone.
  const instant = (ev: VEvent, ms: number) => {
    if (!ev.start.allDay) return ms;
    const d = new Date(ms);
    return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, 0, tz);
  };
  type Occ = { cal: CalendarInfo; ev: VEvent; ms: number; at: number; recurring: boolean };
  const occs: Occ[] = [];
  const failed: string[] = [];
  const consider = (cal: CalendarInfo, ev: VEvent, ms: number, recurring: boolean) => {
    const at = instant(ev, ms);
    const endAt = ev.start.allDay ? instant(ev, ms + ev.durationMs) : ms + ev.durationMs;
    if (at < endMs && (endAt > startMs || (ev.durationMs === 0 && at >= startMs))) occs.push({ cal, ev, ms, at, recurring });
  };
  await Promise.all(
    calendars.map(async (cal) => {
      let res;
      try {
        res = await davRequest(cfg, "REPORT", cal.href, body, "1");
      } catch (err) {
        if (err instanceof DavError && /rejected the sign-in/.test(err.message)) throw err;
        failed.push(cal.name);
        return;
      }
      for (const resp of multistatus(res.text)) {
        const data = find(resp.prop, "calendar-data");
        if (!data || !data.text.trim()) continue;
        const events = parseEvents(data.text, tz);
        const overridden = new Set(events.filter((x) => x.recurrenceId !== undefined).map((x) => `${x.uid}|${x.recurrenceId}`));
        for (const ev of events) {
          if (ev.rrule && ev.recurrenceId === undefined) {
            // the server did not expand this series: do it here (window padded for all-day dates)
            const starts = new Set([...expandRRule(ev, startMs - 2 * 86400000, endMs + 2 * 86400000), ...ev.rdates.map((r) => r.ms)]);
            for (const ms of starts) {
              if (ev.exdates.includes(ms) || overridden.has(`${ev.uid}|${ms}`)) continue;
              consider(cal, ev, ms, true);
            }
          } else {
            consider(cal, ev, ev.start.ms, !!ev.rrule || ev.recurrenceId !== undefined);
          }
        }
      }
    }),
  );

  const seen = new Set<string>();
  let filtered = occs
    .filter((o) => {
      const k = `${o.cal.id}|${o.ev.uid}|${o.ms}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.at - b.at || a.ev.summary.localeCompare(b.ev.summary));
  if (query) {
    filtered = filtered.filter((o) => [o.ev.summary, o.ev.location, o.ev.description].some((t) => t && t.toLowerCase().includes(query)));
  }
  const total = filtered.length;
  const events = filtered.slice(0, limit).map(({ cal, ev, ms, recurring }) => {
    const allDay = ev.start.allDay;
    const endMs2 = ms + ev.durationMs;
    const dateOnly = (x: number) => new Date(x).toISOString().slice(0, 10);
    return {
      title: ev.summary,
      calendar: cal.name,
      ...(allDay
        ? { all_day: true, start: dateOnly(ms), end: dateOnly(Math.max(ms, endMs2 - 86400000)) }
        : { start: formatInZone(ms, tz), end: formatInZone(endMs2, tz) }),
      ...(ev.location ? { location: ev.location } : {}),
      ...(ev.description ? { notes: ev.description.length > 1500 ? ev.description.slice(0, 1500) + "…" : ev.description } : {}),
      ...(ev.url ? { url: ev.url } : {}),
      ...(ev.status && ev.status !== "confirmed" ? { status: ev.status } : {}),
      ...(recurring ? { recurring: true } : {}),
      ...(ev.organizer && (ev.organizer.name || ev.organizer.email) ? { organizer: ev.organizer } : {}),
      ...(ev.attendees.length ? { attendees: ev.attendees.slice(0, 25), ...(ev.attendees.length > 25 ? { more_attendees: ev.attendees.length - 25 } : {}) } : {}),
    };
  });
  return {
    timezone: tz,
    range: { start: formatInZone(startMs, tz), end: formatInZone(endMs, tz) },
    total,
    returned: events.length,
    ...(failed.length ? { calendars_not_read: failed } : {}),
    events,
  };
}

// ---------------------------------------------------------------- contacts

interface Contact {
  id: string;
  name: string;
  nickname?: string;
  organization?: string;
  title?: string;
  emails: { label?: string; value: string }[];
  phones: { label?: string; value: string }[];
  addresses: { label?: string; value: string }[];
  urls: { label?: string; value: string }[];
  related: { label?: string; value: string }[];
  birthday?: string;
  notes?: string;
}

function cleanLabel(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /^_\$!<(.*)>!\$_$/.exec(s);
  const v = (m ? m[1] : s).trim();
  return v || undefined;
}

function typeLabel(params: Record<string, string>): string | undefined {
  const types = (params.TYPE || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t && !["internet", "pref", "voice", "x400"].includes(t));
  return types[0];
}

export function parseVCard(text: string, id: string): Contact | null {
  const lines = unfold(text)
    .map(parseContentLine)
    .filter((l): l is CLine => !!l && l.name !== "PHOTO" && l.name !== "LOGO" && l.name !== "SOUND" && l.name !== "KEY");
  if (!lines.some((l) => l.name === "BEGIN")) return null;
  const labels = new Map<string, string>();
  for (const l of lines) if (l.name === "X-ABLABEL" && l.group) labels.set(l.group, unescapeText(l.value));
  const label = (l: CLine) => cleanLabel(l.group ? labels.get(l.group) : undefined) ?? typeLabel(l.params);
  const one = (n: string) => {
    const l = lines.find((x) => x.name === n);
    const v = l ? unescapeText(l.value).trim() : "";
    return v || undefined;
  };
  const many = (n: string, fmt: (l: CLine) => string = (l) => unescapeText(l.value).trim()) =>
    lines
      .filter((l) => l.name === n)
      .map((l) => ({ label: label(l), value: fmt(l) }))
      .filter((x) => x.value)
      .map((x) => (x.label ? x : { value: x.value }));
  let name = one("FN") || "";
  if (!name) {
    const n = lines.find((l) => l.name === "N");
    if (n) {
      const [family, given, additional, prefix, suffix] = splitStructured(n.value, ";");
      name = [prefix, given, additional, family, suffix].filter(Boolean).join(" ").trim();
    }
  }
  const org = lines.find((l) => l.name === "ORG");
  const organization = org ? splitStructured(org.value, ";").filter(Boolean).join(", ") || undefined : undefined;
  if (!name) name = organization || "(no name)";
  const bday = one("BDAY");
  return {
    id,
    name,
    ...(one("NICKNAME") ? { nickname: one("NICKNAME") } : {}),
    ...(organization ? { organization } : {}),
    ...(one("TITLE") ? { title: one("TITLE") } : {}),
    emails: many("EMAIL"),
    phones: many("TEL", (l) => l.value.replace(/^tel:/i, "").trim()),
    addresses: many("ADR", (l) => {
      const [pobox, ext, street, city, region, code, country] = splitStructured(l.value, ";");
      const cityLine = [city, [region, code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      return [pobox, ext, street, cityLine, country].map((x) => (x || "").replace(/\n/g, ", ").trim()).filter(Boolean).join(", ");
    }),
    urls: many("URL"),
    related: [...many("X-ABRELATEDNAMES"), ...many("RELATED")],
    ...(bday ? { birthday: bday.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3").replace(/^1604-/, "--") } : {}),
    ...(one("NOTE") ? { notes: one("NOTE") } : {}),
  };
}

async function addressBooks(cfg: DavConfig): Promise<{ home: string; books: string[] }> {
  const home = await homeSet(cfg, "card");
  const r = await davRequest(cfg, "PROPFIND", home, propfind("<d:resourcetype/><d:displayname/>", NS_CARD), "1");
  const books = multistatus(r.text)
    .filter((resp) => find(resp.prop, "resourcetype")?.children.some((c) => c.name === "addressbook"))
    .map((resp) => new URL(resp.href, r.url).href);
  return { home, books };
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

function contactMatches(c: Contact, q: string, qDigits: string): boolean {
  const hay = [c.name, c.nickname, c.organization, c.title, ...c.emails.map((e) => e.value)].filter(Boolean).join("\n").toLowerCase();
  if (hay.includes(q)) return true;
  if (qDigits.length >= 4) {
    const tail = qDigits.length > 10 ? qDigits.slice(-10) : qDigits;
    return c.phones.some((p) => digitsOf(p.value).includes(tail));
  }
  return false;
}

async function searchContacts(cfg: DavConfig, args: Record<string, unknown>) {
  const raw = typeof args.query === "string" ? args.query.trim() : "";
  if (!raw) throw new DavError("Give a query: a name, company, email or phone number.");
  const q = raw.toLowerCase();
  const qDigits = digitsOf(raw);
  const looksLikePhone = qDigits.length >= 4 && qDigits.length >= raw.replace(/[\s()+.\-]/g, "").length;
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
  const { home, books } = await addressBooks(cfg);

  const match = (prop: string) =>
    `<card:prop-filter name="${prop}"><card:text-match collation="i;unicode-casemap" match-type="contains">${xmlEscape(raw)}</card:text-match></card:prop-filter>`;
  const filtered =
    `<?xml version="1.0" encoding="utf-8"?><card:addressbook-query xmlns:d="DAV:"${NS_CARD}>` +
    `<d:prop><d:getetag/><card:address-data/></d:prop>` +
    `<card:filter test="anyof">${["FN", "N", "NICKNAME", "ORG", "EMAIL"].map(match).join("")}</card:filter></card:addressbook-query>`;
  const everything =
    `<?xml version="1.0" encoding="utf-8"?><card:addressbook-query xmlns:d="DAV:"${NS_CARD}>` +
    `<d:prop><d:getetag/><card:address-data/></d:prop></card:addressbook-query>`;

  const found: Contact[] = [];
  for (const book of books) {
    let text: string;
    if (looksLikePhone) {
      text = (await davRequest(cfg, "REPORT", book, everything, "1")).text;
    } else {
      try {
        text = (await davRequest(cfg, "REPORT", book, filtered, "1")).text;
      } catch (err) {
        if (!(err instanceof DavError) || /rejected the sign-in/.test(err.message)) throw err;
        text = (await davRequest(cfg, "REPORT", book, everything, "1")).text; // server can't filter: do it here
      }
    }
    for (const resp of multistatus(text)) {
      const data = find(resp.prop, "address-data");
      if (!data) continue;
      const href = new URL(resp.href, book).href;
      if (!href.startsWith(home)) continue;
      const c = parseVCard(data.text, decodeURIComponent(href.slice(home.length)));
      if (c && contactMatches(c, q, qDigits)) found.push(c);
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return {
    query: raw,
    total: found.length,
    returned: Math.min(limit, found.length),
    contacts: found.slice(0, limit).map((c) => ({
      id: c.id,
      name: c.name,
      ...(c.organization ? { organization: c.organization } : {}),
      ...(c.title ? { title: c.title } : {}),
      ...(c.emails.length ? { emails: c.emails } : {}),
      ...(c.phones.length ? { phones: c.phones } : {}),
    })),
  };
}

async function getContact(cfg: DavConfig, args: Record<string, unknown>) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id || id.includes("..") || id.startsWith("/") || /^[a-z]+:/i.test(id) || id.includes("?") || id.includes("#")) {
    throw new DavError("Give a contact id from search_contacts.");
  }
  const home = await homeSet(cfg, "card");
  const url = new URL(id.split("/").map(encodeURIComponent).join("/"), home);
  if (!url.href.startsWith(home)) throw new DavError("That id is not a contact.");
  let res;
  try {
    res = await davRequest(cfg, "GET", url.href);
  } catch (err) {
    if ((err as any)?.status === 404) throw new DavError("No contact with that id.");
    throw err;
  }
  const c = parseVCard(res.text, id);
  if (!c) throw new DavError("That id is not a contact.");
  const strip = <T extends Record<string, unknown>>(o: T) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => !(Array.isArray(v) && v.length === 0))) as Partial<T>;
  return strip(c as unknown as Record<string, unknown>);
}
