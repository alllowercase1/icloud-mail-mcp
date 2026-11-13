// MIME helpers: BODYSTRUCTURE walking, transfer/charset decoding, RFC 2047 headers, HTML to text.
import { bytesToString, type ImapValue } from "./imap";

export interface BodyPart {
  section: string; // IMAP part number, e.g. "1", "1.2"
  type: string; // lower case, e.g. "text"
  subtype: string; // lower case, e.g. "plain"
  params: Record<string, string>;
  encoding: string;
  size: number;
  disposition: string | null;
  dispositionParams: Record<string, string>;
  children: BodyPart[];
}

const str = (v: ImapValue | undefined) => bytesToString(v);

function paramMap(v: ImapValue | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(v)) return out;
  const raw: Record<string, string> = {};
  for (let i = 0; i + 1 < v.length; i += 2) raw[str(v[i]).toLowerCase()] = str(v[i + 1]);
  // RFC 2231: name*=charset'lang'value and name*0*=..., name*1=...
  const continued: Record<string, { idx: number; val: string; enc: boolean }[]> = {};
  for (const [k, val] of Object.entries(raw)) {
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(k);
    if (!m) {
      out[k] = decodeWords(val);
      continue;
    }
    const base = m[1];
    if (m[2] === undefined) {
      out[base] = decode2231(val, true);
    } else {
      (continued[base] ||= []).push({ idx: parseInt(m[2], 10), val, enc: !!m[3] });
    }
  }
  for (const [base, pieces] of Object.entries(continued)) {
    pieces.sort((a, b) => a.idx - b.idx);
    let charset = "utf-8";
    let bytes: number[] = [];
    pieces.forEach((p, n) => {
      let val = p.val;
      if (p.enc && n === 0) {
        const parts = val.split("'");
        if (parts.length >= 3) {
          charset = parts[0] || "utf-8";
          val = parts.slice(2).join("'");
        }
      }
      if (p.enc) bytes = bytes.concat(percentDecode(val));
      else for (const ch of val) bytes.push(ch.charCodeAt(0) & 0xff);
    });
    out[base] = decodeCharset(new Uint8Array(bytes), charset);
  }
  return out;
}

function percentDecode(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return out;
}

function decode2231(val: string, encoded: boolean): string {
  if (!encoded) return val;
  const parts = val.split("'");
  if (parts.length < 3) return val;
  return decodeCharset(new Uint8Array(percentDecode(parts.slice(2).join("'"))), parts[0] || "utf-8");
}

export function parseBodyStructure(v: ImapValue | undefined, section = ""): BodyPart | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (Array.isArray(v[0])) {
    // multipart: (child)(child)... "subtype" [params disposition language location]
    const children: BodyPart[] = [];
    let i = 0;
    while (i < v.length && Array.isArray(v[i])) {
      const childSection = section ? `${section}.${children.length + 1}` : `${children.length + 1}`;
      const child = parseBodyStructure(v[i], childSection);
      if (child) children.push(child);
      i++;
    }
    const subtype = str(v[i]).toLowerCase();
    const disp = v[i + 2];
    return {
      section: section || "",
      type: "multipart",
      subtype,
      params: paramMap(v[i + 1]),
      encoding: "",
      size: children.reduce((s, c) => s + c.size, 0),
      disposition: Array.isArray(disp) ? str(disp[0]).toLowerCase() : null,
      dispositionParams: Array.isArray(disp) ? paramMap(disp[1]) : {},
      children,
    };
  }
  const type = str(v[0]).toLowerCase();
  const subtype = str(v[1]).toLowerCase();
  let ext = 7;
  if (type === "text") ext = 8;
  else if (type === "message" && (subtype === "rfc822" || subtype === "global")) ext = 10;
  const disp = v[ext + 1];
  return {
    section: section || "1",
    type,
    subtype,
    params: paramMap(v[2]),
    encoding: str(v[5]).toLowerCase(),
    size: parseInt(str(v[6]), 10) || 0,
    disposition: Array.isArray(disp) ? str(disp[0]).toLowerCase() : null,
    dispositionParams: Array.isArray(disp) ? paramMap(disp[1]) : {},
    children: [],
  };
}

