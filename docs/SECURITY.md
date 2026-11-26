# Security review (MultiCode 0.3.17+)

What protects MultiCode, what was checked, and what changed in this review.

## How it is protected

| Area | Protection |
|---|---|
| Who can use it | Once the first account exists, every API call and project preview needs a session. Passwords: scrypt (N=2^15). Sessions: 32 random bytes in an HttpOnly, SameSite=Strict cookie, stored only as SHA-256 hashes, 30 days. Eight wrong passwords lock that email for 10 minutes. |
| Google sign-in | OAuth 2.0 with PKCE (S256) and a single-use state; the ID token is checked by Google and must be for this app's client with a verified email. Only people with an account get in (the first account may be created with Google). |
| Roles | Members work in projects and chats. Only the owner changes connections, settings and hooks, the crew, MCP servers, installs, opened folders, check commands, skills, people and Google sign-in. |
| Secrets at rest | API keys, extra headers, MCP secrets and the Google client secret are encrypted with AES-256-GCM. Desktop: the key is sealed by the OS keychain (Electron safeStorage) and removed from the environment before any agent starts. Elsewhere: a key file readable only by you (0600). |
| Requests from other sites | Loopback-only Host check (DNS rebinding), a custom header on every change (CSRF), SameSite=Strict cookies. |
| Model output | Markdown is sanitized with DOMPurify (no scripts, styles, images, event handlers or `javascript:` links; links open outside the app). |
| Files | Every project path goes through one resolver that refuses anything outside the project; protected files (`.env`, keys) are never read for mentions, reviews or commits. Attachments and skill names are strictly validated. |
| Git | Clone addresses must be `owner/repo`, https or `git@`; never an option, a local path or `file://`. `--` before every address. |
| Desktop app | Context isolation, sandboxed renderers, no Node in pages, navigation locked to the local app, IPC checks the sender and validates arguments. |

## Changed in this review

- **Owner-only actions** for everything that runs commands or stores keys (members got 403).
- **smol-toml** upgraded to 1.9.1 (three denial-of-service advisories in ≤1.8.0).
- **Electron** upgraded from 39 to 45.5.0 (39 was out of support; several high advisories, e.g. permission-check origin for iframes, IPC reply spoofing).
- The encryption key no longer travels to agents through the environment.

## Known and accepted

- `tar` and `app-builder-lib` advisories are in electron-builder, used only to build the installer from trusted inputs; not shipped in the app.
- Monaco (the code editor) bundles DOMPurify 3.4.15, affected only in modes MultiCode doesn't use (IN_PLACE, SAFE_FOR_TEMPLATES); MultiCode's own sanitizer is 3.5.0.
- Hooks and check commands run shell commands you (the owner) wrote, by design.
- Agents such as Claude Code and Codex run code in your projects; approvals and sandbox mode are the controls for that.
