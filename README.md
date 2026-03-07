# Google Sheets Clean Embed Wrapper

A single HTML page that wraps a Google Sheets embed URL and strips the Google branding footer — making your spreadsheet tables integrate cleanly into Notion notes or any other page that supports iframe embeds.

---

## The Problem

Google Sheets provides two embed endpoints (`pubhtml` and `gviz`), but both inject a "Google Docs Embed" branding footer at the bottom of the iframe that cannot be removed via URL parameters. This wrapper clips that footer using CSS, giving you a clean, borderless table view.

---

## Setup

1. Create a free [GitHub](https://github.com) account if you don't have one.
2. Create a new repository and enable **GitHub Pages** under *Settings → Pages → Deploy from branch → main → / (root)*.
3. Add the `index.html` file from this project to the root of that repository.
4. Your wrapper will be live at:
   ```
   https://yourusername.github.io/your-repo-name/
   ```

---

## Usage

There are three ways to use the wrapper, from most flexible to most hardcoded.

---

### Option A — Pass a Full Pre-Encoded URL

Encode your Google Sheets embed URL and pass it as a `?url=` parameter.

```
https://yourusername.github.io/your-repo/?url=ENCODED_URL
```

Use [urlencoder.org](https://www.urlencoder.org) to encode your Google Sheets URL, then append the result after `?url=`.

**Example:**
```
https://yourusername.github.io/your-repo/?url=https%3A%2F%2Fdocs.google.com%2Fspreadsheets%2Fd%2Fe%2F2PACX-...%2Fpubhtml%3Fgid%3D1058408808%26range%3DB4%3AG14
```

---

### Option B — Pass Individual URL Parameters

Pass the components of the Google Sheets URL as separate query parameters. No URL encoding needed.

```
https://yourusername.github.io/your-repo/?key=PUBLISHED_KEY&gid=GID_NUMBER&range=B4:G14
```

#### Required Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `key` | The `2PACX-...` key from your published Google Sheets URL | `2PACX-1vS_3h...` |
| `gid` | The sheet tab ID from the URL after `gid=` | `1058408808` |

#### Optional Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `range` | *(full sheet)* | Cell range to display | `B4:G14` |
| `widget` | `false` | Show sheet tabs at the bottom | `true` or `false` |
| `headers` | `false` | Show row numbers and column letters | `true` or `false` |
| `chrome` | `false` | Show the spreadsheet title and top chrome | `true` or `false` |

**Example — specific range:**
```
?key=2PACX-1vS_3h...&gid=1058408808&range=B4:G14
```

**Example — full sheet with defaults:**
```
?key=2PACX-1vS_3h...&gid=1058408808
```

**Example — full sheet, show tab bar:**
```
?key=2PACX-1vS_3h...&gid=1058408808&widget=true
```

---

### Option C — Hardcode Variables in the HTML

For a dedicated single-table page, edit the variables at the top of the `<script>` block in `index.html`:

```javascript
const PUBLISHED_KEY = '2PACX-1vS_3h...';  // Your published key
const GID           = '1058408808';         // Sheet tab ID
const RANGE         = 'B4:G14';            // Leave empty '' for full sheet
const WIDGET        = false;               // Show sheet tabs
const HEADERS       = false;               // Show row/column headers
const CHROME        = false;               // Show title chrome
```

Leave `PUBLISHED_KEY` empty to fall back to Option A or B URL parameters.

---

## How to Get Your Published Key and GID

### Published Key (`2PACX-...`)

1. Open your Google Sheet.
2. Go to **File → Share → Publish to the web**.
3. Select **Embed** tab, choose your sheet, and click **Publish**.
4. Copy the generated URL. It will look like:
   ```
   https://docs.google.com/spreadsheets/d/e/2PACX-1vS.../pubhtml
   ```
5. The `2PACX-...` portion between `/e/` and `/pubhtml` is your published key.

### Sheet Tab ID (`gid`)

Open your sheet in edit mode. The URL will contain `#gid=` or `gid=` followed by a number:
```
https://docs.google.com/spreadsheets/d/.../edit?gid=1058408808#gid=1058408808
```
That number (`1058408808`) is your GID.

---

## Embedding in Notion

1. In your Notion page, type `/embed` and select the **Embed** block.
2. Paste your wrapper URL (using Option A, B, or C above).
3. Press **Enter** to confirm.
4. Resize the embed block to fit your table by dragging the bottom edge.

**Tip:** For Option B, you can create multiple embed blocks on the same Notion page each pointing to a different range or sheet tab, all using the same single wrapper page — just change the `range` and `gid` parameters in each URL.

---

## Caching

The wrapper includes cache-busting headers and appends a timestamp (`&_t=`) to the iframe source URL on every load, ensuring the browser always fetches fresh data from Google Sheets rather than serving a stale cached version.

> Note: Google Sheets itself may have a few minutes of propagation delay after you save changes before they appear in the embed.

---

## Limitations

- The Google Sheets document must be **published to the web** (via *File → Share → Publish to the web*) for the embed to be publicly accessible.
- The embed is **read-only**. To edit the data, open the original Google Sheet directly.
- Very large sheets or ranges may be slow to load depending on Google's servers.
- Google Workspace accounts managed by an organization may have publishing disabled by an administrator.
