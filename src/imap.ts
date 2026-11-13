// Minimal, read-only IMAP4rev1 client that runs on any Web Streams socket
// (Cloudflare Workers `connect()`, or Node's stream.Duplex.toWeb for tests).
// Only the commands this connector needs: LOGIN, LIST, STATUS, EXAMINE,
// UID SEARCH, UID FETCH (always BODY.PEEK, so nothing is marked as read), LOGOUT.
// EXAMINE opens mailboxes read-only; no command here can change, move or delete mail.

export interface Transport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void> | void;
}

/** A parsed IMAP value: atom/quoted string (string), literal (Uint8Array), NIL (null) or list. */
export type ImapValue = string | Uint8Array | null | ImapValue[];

export class ImapError extends Error {}

const enc = new TextEncoder();
const utf8 = new TextDecoder("utf-8");
const MAX_RESPONSE_BYTES = 30 * 1024 * 1024;

export function bytesToString(v: ImapValue | undefined): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return utf8.decode(v);
  return "";
}

export class ImapClient {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buf = new Uint8Array(64 * 1024);
  private len = 0;
  private tagNo = 0;
  private closed = false;

  constructor(private transport: Transport, private timeoutMs = 25_000) {
    this.reader = transport.readable.getReader();
    this.writer = transport.writable.getWriter();
  }

  // ---------- low-level reading ----------

