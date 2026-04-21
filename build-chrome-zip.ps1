# ELC Essentials — Chrome Web Store ZIP (Manifest V3).
# Packages manifest.json (MV3), scripts, popup, icons. Entry paths use forward slashes.
#
# Usage (from this directory):
#   powershell.exe -ExecutionPolicy Bypass -File .\build-chrome-zip.ps1
#
# Output: ..\ELC-Essentials-Chrome.zip

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$outZip = Join-Path (Split-Path $here -Parent) 'ELC-Essentials-Chrome.zip'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$files = @(
    @{ Path = Join-Path $here 'manifest.json';    Entry = 'manifest.json' }
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
