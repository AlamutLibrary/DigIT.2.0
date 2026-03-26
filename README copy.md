# Alamut Library — Digital Ismaili Texts

A free, open-source web application for reading and AI-chatting with Arabic and Persian Ismaili texts. Built on GitHub Pages + Cloudflare Workers. No server costs, no database, no backend.

---

## Architecture

```
Browser (GitHub Pages)
    │  asks questions
    ▼
Cloudflare Worker  ◄── ANTHROPIC_API_KEY (secret, never leaves CF)
    │  proxies to
    ▼
Anthropic Claude API
```

Texts are loaded directly from this GitHub repo via `raw.githubusercontent.com`. Metadata comes from each text's paired `.yml` file and the root `texts.yml` manifest.

---

## Repository Structure

```
DigIT.1.0/
├── index.html                  ← The entire frontend app
├── texts.yml                   ← Manifest: list of all texts + metadata
├── worker.js                   ← Cloudflare Worker (API proxy)
├── wrangler.toml               ← Cloudflare Workers config
├── README.md
├── .github/
│   └── workflows/
│       └── deploy.yml          ← Auto-deploy to GitHub Pages on push
└── texts/
    ├── nasir.khusraw.wajh_al-din.per1       ← Raw text (OpenITI format)
    ├── nasir.khusraw.wajh_al-din.yml        ← Metadata YAML
    ├── ikhwan.al-safa.rasail.ara1
    ├── ikhwan.al-safa.rasail.yml
    └── ...
```

---

## Step 1 — Enable GitHub Pages

1. Go to your repo on GitHub: `https://github.com/AlamutLibrary/DigIT.1.0`
2. Click **Settings** → **Pages**
3. Under **Source**, choose **GitHub Actions**
4. Push any change to `main` — the Actions workflow in `.github/workflows/deploy.yml` will deploy automatically
5. Your site will be live at: `https://alamutlibrary.github.io/DigIT.1.0`

---

## Step 2 — Deploy the Cloudflare Worker (free API proxy)

This keeps your Anthropic API key secret on the server side.

### 2a. Install Wrangler (Cloudflare CLI)
```bash
npm install -g wrangler
wrangler login
```

### 2b. Deploy the Worker
```bash
# From the repo root:
wrangler deploy
```
This deploys `worker.js` as `alamut-proxy` on Cloudflare's free tier.

### 2c. Store the API Key as a secret
```bash
wrangler secret put ANTHROPIC_API_KEY
# Paste your sk-ant-... key when prompted. It is stored encrypted, never in code.
```

### 2d. Get your Worker URL
After deploying, Wrangler will print something like:
```
https://alamut-proxy.YOUR_ACCOUNT.workers.dev
```

### 2e. Update index.html
Open `index.html` and find this line near the top of the `<script>` block:
```javascript
const WORKER_URL = ''; // leave empty to call Anthropic directly using user's key
```
Change it to:
```javascript
const WORKER_URL = 'https://alamut-proxy.YOUR_ACCOUNT.workers.dev';
```
Then commit and push — GitHub Actions will redeploy automatically.

### 2f. Update CORS in worker.js
Open `worker.js` and update `ALLOWED_ORIGINS` to include your GitHub Pages URL:
```javascript
const ALLOWED_ORIGINS = [
  'https://alamutlibrary.github.io',
  // add more if needed
];
```

---

## Step 3 — Add Texts to the Library

### Option A: Add via texts.yml (recommended for bulk)

Edit `texts.yml` to list your texts:

```yaml
texts:
  - id: my_text_id
    title: "My Text Title"
    author: "Author Name"
    date: "c. 1100 CE"
    language: arabic         # ar | fa | en
    genre: theology
    branch: main
    raw_text_path: "texts/my.text.ara1"     # path to raw text in this repo
    github_path: "texts/my.text.yml"        # path to metadata YAML (optional)
    uri: "OpenITI_URI_if_applicable"
```

Then place the text file at `texts/my.text.ara1` and push.

### Option B: Add via the web interface

The app has an **"Add your own text"** panel in the sidebar. You can:
- Paste text directly (Arabic, Persian, or English)
- Upload `.txt`, `.md`, or OpenITI `.ara1`/`.per1` files

These texts are session-only (not saved to GitHub).

### Option C: Load from any public OpenITI repo

Enter any `owner/repo` in the repo field in the sidebar. The app will:
1. Look for `texts.yml` in that repo
2. If not found, auto-scan for `.ara1`/`.per1`/`.txt` files via the GitHub API

---

## Metadata YAML Format

Each text can have a paired `.yml` file (OpenITI-compatible). Example:

```yaml
# texts/nasir.khusraw.wajh_al-din.yml
uri: 0394NasirKhusraw.WajhDin
title: Wajh-i Din
title_ar: وجه دين
author: Nasir Khusraw
author_ar: ناصر خسرو
date: 1060 CE
language: persian
genre: theology
editor: W. Ivanow
publisher: Ismaili Society
translator:
tags:
  - Fatimid
  - Nizari
  - philosophy
  - imamate
notes: >
  One of Nasir Khusraw's major theological works, written in Persian.
```

All fields are optional. The app displays whatever fields are present.

---

## Chat Modes

| Mode | How it works | Best for |
|------|-------------|----------|
| **Relevant Passages** | Extracts the ~4 most relevant passages using keyword scoring. Fast. | Most questions |
| **Full Text** | Sends the entire text (up to 100k chars). Slower but more thorough. | Close reading, rare references |

Switch between modes using the toggle in the top-right of the chat area.

---

## Privacy & Security

- The Anthropic API key **never touches the browser** when using the Cloudflare Worker
- Users can also enter their own key (stored in `sessionStorage` only — cleared when tab closes)
- No user data, queries, or texts are stored anywhere — all processing is stateless
- CORS on the Worker restricts requests to your GitHub Pages domain only

---

## Costs

| Service | Cost |
|---------|------|
| GitHub Pages | Free |
| Cloudflare Workers | Free (100k requests/day) |
| Anthropic API | Pay per use (~$0.003 per query with claude-sonnet) |

---

## License

MIT License — see LICENSE file.

Texts from the OpenITI corpus are subject to their own licensing terms.
