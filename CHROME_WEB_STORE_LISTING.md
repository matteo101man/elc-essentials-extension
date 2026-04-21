# Chrome Web Store — copy-paste for the listing & Privacy practices

Use **`build-chrome-zip.ps1`** to build **`ELC-Essentials-Chrome.zip`** (Manifest V3). For Firefox, use **`build-amozip.ps1`** (packages **`manifest-firefox.json`** as `manifest.json` inside the ZIP).

---

## Store listing (main tab)

**Language:** English (United States)

**Category:** Productivity (or Education if you prefer; pick one)

**Short description** (summary line):

ELC Essentials adds practice tests, a course schedule view, and a grade calculator on UGA D2L Brightspace (ELC).

**Detailed description** (full box; well over 25 characters):

ELC Essentials is a browser extension for students using the University of Georgia’s D2L Brightspace site (uga.view.usg.edu). It adds navigation entries for Practice Tests and Course Schedule, a projected grade calculator on the grades page, and optional features such as importing a schedule from Athena and loading practice exams from JSON. A toolbar popup lets you enable or disable the extension without removing it.

This extension is an independent project and is not affiliated with D2L, the University System of Georgia, or the University of Georgia. Use official course and grade information when decisions matter.

**Screenshot / video:** Upload at least one image. Use the files in **`store-screenshots/`** (1280×800 PNG). You can add up to five.

**Icon (listing):** In the graphic assets section, upload **`icons/icon128.png`** (or the full **`ELC Essentials Icon.png`** if you use a square master asset). The manifest already references 16 / 48 / 128 for the extension itself; the store often asks for a **promotional icon** separately—upload the same 128×128-style asset there if required.

---

## Privacy practices tab (justifications)

**Single purpose description**

This extension’s only purpose is to enhance the UGA D2L Brightspace (ELC) and related Athena pages with student tools: practice quizzes from local or imported data, a course schedule view, a projected grade calculator, and a toggle to enable or disable these features. It does not serve unrelated advertising or unrelated functionality.

**Justification — `storage`**

The extension uses `chrome.storage.local` to save the user’s enable/disable choice, cached practice exam data, course schedule data (including when syncing between the Athena and D2L sites), and similar settings so features work across sessions and tabs.

**Justification — `tabs`**

The extension uses the tabs API to switch to an open D2L tab and close the Athena tab after a schedule import, so the student returns to D2L without manual tab management. It may open D2L if no D2L tab is present.

**Justification — host permissions (uga.view.usg.edu, athena-prod.uga.edu, api.openai.com, GitHub raw/gist, localhost)**

- **uga.view.usg.edu** and **athena-prod.uga.edu:** Core functionality runs as content scripts on these sites (D2L UI and Athena import).
- **api.openai.com:** Only used when the user chooses optional AI-related features and provides their own API key; requests go through the extension background to complete quiz or explanation features.
- **raw.githubusercontent.com** and **gist.githubusercontent.com:** Optional loading of practice exam JSON from user-provided HTTPS URLs.
- **http://127.0.0.1/** and **http://localhost/**:** Optional development or local tools the user may configure.

**Justification — remote code**

The extension does not download or execute remote JavaScript. All executable code is contained in the uploaded package (`content.js`, `background.js`, `popup.js`). The service worker may use `fetch` to retrieve **data** (for example JSON or API responses) from the hosts listed above when the user uses those features; that is network data access, not remote code execution.

**Data usage / certification**

Certify in the dashboard that you comply with the developer programme policies. This extension stores data locally in the browser for extension features; optional calls to OpenAI or remote JSON URLs occur only when the user initiates those features and only to the hosts declared in the manifest.

---

## Checklist

- [ ] Upload **`ELC-Essentials-Chrome.zip`** built from **`build-chrome-zip.ps1`** (MV3).
- [ ] At least one **screenshot** from **`store-screenshots/`**.
- [ ] **Language** set to English (United States).
- [ ] **Category** selected.
- [ ] **Icon** in listing (128×128-style asset if the form asks separately from manifest icons).
- [ ] **Privacy** tab: single purpose + all justifications above + certification checkbox.
