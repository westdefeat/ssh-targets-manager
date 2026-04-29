param(
    [ValidateSet("auto", "cursor", "code", "trae")]
    [string]$Editor = "auto"
)

$ErrorActionPreference = "Stop"

# Always run from the repository root, even when called from another directory.
Set-Location $PSScriptRoot

# Read the extension name and version from package.json.
$pkg = Get-Content -Raw "$PSScriptRoot\package.json" | ConvertFrom-Json
$extId = "$($pkg.publisher).$($pkg.name)"

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

function Resolve-EditorCommand {
    param([string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $knownPaths = switch ($Name) {
        "cursor" {
            @(
                "$env:LOCALAPPDATA\Programs\Cursor\resources\app\bin\cursor.cmd",
                "$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd"
            )
        }
        "code" {
            @(
                "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
                "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd",
                "${env:ProgramFiles(x86)}\Microsoft VS Code\bin\code.cmd"
            )
        }
        "trae" {
            @(
                "$env:LOCALAPPDATA\Programs\Trae\bin\trae.cmd",
                "$env:LOCALAPPDATA\Programs\Trae CN\bin\trae.cmd"
            )
        }
    }

    foreach ($path in $knownPaths) {
        if (Test-Path $path) {
            return $path
        }
    }

    return $null
}

Write-Host "Packaging $extId@$($pkg.version)..." -ForegroundColor Cyan
npm run package
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$vsix = Get-ChildItem -Path $PSScriptRoot -Filter "$($pkg.name)-$($pkg.version).vsix" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $vsix) {
    Write-Host "Error: packaged VSIX not found." -ForegroundColor Red
    exit 1
}

$candidateEditors = if ($Editor -eq "auto") {
    @("cursor", "code", "trae")
} else {
    @($Editor)
}

$editorCommand = $null
$editorName = $null
foreach ($candidate in $candidateEditors) {
    $resolved = Resolve-EditorCommand $candidate
    if ($resolved) {
        $editorCommand = $resolved
        $editorName = $candidate
        break
    }
}

if (-not $editorCommand) {
    Write-Host "Error: no supported editor CLI found." -ForegroundColor Red
    Write-Host "Install one of these CLIs or run manually:" -ForegroundColor Yellow
    Write-Host "  cursor --install-extension `"$($vsix.FullName)`" --force"
    Write-Host "  code --install-extension `"$($vsix.FullName)`" --force"
    exit 1
}

Write-Host "Installing $($vsix.Name) into $editorName..." -ForegroundColor Cyan
& $editorCommand --install-extension $vsix.FullName --force
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Done! Reload $editorName to apply the extension." -ForegroundColor Green