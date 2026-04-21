# ELC Essentials — AMO-compatible ZIP packager (no minification or transpilation).
# Packages manifest-firefox.json AS manifest.json inside the ZIP (Manifest V2 for Firefox).
# Chrome Web Store uses manifest.json MV3 — use build-chrome-zip.ps1 instead.
#
# Requires: Windows PowerShell 5.1+ or PowerShell 7+ on Windows.
#
# Usage (from this directory):
#   powershell.exe -ExecutionPolicy Bypass -File .\build-amozip.ps1
#
# Output: ..\ELC-Essentials-Firefox.zip (manifest.json at archive root, forward slashes)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$outZip = Join-Path (Split-Path $here -Parent) 'ELC-Essentials-Firefox.zip'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$files = @(
    @{ Path = Join-Path $here 'manifest-firefox.json';    Entry = 'manifest.json' }
    @{ Path = Join-Path $here 'background.js';    Entry = 'background.js' }
    @{ Path = Join-Path $here 'content.js';       Entry = 'content.js' }
    @{ Path = Join-Path $here 'popup.html';      Entry = 'popup.html' }
    @{ Path = Join-Path $here 'popup.js';        Entry = 'popup.js' }
    @{ Path = Join-Path $here 'icons\icon16.png'; Entry = 'icons/icon16.png' }
    @{ Path = Join-Path $here 'icons\icon48.png'; Entry = 'icons/icon48.png' }
    @{ Path = Join-Path $here 'icons\icon128.png'; Entry = 'icons/icon128.png' }
)

foreach ($f in $files) {
    if (-not (Test-Path -LiteralPath $f.Path)) {
        Write-Error "Missing required file: $($f.Path)"
    }
}

if (Test-Path -LiteralPath $outZip) {
    Remove-Item -LiteralPath $outZip -Force
}

$archive = [System.IO.Compression.ZipFile]::Open($outZip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($f in $files) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $f.Path,
            $f.Entry
        ) | Out-Null
    }
}
finally {
    $archive.Dispose()
}

Write-Host "Wrote: $outZip"
