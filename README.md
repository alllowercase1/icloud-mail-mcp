# iCloud Mail, Calendar & Contacts connector for Claude

A small server that lets Claude **read** your iCloud Mail, Calendar and Contacts, any time, without your Mac being on.
It runs for free on Cloudflare Workers and talks to iCloud over IMAP, CalDAV and CardDAV, all with the same app-specific password.

- **Read-only.** Seven tools: list mailboxes, search and read mail; list calendars and events; search and read contacts. It cannot send, delete, move, flag or mark mail as read (mailboxes are opened read-only and bodies are fetched with `BODY.PEEK`), and it only ever sends CalDAV/CardDAV read requests (`PROPFIND`, `REPORT`, `GET`), so it can't create, change or delete events or contacts. Your Apple ID and app password are only sent to iCloud.
- **Always on.** Cloudflare runs it; nothing depends on your computer.
- **Free.** Cloudflare Workers free plan (100,000 requests a day; this uses a handful per question).

## How it's secured

| Layer | What it does |
|---|---|
| OAuth 2.1 sign-in | Claude must sign in before it can call anything. Unauthenticated requests get `401`. |
| Connector password (`OWNER_PASSWORD`) | The sign-in page only approves a connection if you type this password. Nobody else can connect, even with the URL. |
| Claude-only redirect | Only Claude's own OAuth callback (`claude.ai` / `claude.com`) may register, so tokens can never be sent to another site. |
| Lockout | After 10 wrong passwords in an hour, sign-in pauses for the rest of that hour. |
| Secrets stay in Cloudflare | Your iCloud address, app-specific password and connector password are Cloudflare secrets: encrypted, never in the code or this folder. |
| App-specific password | iCloud access uses an Apple app-specific password, not your Apple Account password, and you can revoke it at any time. |
| Tokens | Stored only as hashes. Access tokens last 1 hour and refresh automatically; the connection stays active as long as Claude uses it at least once every 90 days. |

**To cut access off instantly:** revoke the app-specific password at account.apple.com (Sign-In and Security → App-Specific Passwords). That stops all mail access even if everything else leaked. Deleting the Worker in Cloudflare also works.

Trade-off worth knowing: anyone who visits your Worker's sign-in page can try passwords (the lockout stops guessing, but repeated tries could pause *your* reconnecting for an hour; existing connections keep working). Use a long random connector password, as below.

## Setup on your phone (about 5 minutes)

