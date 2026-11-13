// The connector's tools. Everything here is read-only.
import { astring, bytesToString, ImapClient, ImapError, type ImapValue, type Transport } from "./imap";
import { decodeCharset, decodeTransfer, decodeWords, htmlToText, listAttachments, parseBodyStructure, pickTextPart } from "./mime";

export interface MailConfig {
  user: string;
  password: string;
  openTransport: () => Promise<Transport>;
}

const MAX_BODY_FETCH_BYTES = 400_000; // only the first ~400 KB of a body part is downloaded

export const TOOLS = [
  {
    name: "list_mailboxes",
    title: "List iCloud mailboxes",
    description:
      "List the mailboxes (folders) in the owner's iCloud Mail, such as INBOX, Sent Messages, Archive, Junk and any custom folders. Optionally include message and unread counts.",
    inputSchema: {
      type: "object",
      properties: {
        include_counts: { type: "boolean", description: "Also return total and unread counts per mailbox (slower). Default false." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_messages",
    title: "Search iCloud Mail",
    description:
      "Search one iCloud mailbox and return the newest matching messages (headers only: date, from, to, subject, unread flag, uid). With no filters it returns the newest messages. Use get_message with the uid to read one. iCloud's sent folder is usually named \"Sent Messages\". All filters are combined with AND and are case-insensitive substring matches.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: { type: "string", description: 'Mailbox to search. Default "INBOX".' },
        from: { type: "string", description: "Sender name or address contains this." },
        to: { type: "string", description: "Recipient (To) contains this." },
        subject: { type: "string", description: "Subject contains this." },
        text: { type: "string", description: "Headers or body contain this." },
        since: { type: "string", description: "Only messages received on or after this date, YYYY-MM-DD." },
        before: { type: "string", description: "Only messages received before this date, YYYY-MM-DD." },
        unread_only: { type: "boolean", description: "Only unread messages." },
        flagged_only: { type: "boolean", description: "Only flagged messages." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max messages to return, newest first. Default 20." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_message",
    title: "Read an iCloud email",
    description:
      "Read one message by mailbox and uid (from search_messages): full headers, the plain-text body (HTML is converted to text), and attachment names. Does not mark the message as read.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: { type: "string", description: 'Mailbox the message is in. Default "INBOX".' },
        uid: { type: "integer", minimum: 1, description: "The message uid from search_messages." },
        max_chars: { type: "integer", minimum: 500, maximum: 100000, description: "Truncate the body to this many characters. Default 20000." },
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));

async function withClient<T>(cfg: MailConfig, fn: (c: ImapClient) => Promise<T>): Promise<T> {
  if (!cfg.user || !cfg.password) {
    throw new ImapError("The connector is not configured: set the ICLOUD_USER and ICLOUD_APP_PASSWORD secrets.");
  }
  const transport = await cfg.openTransport();
  const client = new ImapClient(transport);
  try {
    await client.greeting();
    await client.login(cfg.user, cfg.password);
    return await fn(client);
  } finally {
    await client.logout();
  }
}

export async function callTool(name: string, args: Record<string, unknown>, cfg: MailConfig): Promise<unknown> {
  switch (name) {
    case "list_mailboxes":
      return listMailboxes(cfg, !!args.include_counts);
    case "search_messages":
      return searchMessages(cfg, args);
    case "get_message":
      return getMessage(cfg, args);
    default:
      throw new ImapError(`Unknown tool: ${name}`);
  }
}

async function listMailboxes(cfg: MailConfig, counts: boolean) {
  return withClient(cfg, async (c) => {
    const boxes = await c.list();
    const out = [];
    for (const b of boxes) {
      const noSelect = b.flags.some((f) => /^\\(noselect|nonexistent)$/i.test(f));
      const special = b.flags.find((f) => /^\\(sent|drafts|trash|junk|archive|all|flagged)$/i.test(f));
      const entry: Record<string, unknown> = { name: b.name };
      if (special) entry.role = special.slice(1).toLowerCase();
      if (noSelect) entry.selectable = false;
      if (counts && !noSelect) {
        try {
          const s = await c.status(b.name);
          entry.messages = s.messages;
          entry.unread = s.unseen;
        } catch {
          /* some folders refuse STATUS; skip counts */
        }
      }
      out.push(entry);
    }
    return { mailboxes: out };
  });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function imapDate(s: string, field: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new ImapError(`${field} must be a date like 2026-11-13`);
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) throw new ImapError(`${field} has an invalid month`);
  return `${parseInt(m[3], 10)}-${MONTHS[month - 1]}-${m[1]}`;
}

async function searchMessages(cfg: MailConfig, args: Record<string, unknown>) {
  const mailbox = str(args.mailbox) || "INBOX";
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  const criteria: (string | Uint8Array)[] = [];
  let needsUtf8 = false;
  const addText = (key: string, value: string | undefined) => {
    if (!value) return;
    const a = astring(value);
    if (a instanceof Uint8Array) needsUtf8 = true;
    criteria.push(key + " ", a, " ");
  };
  addText("FROM", str(args.from));
  addText("TO", str(args.to));
  addText("SUBJECT", str(args.subject));
  addText("TEXT", str(args.text));
  if (str(args.since)) criteria.push("SINCE " + imapDate(str(args.since)!, "since") + " ");
  if (str(args.before)) criteria.push("BEFORE " + imapDate(str(args.before)!, "before") + " ");
  if (args.unread_only) criteria.push("UNSEEN ");
  if (args.flagged_only) criteria.push("FLAGGED ");
  if (!criteria.length) criteria.push("ALL");
  // drop the trailing space
  const last = criteria[criteria.length - 1];
  if (typeof last === "string") criteria[criteria.length - 1] = last.trimEnd();

  return withClient(cfg, async (c) => {
    const box = await c.examine(mailbox);
    if (box.exists === 0) return { mailbox, total_matches: 0, messages: [] };
    const uids = (await c.uidSearch(criteria, needsUtf8)).sort((a, b) => b - a);
    const picked = uids.slice(0, limit);
    if (!picked.length) return { mailbox, total_matches: 0, messages: [] };
    const rows = await c.uidFetch(picked.join(","), "(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE)");
    const messages = rows
      .map((r) => summarize(r))
      .sort((a, b) => (b.uid as number) - (a.uid as number));
    return {
      mailbox,
      total_matches: uids.length,
      returned: messages.length,
      note: uids.length > messages.length ? "Newest matches shown. Narrow the search or raise limit for more." : undefined,
      messages,
    };
  });
}

function addrList(v: ImapValue | undefined): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const a of v) {
    if (!Array.isArray(a)) continue;
    const name = decodeWords(bytesToString(a[0]));
    const mailbox = bytesToString(a[2]);
    const host = bytesToString(a[3]);
    if (!host) continue; // group start/end markers
    const email = mailbox ? `${mailbox}@${host}` : host;
    out.push(name ? `${name} <${email}>` : email);
  }
  return out;
}

function envelope(v: ImapValue | undefined) {
  const e = Array.isArray(v) ? v : [];
  return {
    date: bytesToString(e[0]) || undefined,
    subject: decodeWords(bytesToString(e[1])),
    from: addrList(e[2]),
    reply_to: addrList(e[4]),
    to: addrList(e[5]),
    cc: addrList(e[6]),
    in_reply_to: bytesToString(e[8]) || undefined,
    message_id: bytesToString(e[9]) || undefined,
  };
}

function flags(v: ImapValue | undefined): string[] {
  return Array.isArray(v) ? v.map((f) => bytesToString(f)) : [];
}

function internalDate(v: ImapValue | undefined): string | undefined {
  const s = bytesToString(v);
  const d = new Date(s.replace(/^(\d{1,2})-(\w{3})-(\d{4})/, "$2 $1 $3"));
  return isNaN(d.getTime()) ? s || undefined : d.toISOString();
}

function summarize(r: Map<string, ImapValue>) {
  const env = envelope(r.get("ENVELOPE"));
  const f = flags(r.get("FLAGS"));
  return {
    uid: parseInt(bytesToString(r.get("UID")), 10),
    received: internalDate(r.get("INTERNALDATE")),
    from: env.from.join(", "),
    to: env.to.join(", "),
    subject: env.subject,
    unread: !f.some((x) => /^\\seen$/i.test(x)),
    flagged: f.some((x) => /^\\flagged$/i.test(x)) || undefined,
    size_bytes: parseInt(bytesToString(r.get("RFC822.SIZE")), 10) || undefined,
  };
}

async function getMessage(cfg: MailConfig, args: Record<string, unknown>) {
  const mailbox = str(args.mailbox) || "INBOX";
  const uid = Number(args.uid);
  if (!Number.isInteger(uid) || uid < 1) throw new ImapError("uid must be a positive whole number");
  const maxChars = Math.min(Math.max(Number(args.max_chars) || 20000, 500), 100000);

  return withClient(cfg, async (c) => {
    await c.examine(mailbox);
    const rows = await c.uidFetch(String(uid), "(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODYSTRUCTURE)");
    const row = rows.find((r) => parseInt(bytesToString(r.get("UID")), 10) === uid);
    if (!row) throw new ImapError(`No message with uid ${uid} in ${mailbox}. It may have been moved or deleted.`);
    const env = envelope(row.get("ENVELOPE"));
    const f = flags(row.get("FLAGS"));
    const root = parseBodyStructure(row.get("BODYSTRUCTURE"));
    const textPart = root ? pickTextPart(root) : null;
    const attachments = root ? listAttachments(root, textPart) : [];

    let body = "";
    let truncated = false;
    if (textPart) {
      const key = `BODY[${textPart.section}]`;
      const parts = await c.uidFetch(String(uid), `(UID BODY.PEEK[${textPart.section}]<0.${MAX_BODY_FETCH_BYTES}>)`);
      let raw: ImapValue | undefined;
      for (const [k, v] of parts[0] ?? []) if (k.startsWith(key)) raw = v;
      const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(bytesToString(raw));
      if (bytes.length >= MAX_BODY_FETCH_BYTES) truncated = true;
      const decoded = decodeCharset(decodeTransfer(bytes, textPart.encoding), textPart.params["charset"]);
      body = textPart.subtype === "html" ? htmlToText(decoded) : decoded.replace(/\r\n/g, "\n").trim();
    } else {
      body = "(This message has no readable text part.)";
    }
    if (body.length > maxChars) {
      body = body.slice(0, maxChars);
      truncated = true;
    }
    return {
      mailbox,
      uid,
      received: internalDate(row.get("INTERNALDATE")),
      date_header: env.date,
      subject: env.subject,
      from: env.from,
      reply_to: env.reply_to.length ? env.reply_to : undefined,
      to: env.to,
      cc: env.cc.length ? env.cc : undefined,
      message_id: env.message_id,
      in_reply_to: env.in_reply_to,
      unread: !f.some((x) => /^\\seen$/i.test(x)),
      attachments,
      body_format: textPart ? `${textPart.type}/${textPart.subtype}` : undefined,
      body_truncated: truncated || undefined,
      body,
    };
  });
}
