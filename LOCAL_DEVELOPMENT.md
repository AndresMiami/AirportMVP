# Local Development Setup (VS Code)

Run the whole LinkMia app on your Mac: edit in VS Code, refresh the browser,
see changes instantly — no commit, no deploy, no waiting.

## One-time setup

### 1. Prerequisites

- **Node.js** — install the LTS version from https://nodejs.org (check with `node -v`, should print v20+)
- **Git** — macOS: run `xcode-select --install` in Terminal if `git -v` doesn't work
- **VS Code** — https://code.visualstudio.com

### 2. Clone the project

Open Terminal (or the VS Code terminal):

```bash
cd ~/Documents        # or wherever you keep projects
git clone https://github.com/AndresMiami/AirportMVP.git
cd AirportMVP
code .                # opens the project in VS Code
```

(GitHub will ask you to log in the first time — follow the browser prompt.)

### 3. Install dependencies

In the VS Code terminal (Terminal → New Terminal):

```bash
npm install
npm install -g netlify-cli
```

### 4. Connect to your Netlify site

```bash
netlify login         # opens browser, approve
netlify link          # choose "Use current git remote origin" -> picks your site
```

Linking means `netlify dev` automatically uses the site's real environment
variables (Supabase keys, driver passcode, Telegram) — no .env file needed.

## Daily use

```bash
netlify dev
```

Then open **http://localhost:3001** — the full app: booking flow, driver page
(/driver), trip page (/trip), login (/login), and all serverless functions.

Edit any file in VS Code → save → refresh the browser. That's the loop.

Stop the server with `Ctrl+C`.

## Things to know

| Topic | Reality |
|---|---|
| Database | Local runs against the **production** Supabase — test bookings are real rows (delete them in the Table Editor after) |
| Telegram | Doorbells/receipts fire for real. For silence, run with the vars unset: `TELEGRAM_BOT_TOKEN= ADMIN_TELEGRAM_CHAT_ID= netlify dev` |
| Maps | Work locally — the Railway proxy allows localhost |
| Service worker | Deliberately disabled on localhost so cached files never mask your edits |
| Live GPS | Browser geolocation needs HTTPS *or* localhost — localhost qualifies, so tracking works |

## Getting your local changes live

Local edits are invisible to the world until pushed:

```bash
git checkout -b my-change      # make a branch
git add -A
git commit -m "describe the change"
git push -u origin my-change
```

Then open the pull request on GitHub, test the Netlify **deploy preview**
if enabled, and merge — same flow as always.

## If something's weird

- `netlify dev` errors about a port → something else uses 3001; close it or run `netlify dev -p 3002`
- Functions failing with missing env vars → re-run `netlify link`, confirm with `netlify env:list`
- Changes not appearing → hard-refresh (Cmd+Shift+R); if it persists, confirm you saved the file and you're on http://localhost:3001, not the live site
