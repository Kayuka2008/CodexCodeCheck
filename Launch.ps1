param(
    [Parameter(Position = 0)] [string] $Repository,
    [switch] $PrepareOnly
)

$ErrorActionPreference = 'Stop'
$reviewDeskVersion = '43.3.0'
$reviewDeskArch = switch ($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) {
    'ARM64' { 'arm64'; break }
    'AMD64' { 'x64'; break }
}
$reviewDeskHash = @{
    x64 = '18528bedc6a9b04bdc5efb7b803cbc3cb0e5ea6415d54046e23d464d89a00da9'
    arm64 = 'b315ea6feef1ee8bedc01c28ae2f89c0631f4521f888dcbecb9bdb28281c37e7'
}
if (-not $reviewDeskArch) { throw 'Codex Review Desk requires x64 or ARM64 Windows.' }

$reviewDeskCache = Join-Path $env:LOCALAPPDATA 'CodexReviewDesk\runtime'
$reviewDeskPackage = "electron-v$reviewDeskVersion-win32-$reviewDeskArch"
$reviewDeskInstall = Join-Path $reviewDeskCache $reviewDeskPackage
$reviewDeskExe = Join-Path $reviewDeskInstall 'electron.exe'
$reviewDeskMarker = Join-Path $reviewDeskInstall '.ready'

if (-not (Test-Path -LiteralPath $reviewDeskExe -PathType Leaf) -or -not (Test-Path -LiteralPath $reviewDeskMarker -PathType Leaf)) {
    $null = New-Item -ItemType Directory -Path $reviewDeskCache -Force
    $reviewDeskZip = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'electron\Cache') -Filter "$reviewDeskPackage.zip" -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -eq $reviewDeskHash[$reviewDeskArch] } |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $reviewDeskZip) {
        $reviewDeskZip = Join-Path $reviewDeskCache "$reviewDeskPackage.zip"
        Write-Host "Downloading Electron $reviewDeskVersion (one-time setup)..."
        $reviewDeskUrl = "https://github.com/electron/electron/releases/download/v$reviewDeskVersion/$reviewDeskPackage.zip"
        & curl.exe --fail --location --retry 2 --connect-timeout 12 --max-time 180 --output $reviewDeskZip $reviewDeskUrl
        if ($LASTEXITCODE -ne 0) { throw 'Electron download failed. Check your connection and run Launch.cmd again.' }
        if ((Get-FileHash -LiteralPath $reviewDeskZip -Algorithm SHA256).Hash -ne $reviewDeskHash[$reviewDeskArch]) {
            throw 'Electron download did not match the expected SHA-256 checksum.'
        }
    }
    Write-Host "Preparing Electron $reviewDeskVersion..."
    $null = New-Item -ItemType Directory -Path $reviewDeskInstall -Force
    & tar.exe -xf $reviewDeskZip -C $reviewDeskInstall
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $reviewDeskExe -PathType Leaf)) { throw 'Could not unpack Electron.' }
    Set-Content -LiteralPath $reviewDeskMarker -Value $reviewDeskVersion -Encoding Ascii
}

if ($PrepareOnly) { Write-Output $reviewDeskExe; return }

if ($Repository) { $env:CODEX_REVIEW_REPOSITORY = (Resolve-Path -LiteralPath $Repository).ProviderPath }
if (-not $env:CODEX_REVIEW_CLI) {
    $reviewDeskCli = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($reviewDeskCli) { $env:CODEX_REVIEW_CLI = $reviewDeskCli.Source }
    else {
        $reviewDeskApp = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($reviewDeskApp) {
            $reviewDeskBundled = Join-Path $reviewDeskApp.InstallLocation 'app\resources\codex.exe'
            if (Test-Path -LiteralPath $reviewDeskBundled -PathType Leaf) { $env:CODEX_REVIEW_CLI = $reviewDeskBundled }
        }
    }
}
Remove-Item -LiteralPath Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath $reviewDeskExe -WorkingDirectory $PSScriptRoot -ArgumentList '.' -WindowStyle Normal
