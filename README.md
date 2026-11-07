# Bucky Publisher

The Bucky Away task site. Pick a task, drop in its files, publish for review. Eduardo and Luna approve or ask for a retake. Bucky posts every change to Discord.

- **Website:** this repo, hosted on GitHub Pages.
- **Backend:** `backend/Code.gs`, a Google Apps Script inside the AssetManager sheet. It reads and writes the sheet and Drive as Eduardo, so artists never sign in with Google.
- **Test it without Google:** open the site with `?mock` at the end of the address, for example `https://eduardojreyes.github.io/BuckyPublisher/?mock`. It uses fake data, everyone's password is 1234, and nothing touches the real sheet or Drive.

## One-time setup

### 1. Backend (Apps Script)

1. Open the **AssetManager** sheet › Extensions › **Apps Script**.
2. Replace everything in `Code.gs` with the contents of `backend/Code.gs` from this repo. Save.
3. ⚙ **Project Settings**:
   - Time zone: Europe/Madrid.
   - Script properties: one webhook per feedback forum (Discord › channel settings › Integrations › Webhooks › New Webhook › Copy Webhook URL):

     | Property | Channel |
     | --- | --- |
     | `DISCORD_WEBHOOK_DESIGN` | #fb-design |
     | `DISCORD_WEBHOOK_CHARACTERS` | #fb-characters |
     | `DISCORD_WEBHOOK_ANIMATION` | #fb-animation |
     | `DISCORD_WEBHOOK_ENVIRONMENT` | #fb-environment |
     | `DISCORD_WEBHOOK_UI` | #fb-ui |
     | `DISCORD_WEBHOOK_AUDIO` | #fb-audio |
     | `DISCORD_WEBHOOK_BUILDS` | #fb-builds |

     Missing ones just mean no messages for that channel. Which channel a task uses: the **Discord channel** column of the Naming tab (by prefix), or the `Discord channel for …` rows in Settings for tasks with no prefix. Each task gets one forum post (title `2.1 · Bucky design…`); every later message replies inside it. The post's ID is kept in the Tasks **Discord thread** column: clear it to make Bucky open a new post.
4. **Deploy › New deployment** › gear › **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy, then allow access. Google warns that the app isn't verified: Advanced › Go to (unsafe). It's your own script.
5. Copy the **Web app URL** (ends in `/exec`).

The sheet needs two things, both already added: a **Password** column in Team, and a **Settings** tab with `Site password` and `Drive root folder ID`.

### 2. Website (GitHub Pages)

1. Paste the `/exec` URL into `config.js`.
2. Commit and push.
3. GitHub › repo **Settings › Pages** › Source: Deploy from a branch › `main`, folder `/ (root)` › Save.
4. After a minute the site is live at `https://eduardojreyes.github.io/BuckyPublisher/`.

## Changing things later

| What | How |
| --- | --- |
| Site password, someone's password | Edit the Settings tab or the Password column in Team. Works right away |
| A new teammate | Add a row in Team (Gmail, Name, Password). Their Drive access is automatic: files are shared by link |
| The website | Edit, commit, push. Live in about a minute |
| The backend | Paste the new `Code.gs`, then **Deploy › Manage deployments** › pencil › Version: **New version** › Deploy. The URL stays the same |

## How uploads work

1. The site asks the script to open an upload for each file. The script checks the task, works out the name (`CHR_BuckyDesign_Turnaround_01.png`) and the folder (`02_Art/Characters/CHR_BuckyDesign/01/`), and asks Drive for a one-time upload link.
2. The browser sends the file straight to Drive in 8 MB pieces, with a progress bar. A dropped piece is retried. If the browser can't reach Drive directly, it sends the pieces through the script instead (slower, same result).
3. When every file is up, the script checks they arrived, sets them to **anyone with the link can view**, sets the task to Pending review, adds a Log row and tells Bucky.

Approving copies that version into `_Approved/`. Old versions are always kept.

Files over 100 MB show Google's "can't scan for viruses" page on download. That's normal, just click Download anyway.

## Security, honestly

- Passwords live in the sheet in plain text. Anyone who can open the sheet can read them.
- Everyone can sign in as anyone while they all use 1234. Fine for five people; give everyone their own password before outside people join.
- The backend acts with Eduardo's Drive, so keep the site password private.
- Files are shared by link: anyone who gets a file's link can open it.

## Files

```
index.html  style.css  app.js   the site (same design as the mockup)
bucky.js                        the goo Bucky
api.js                          talks to the backend, chunked uploads
config.js                       the backend URL
backend/Code.gs                 the Apps Script backend
dev/gas-mock.js, fixture.js     fake Google for ?mock and the tests
tests/backend.test.js           node tests/backend.test.js
```

## Performance

Bucky's goo is drawn with WebGL (`bucky.js`), which matches the old SVG filter look but runs on the graphics card. The old SVG version (`bucky-legacy.js`) is still there as a fallback for browsers without WebGL.

- `?fps` shows a frame counter in the corner.
- `?legacy` forces the old SVG goo, to compare.