function leaves(p: BodyPart): BodyPart[] {
  return p.children.length ? p.children.flatMap(leaves) : [p];
}

export function partFilename(p: BodyPart): string | undefined {
  return p.dispositionParams["filename"] || p.params["name"] || undefined;
}

/** Picks the best readable body part: text/plain first, then text/html. */
export function pickTextPart(root: BodyPart): BodyPart | null {
  const all = leaves(root).filter((p) => p.disposition !== "attachment" && !(p.type === "text" && partFilename(p) && p.disposition));
  return (
    all.find((p) => p.type === "text" && p.subtype === "plain") ||
    all.find((p) => p.type === "text" && p.subtype === "html") ||
    null
  );
}

export interface AttachmentInfo {
  filename: string;
  content_type: string;
  approx_bytes: number;
  inline: boolean;
}

export function listAttachments(root: BodyPart, textPart: BodyPart | null): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  for (const p of leaves(root)) {
    if (p === textPart) continue;
    const name = partFilename(p);
    const isAttachment = p.disposition === "attachment";
    const isMessage = p.type === "message";
    if (!name && !isAttachment && !isMessage) continue; // e.g. the text/html twin of the body
    const approx = p.encoding === "base64" ? Math.round((p.size * 3) / 4) : p.size;
    out.push({
      filename: name || (isMessage ? "attached message" : "unnamed"),
      content_type: `${p.type}/${p.subtype}`,
      approx_bytes: approx,
      inline: p.disposition === "inline",
    });
  }
  return out;
}

// ---------- decoding ----------

export function decodeTransfer(bytes: Uint8Array, encoding: string): Uint8Array {
  const e = encoding.toLowerCase();
  if (e === "base64") {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      // keep only base64 alphabet
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47) {
        s += String.fromCharCode(c);
      }
    }
    // restore padding; a lone trailing char (body cut short by a partial fetch) is dropped
    const rem = s.length % 4;
    if (rem === 1) s = s.slice(0, -1);
    else if (rem) s += "=".repeat(4 - rem);
    try {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return bytes;
    }
  }
  if (e === "quoted-printable") {
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      if (c === 61 /* = */) {
        const a = bytes[i + 1];
        const b = bytes[i + 2];
        if (a === 13 && b === 10) {
          i += 2;
          continue;
        }
        if (a === 10) {
          i += 1;
          continue;
        }
        const hex = String.fromCharCode(a ?? 0, b ?? 0);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      out.push(c);
    }
    return new Uint8Array(out);
  }
  return bytes;
}

export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const cs = (charset || "utf-8").toLowerCase().replace(/^"|"$/g, "");
  const candidates = [cs, cs === "us-ascii" ? "utf-8" : "", "utf-8"].filter(Boolean);
  for (const c of candidates) {
    try {
      return new TextDecoder(c).decode(bytes);
    } catch {
      /* unsupported label: try the next */
    }
  }
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** RFC 2047 encoded-words in headers. */
export function decodeWords(s: string): string {
  if (!s || !s.includes("=?")) return s;
  // whitespace between adjacent encoded words is dropped
  const joined = s.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset: string, kind: string, text: string) => {
    try {
      let bytes: Uint8Array;
      if (kind.toUpperCase() === "B") {
        bytes = decodeTransfer(new TextEncoder().encode(text), "base64");
      } else {
        const t = text.replace(/_/g, " ");
        bytes = decodeTransfer(latin1Bytes(t), "quoted-printable");
      }
      return decodeCharset(bytes, charset.split("*")[0]);
    } catch {
      return whole;
    }
  });
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  zwnj: "",
  zwj: "",
};

export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(script|style|head|title)[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
    const t = text.replace(/<[^>]+>/g, "").trim();
    if (!t) return "";
    return href.startsWith("http") && !t.includes(href) ? `${t} (${href})` : t;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote|section|article)\s*>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n• ");
  s = s.replace(/<td\b[^>]*>/gi, " ");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      try {
        return code === 0x200c || code === 0x200b || code === 0x34f ? "" : String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[ent.toLowerCase()] ?? whole;
  });
  s = s.replace(/[ \t ]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
