# Read the extension name and version from package.json.
$pkg = Get-Content -Raw "$PSScriptRoot\package.json" | ConvertFrom-Json
$extId = "$($pkg.publisher).$($pkg.name)-$($pkg.version)"

# Ensure npm is available from PATH or common installation locations.
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    $candidates = @(
        "$env:ProgramFiles\nodejs",
        "${env:ProgramFiles(x86)}\nodejs",
        "$env:APPDATA\nvm\current"
    )
    foreach ($dir in $candidates) {
        if (Test-Path "$dir\npm.cmd") {
            $env:PATH = "$dir;$env:PATH"
            break
        }
    }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "Error: npm not found. Please install Node.js or add it to PATH." -ForegroundColor Red
    exit 1
}

npm run compile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Locate installed extension directories for Cursor, VS Code, and Trae CN.
$extDirs = @(
    "$env:USERPROFILE\.cursor\extensions",
    "$env:USERPROFILE\.vscode\extensions"
    "$env:USERPROFILE\.trae-cn\extensions"
)

$installed = $false
foreach ($base in $extDirs) {
    $target = Join-Path $base $extId
    if (Test-Path $target) {
        $outDir = Join-Path $target "out"
        Copy-Item -Path "out\*" -Destination $outDir -Recurse -Force
        Write-Host "Installed to: $target" -ForegroundColor Green
        $installed = $true
    }
}

if (-not $installed) {
    Write-Host "Warning: Extension folder not found for '$extId'." -ForegroundColor Yellow
    Write-Host "Searched in:" -ForegroundColor Yellow
    foreach ($base in $extDirs) { Write-Host "  $(Join-Path $base $extId)" }
    Write-Host "You can install the extension first via: npm run package" -ForegroundColor Yellow
    exit 1
}

Write-Host "Done! Reload window to apply."