1. **Make an Apple app-specific password.** In Safari go to account.apple.com → Sign-In and Security → App-Specific Passwords → +. Name it `Claude mail connector` and copy the password (`xxxx-xxxx-xxxx-xxxx`).
2. **Make a connector password.** On iPhone: Passwords app → + → New Password, call it "iCloud connector", and let it suggest a strong password. Copy it.
3. **Tap the Deploy to Cloudflare link** (https://deploy.workers.cloudflare.com/?url=https://github.com/alllowercase1/icloud-mail-mcp) and sign in to Cloudflare. Pick your GitHub account if asked. In the form:
   - `ICLOUD_USER`: your iCloud email address.
   - `ICLOUD_APP_PASSWORD`: the password from step 1.
   - `OWNER_PASSWORD`: the password from step 2.
   - Leave `IMAP_HOST`, `IMAP_PORT`, `IMAP_TLS` as they are.

   Tap **Deploy**. When it finishes it shows your URL, like `https://icloud-mail-mcp.yourname.workers.dev`.
4. **Add it to Claude.** Open **Connectors** (under Settings or Customize) → **Add custom connector**. Name `iCloud Mail`, URL = your Worker URL + `/mcp`. Tap **Connect**, type your connector password, tap **Allow**.

## Setup from a computer (alternative, about 15 minutes)

You'll need: this folder on your Mac, and Terminal (Applications → Utilities → Terminal).

### 1. Install Node.js
Download the **LTS** installer from nodejs.org and run it. Check it worked:
```
node -v
```

### 2. Create a free Cloudflare account
Sign up at dash.cloudflare.com (free plan, no card needed).

### 3. Make an Apple app-specific password
1. Go to account.apple.com and sign in.
2. **Sign-In and Security → App-Specific Passwords → +**.
3. Name it `Claude mail connector`. Copy the password it shows (format `xxxx-xxxx-xxxx-xxxx`). You'll paste it in step 6.

### 4. Make a connector password
In Terminal:
```
openssl rand -base64 24
```
Save the result in your Passwords app as "iCloud connector". You'll type it once when you connect Claude.

### 5. Open the folder and sign in to Cloudflare
In Terminal, `cd` into this folder (type `cd ` then drag the folder onto the Terminal window and press Return), then:
```
npm install
npx wrangler login
```
A browser window opens; click **Allow**.

### 6. Deploy, then add your secrets
```
npx wrangler deploy
```
If asked to pick a workers.dev subdomain, choose any name. It prints your URL, like `https://icloud-mail-mcp.yourname.workers.dev`. Then run these three, pasting each value when asked (nothing shows as you paste; that's normal):
```
npx wrangler secret put ICLOUD_USER
npx wrangler secret put ICLOUD_APP_PASSWORD
npx wrangler secret put OWNER_PASSWORD
```
- `ICLOUD_USER`: your iCloud email address (e.g. `name@icloud.com`). If sign-in fails later, try just the part before `@icloud.com`.
- `ICLOUD_APP_PASSWORD`: the app-specific password from step 3.
- `OWNER_PASSWORD`: the connector password from step 4.

Open your URL in a browser; you should see "iCloud Mail connector… This server is running."

### 7. Add it to Claude
1. In Claude, open **Connectors** (under Settings or Customize) and choose **Add custom connector**.
2. Name: `iCloud Mail`. URL: your Worker URL followed by `/mcp`, e.g. `https://icloud-mail-mcp.yourname.workers.dev/mcp`.
3. Click **Connect**. Your Worker's page opens: type your connector password and click **Allow**.

Try it: "Search my iCloud mail for anything from Chris this week."

## Tools

| Tool | What it does |
|---|---|
| `list_mailboxes` | Folders (INBOX, Sent Messages, Archive, Junk, custom), optionally with total/unread counts. |
| `search_messages` | Newest-first search in one mailbox by from, to, subject, text, date range, unread, flagged. Returns headers and a `uid`. |
| `get_message` | One message by mailbox + uid: headers, plain-text body (HTML converted), attachment names and sizes. Doesn't mark it read. |
| `list_calendars` | Your iCloud calendars (name, id, color). Reminders-only lists are left out. |
| `list_events` | Events overlapping a date range (default the next 7 days, up to 400), soonest first, in the IANA time zone you ask for. Recurring events are expanded; filter by calendar or text. |
| `search_contacts` | Contacts matching a name, nickname, company, email or phone number (any format). Returns names, companies, emails, phones and an `id`. |
| `get_contact` | One contact by id: emails, phones, addresses, birthday, websites, related names and notes. |

## Troubleshooting

- **"iCloud rejected the sign-in"**: the app-specific password is wrong or revoked: make a fresh one, and set `ICLOUD_USER` to your main Apple ID address (not an alias). Re-run `npx wrangler secret put …` to change a value.
- **"Too many wrong passwords"**: wait up to an hour, then connect again.
- **New tools don't show up in Claude after an update**: open the connector in Claude's settings and reconnect it, or start a new chat.
- **Claude says the connector needs reconnecting**: click Connect again and type the connector password.
- **Change the connector password**: `npx wrangler secret put OWNER_PASSWORD`. (Existing connections stay signed in; revoke the app-specific password to cut everything off.)

## For developers

```
npm run typecheck   # TypeScript
npm test            # 16 mail tests against Hoodiecrow (a strict test IMAP server) + 12 calendar/contacts tests against a mock CalDAV/CardDAV server
```
End-to-end (OAuth flow + MCP over Workers sockets and fetch, no real account):
```
printf 'ICLOUD_USER=testuser\nICLOUD_APP_PASSWORD=testpass\nOWNER_PASSWORD=correct-horse-battery-staple-42\nIMAP_HOST=127.0.0.1\nIMAP_PORT=1143\nIMAP_TLS=off\nCALDAV_URL=http://127.0.0.1:8790/\nCARDDAV_URL=http://127.0.0.1:8790/card-root/\n' > .dev.vars
node test/imap-server.cjs &   # test IMAP server on :1143
DAV_SERVE_PORT=8790 DAV_USER=testuser DAV_PASS=testpass npx tsx test/dav.ts &   # mock CalDAV/CardDAV
npx wrangler dev --port 8787 &
npx tsx test/e2e.ts
```
`.dev.vars` is for local testing only and is git-ignored; never put real credentials there.

Layout: `src/imap.ts` (minimal IMAP client over Web Streams), `src/mime.ts` (BODYSTRUCTURE, decoding, HTML→text), `src/mail.ts` (mail tools), `src/dav.ts` (calendar and contacts tools over CalDAV/CardDAV), `src/mcp.ts` (stateless Streamable HTTP MCP), `src/index.ts` (OAuth via `@cloudflare/workers-oauth-provider`, sign-in page, routing).
