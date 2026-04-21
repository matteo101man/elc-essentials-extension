# ELC Essentials — source code & build

This add-on is written in **plain JavaScript, HTML, CSS, and JSON**. There is **no** bundler, minifier, transpiler, or template engine in the release pipeline.

**Manifests:** **`manifest.json`** is **Manifest V3** for **Google Chrome**. **`manifest-firefox.json`** is **Manifest V2** for **Mozilla Firefox** (AMO). The scripts (`content.js`, `background.js`, `popup.js`) are shared; only the manifest differs.

## Do you need a build step?

**No compilation is required** to run or inspect the extension. The files in this folder (plus `icons/`) **are** the runtime source.

For Mozilla reviewers: to produce the **exact submission ZIP** (same layout as releases), run the provided script below. It only packages files; it does not transform source code.

## What ships in the extension

| Path | Role |
|------|------|
| `manifest.json` | Chrome: Manifest V3 |
| `manifest-firefox.json` | Firefox: Manifest V2 (packaged as `manifest.json` in the Firefox ZIP) |
| `content.js` | Content script (UI + D2L page logic) |
| `background.js` | Background page (cross-origin fetch proxy, tab helpers) |
| `popup.html` / `popup.js` | Toolbar popup (enable/disable) |
| `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` | Toolbar / listing icons |

Optional assets (not required for the add-on to run; omit from ZIP if you want a minimal package):

- `ELC Essentials Icon.png` — source artwork
- `Screenshot *.png` — store listing screenshots only

## Third-party / machine-generated code

- **No** npm packages, webpack bundles, or minified vendor files are included in the distributed extension.
- **No** third-party JS libraries are embedded in `content.js`, `background.js`, or `popup.js`.

## Build environment requirements

| Requirement | Version | Notes |
|-------------|---------|--------|
| OS | Windows 10 or later, or any OS with PowerShell Core 7+ | Script below uses **PowerShell** and .NET compression APIs. |
| Node.js | **Not used** | N/A |
| npm | **Not used** | N/A |
| PowerShell | Windows PowerShell 5.1 (built into Windows) **or** PowerShell 7+ | Uses `System.IO.Compression.ZipFile`. |

## Step-by-step: build the Chrome Web Store ZIP (Manifest V3)

1. Open a terminal **in this directory** (next to `manifest.json` and `build-chrome-zip.ps1`).
2. Run:

   ```powershell
   powershell.exe -ExecutionPolicy Bypass -File .\build-chrome-zip.ps1
   ```

3. Output: **`ELC-Essentials-Chrome.zip`** on the **parent** folder (e.g. Desktop). Upload that ZIP to the Chrome Web Store. Store listing text and privacy justifications: see **`CHROME_WEB_STORE_LISTING.md`**.

## Step-by-step: build the Firefox submission ZIP (Manifest V2)

1. Open a terminal **in this directory** (next to `manifest-firefox.json` and `build-amozip.ps1`).
2. Run:

   ```powershell
   powershell.exe -ExecutionPolicy Bypass -File .\build-amozip.ps1
   ```

3. Output file: **`ELC-Essentials-Firefox.zip`** in the **parent** folder. The ZIP contains **`manifest.json`** built from **`manifest-firefox.json`** (correct entry name for AMO).

The script:

- Adds only extension files (manifest, scripts, popup, icons).
- Uses **forward slashes** inside the ZIP (`icons/icon16.png`) so **addons.mozilla.org** validation accepts the archive (Windows “Compress” often uses backslashes and fails).

## Reproducing the same output without PowerShell

Create a ZIP manually with the same files as the scripts above. For **Chrome**, the root `manifest.json` must be **Manifest V3**. For **Firefox**, use the contents of **`manifest-firefox.json`** as **`manifest.json`** inside the ZIP. Ensure archive entry names use `/`, not `\`.

## Version shown in the built package

Bump the `"version"` field in **`manifest.json`** (Chrome) and **`manifest-firefox.json`** (Firefox) together when you release.