  private async fill(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ImapError("Timed out waiting for the mail server")), this.timeoutMs);
    });
    try {
      const { value, done } = await Promise.race([this.reader.read(), timeout]);
      if (done || !value) throw new ImapError("Mail server closed the connection");
      if (this.len + value.length > this.buf.length) {
        let size = this.buf.length * 2;
        while (size < this.len + value.length) size *= 2;
        if (size > MAX_RESPONSE_BYTES * 2) throw new ImapError("Mail server response too large");
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
      }
      this.buf.set(value, this.len);
      this.len += value.length;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Reads one complete server response (including any literals), without the final CRLF. */
  private async readResponse(): Promise<Uint8Array> {
    let pos = 0; // scan position within buf
    for (;;) {
      // find CRLF from pos
      let crlf = -1;
      for (;;) {
        for (let i = pos; i + 1 < this.len; i++) {
          if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
            crlf = i;
            break;
          }
        }
        if (crlf >= 0) break;
        pos = Math.max(pos, this.len - 1);
        await this.fill();
      }
      // does the line end with a literal marker {n}?
      let n = -1;
      if (crlf > 0 && this.buf[crlf - 1] === 125 /* } */) {
        let j = crlf - 2;
        let digits = "";
        while (j >= 0 && this.buf[j] >= 48 && this.buf[j] <= 57) {
          digits = String.fromCharCode(this.buf[j]) + digits;
          j--;
        }
        if (this.buf[j] === 43 /* + */) j--;
        if (digits && j >= 0 && this.buf[j] === 123 /* { */) n = parseInt(digits, 10);
      }
      if (n < 0) {
        const out = this.buf.slice(0, crlf);
        this.buf.copyWithin(0, crlf + 2, this.len);
        this.len -= crlf + 2;
        return out;
      }
      if (n > MAX_RESPONSE_BYTES) throw new ImapError("Mail server response too large");
      const literalEnd = crlf + 2 + n;
      while (this.len < literalEnd) await this.fill();
      pos = literalEnd;
    }
  }

  private async write(data: string | Uint8Array): Promise<void> {
    await this.writer.write(typeof data === "string" ? enc.encode(data) : data);
  }

  // ---------- commands ----------

  async greeting(): Promise<void> {
    const line = utf8.decode(await this.readResponse());
    if (/^\* BYE/i.test(line)) throw new ImapError("Mail server refused the connection: " + line.slice(6));
    if (!/^\* (OK|PREAUTH)/i.test(line)) throw new ImapError("Unexpected greeting from mail server");
  }

  /**
   * Sends a command. `parts` are joined with nothing in between; a Uint8Array part
   * is sent as a synchronizing literal. Returns the untagged responses.
   */
  async command(...parts: (string | Uint8Array)[]): Promise<Uint8Array[]> {
    if (this.closed) throw new ImapError("Connection already closed");
    const tag = "A" + ++this.tagNo;
    const untagged: Uint8Array[] = [];
    let pending = tag + " ";
    for (const part of parts) {
      if (typeof part === "string") {
        pending += part;
        continue;
      }
      await this.write(pending + "{" + part.length + "}\r\n");
      pending = "";
      // wait for continuation
      for (;;) {
        const resp = await this.readResponse();
        if (resp[0] === 43 /* + */) break;
        if (resp[0] === 42 /* * */) {
          untagged.push(resp);
          continue;
        }
        throw new ImapError("Mail server rejected the request: " + tail(resp));
      }
      await this.write(part);
    }
    await this.write(pending + "\r\n");
    for (;;) {
      const resp = await this.readResponse();
      if (resp[0] === 42 /* * */) {
        untagged.push(resp);
        continue;
      }
      if (resp[0] === 43) continue; // stray continuation
      if (isTagged(resp, tag)) return checkTagged(resp, untagged);
    }
  }

  async login(user: string, password: string): Promise<void> {
    try {
      await this.command("LOGIN ", astring(user), " ", astring(password));
    } catch (e) {
      // Never echo the command (it contains the password); the server text is safe.
      throw new ImapError(
        "iCloud rejected the sign-in. Check ICLOUD_USER and that ICLOUD_APP_PASSWORD is a current app-specific password. (" +
          (e as Error).message +
          ")",
      );
    }
  }

  async logout(): Promise<void> {
    if (this.closed) return;
    try {
      const tag = "A" + ++this.tagNo;
      await this.write(tag + " LOGOUT\r\n");
    } catch {
      /* ignore */
    }
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.reader.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      this.writer.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await this.transport.close();
    } catch {
      /* ignore */
    }
  }

  async list(): Promise<{ name: string; flags: string[]; delimiter: string | null }[]> {
    const resps = await this.command('LIST "" "*"');
    const out: { name: string; flags: string[]; delimiter: string | null }[] = [];
    for (const r of resps) {
      const t = parseUntagged(r);
      if (!t || String(t[0]).toUpperCase() !== "LIST") continue;
      const flags = Array.isArray(t[1]) ? (t[1] as ImapValue[]).map((f) => bytesToString(f)) : [];
      const delim = t[2] == null ? null : bytesToString(t[2]);
      out.push({ name: decodeMailboxName(bytesToString(t[3])), flags, delimiter: delim });
    }
    return out;
  }

  async status(mailbox: string): Promise<{ messages?: number; unseen?: number }> {
    const resps = await this.command("STATUS ", ...mailboxArg(mailbox), " (MESSAGES UNSEEN)");
    for (const r of resps) {
      const t = parseUntagged(r);
      if (!t || String(t[0]).toUpperCase() !== "STATUS" || !Array.isArray(t[2])) continue;
      const kv = t[2] as ImapValue[];
      const res: { messages?: number; unseen?: number } = {};
      for (let i = 0; i + 1 < kv.length; i += 2) {
        const k = bytesToString(kv[i]).toUpperCase();
        const v = parseInt(bytesToString(kv[i + 1]), 10);
        if (k === "MESSAGES") res.messages = v;
        if (k === "UNSEEN") res.unseen = v;
      }
      return res;
    }
    return {};
  }

  /** Opens a mailbox read-only. */
  async examine(mailbox: string): Promise<{ exists: number; uidValidity?: string }> {
    const resps = await this.command("EXAMINE ", ...mailboxArg(mailbox));
    let exists = 0;
    let uidValidity: string | undefined;
    for (const r of resps) {
      const s = utf8.decode(r);
      const m = /^\* (\d+) EXISTS/i.exec(s);
      if (m) exists = parseInt(m[1], 10);
      const u = /\[UIDVALIDITY (\d+)\]/i.exec(s);
      if (u) uidValidity = u[1];
    }
    return { exists, uidValidity };
  }

  /** UID SEARCH. `criteria` is a list of already-encoded parts (strings and literals). */
  async uidSearch(criteria: (string | Uint8Array)[], utf8Charset: boolean): Promise<number[]> {
    const parts: (string | Uint8Array)[] = ["UID SEARCH "];
    if (utf8Charset) parts.push("CHARSET UTF-8 ");
    parts.push(...criteria);
    const resps = await this.command(...parts);
    const uids: number[] = [];
    for (const r of resps) {
      const s = utf8.decode(r);
      const m = /^\* SEARCH\b(.*)$/i.exec(s);
      if (!m) continue;
      for (const tok of m[1].trim().split(/\s+/)) {
        const n = parseInt(tok, 10);
        if (Number.isFinite(n)) uids.push(n);
      }
    }
    return uids;
  }

  /** UID FETCH returning one key/value map per message, keyed by upper-case item name. */
  async uidFetch(uidSet: string, items: string): Promise<Map<string, ImapValue>[]> {
    const resps = await this.command("UID FETCH " + uidSet + " " + items);
    const out: Map<string, ImapValue>[] = [];
    for (const r of resps) {
      const t = parseUntagged(r);
      if (!t || t.length < 3 || String(t[1]).toUpperCase() !== "FETCH" || !Array.isArray(t[2])) continue;
      const kv = t[2] as ImapValue[];
      const map = new Map<string, ImapValue>();
      for (let i = 0; i + 1 < kv.length; i += 2) {
        map.set(bytesToString(kv[i]).toUpperCase(), kv[i + 1]);
      }
      if (map.has("UID")) out.push(map);
    }
    return out;
  }
}

function tail(resp: Uint8Array): string {
  return utf8.decode(resp).replace(/^\S+\s+/, "").slice(0, 300);
}

function isTagged(resp: Uint8Array, tag: string): boolean {
  if (resp.length < tag.length + 1) return false;
  for (let i = 0; i < tag.length; i++) if (resp[i] !== tag.charCodeAt(i)) return false;
  return resp[tag.length] === 32;
}

