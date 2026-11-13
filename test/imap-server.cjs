// Standalone test IMAP server for `wrangler dev` end-to-end checks (port 1143, testuser/testpass).
const hoodiecrow = require("hoodiecrow-imap");
const CRLF = (s) => s.replace(/\r?\n/g, "\r\n");
const server = hoodiecrow({
  plugins: ["SPECIAL-USE"],
  storage: {
    INBOX: { messages: [
      { raw: CRLF("From: Chris <chris@example.com>\nTo: alex@example.com\nSubject: Tour budget\nDate: Tue, 10 Nov 2026 10:00:00 -0500\n\nBudget attached tomorrow.\n"), internaldate: "10-Nov-2026 15:00:00 +0000" },
    ] },
    "": { separator: "/", folders: { "Sent Messages": { "special-use": "\\Sent", messages: [] } } },
  },
});
server.listen(1143, "127.0.0.1", () => console.log("imap test server on 1143"));