function checkTagged(resp: Uint8Array, untagged: Uint8Array[]): Uint8Array[] {
  const s = utf8.decode(resp);
  const status = s.split(" ")[1]?.toUpperCase();
  if (status === "OK") return untagged;
  throw new ImapError(s.replace(/^\S+\s+/, "").slice(0, 300));
}

// ---------- argument encoding ----------

/** Encodes a string as an IMAP quoted string, or a literal when it has non-ASCII or CR/LF. */
export function astring(s: string): string | Uint8Array {
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(s)) return enc.encode(s);
  return '"' + s.replace(/[\\"]/g, (c) => "\\" + c) + '"';
}

function mailboxArg(name: string): (string | Uint8Array)[] {
  const encoded = encodeMailboxName(name);
  const a = astring(encoded);
  return [a];
}

/** RFC 3501 modified UTF-7 */
export function encodeMailboxName(name: string): string {
  let out = "";
  let pending: number[] = [];
  const flush = () => {
    if (!pending.length) return;
    const bytes = new Uint8Array(pending.length * 2);
    pending.forEach((c, i) => {
      bytes[i * 2] = c >> 8;
      bytes[i * 2 + 1] = c & 0xff;
    });
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    out += "&" + btoa(bin).replace(/=+$/, "").replace(/\//g, ",") + "-";
    pending = [];
  };
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += c === 0x26 ? "&-" : name[i];
    } else {
      pending.push(c);
    }
  }
  flush();
  return out;
}

export function decodeMailboxName(name: string): string {
  return name.replace(/&([^-]*)-/g, (_, b64: string) => {
    if (b64 === "") return "&";
    try {
      let s = b64.replace(/,/g, "/");
      while (s.length % 4) s += "=";
      const bin = atob(s);
      let out = "";
      for (let i = 0; i + 1 < bin.length; i += 2) {
        out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
      }
      return out;
    } catch {
      return "&" + b64 + "-";
    }
  });
}

// ---------- response parsing ----------

/** Tokenizes an untagged response ("* ...") into values. Returns null for non-untagged lines. */
export function parseUntagged(resp: Uint8Array): ImapValue[] | null {
  if (resp[0] !== 42 || resp[1] !== 32) return null;
  const p = new Parser(resp, 2);
  return p.parseSequence();
}

class Parser {
  constructor(private b: Uint8Array, private i: number) {}

  parseSequence(): ImapValue[] {
    const out: ImapValue[] = [];
    for (;;) {
      this.skipSpaces();
      if (this.i >= this.b.length) return out;
      out.push(this.parseValue());
    }
  }

  private skipSpaces() {
    while (this.i < this.b.length && this.b[this.i] === 32) this.i++;
  }

  private parseValue(): ImapValue {
    const c = this.b[this.i];
    if (c === 40 /* ( */) return this.parseList();
    if (c === 34 /* " */) return this.parseQuoted();
    if (c === 123 /* { */ || (c === 126 /* ~ */ && this.b[this.i + 1] === 123)) return this.parseLiteral();
    return this.parseAtom();
  }

  private parseList(): ImapValue[] {
    this.i++; // (
    const out: ImapValue[] = [];
    for (;;) {
      this.skipSpaces();
      if (this.i >= this.b.length) return out;
      if (this.b[this.i] === 41 /* ) */) {
        this.i++;
        return out;
      }
      out.push(this.parseValue());
    }
  }

  private parseQuoted(): string {
    this.i++;
    const bytes: number[] = [];
    while (this.i < this.b.length) {
      const c = this.b[this.i++];
      if (c === 92 /* \ */ && this.i < this.b.length) {
        bytes.push(this.b[this.i++]);
        continue;
      }
      if (c === 34) break;
      bytes.push(c);
    }
    return utf8.decode(new Uint8Array(bytes));
  }

  private parseLiteral(): Uint8Array {
    if (this.b[this.i] === 126) this.i++;
    this.i++; // {
    let digits = "";
    while (this.i < this.b.length && this.b[this.i] >= 48 && this.b[this.i] <= 57) {
      digits += String.fromCharCode(this.b[this.i++]);
    }
    while (this.i < this.b.length && this.b[this.i] !== 125) this.i++;
    this.i++; // }
    this.i += 2; // CRLF
    const n = parseInt(digits, 10) || 0;
    const out = this.b.slice(this.i, this.i + n);
    this.i += n;
    return out;
  }

  private parseAtom(): ImapValue {
    const start = this.i;
    let depth = 0;
    while (this.i < this.b.length) {
      const c = this.b[this.i];
      if (c === 91 /* [ */) depth++;
      else if (c === 93 /* ] */) {
        if (depth > 0) depth--;
      } else if (depth === 0 && (c === 32 || c === 40 || c === 41 || c === 123 || c === 34)) {
        // "BODY[1]<0>" style keys keep everything up to the next space/paren
        break;
      }
      this.i++;
    }
    if (this.i === start) {
      this.i++; // skip an unexpected byte so we never loop forever
      return "";
    }
    const s = utf8.decode(this.b.subarray(start, this.i));
    return s.toUpperCase() === "NIL" ? null : s;
  }
}
