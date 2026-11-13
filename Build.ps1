param(
    [switch] $PrepareOnly
)

$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$distRoot = [IO.Path]::GetFullPath((Join-Path $sourceRoot 'dist'))
$outputDir = [IO.Path]::GetFullPath((Join-Path $distRoot 'CodexCodeCheck'))
$outputExe = Join-Path $outputDir 'CodexCodeCheck.exe'
$launchScript = Join-Path $sourceRoot 'Launch.ps1'

if (-not (Test-Path -LiteralPath $launchScript -PathType Leaf)) {
    throw 'Launch.ps1 is missing; cannot prepare the cached Electron runtime.'
}

$requiredFiles = @('package.json', 'main.cjs', 'preload.cjs', 'ui', 'lib')
foreach ($relativePath in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relativePath))) {
        throw "Required application source is missing: $relativePath"
    }
}

if (-not (Test-Path -LiteralPath $distRoot -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $distRoot
}
$resolvedDist = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $distRoot).ProviderPath).TrimEnd('\') + '\'
if (-not $outputDir.StartsWith($resolvedDist, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to write outside this project dist directory.'
}

if (Test-Path -LiteralPath $outputDir) {
    $existing = Get-Item -LiteralPath $outputDir -Force
    if (-not $existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The output path exists and is not a regular directory; refusing to replace it.'
    }
    foreach ($process in (Get-Process -Name 'CodexCodeCheck' -ErrorAction SilentlyContinue)) {
        try {
            if ([IO.Path]::GetFullPath($process.Path).Equals([IO.Path]::GetFullPath($outputExe), [StringComparison]::OrdinalIgnoreCase)) {
                throw "CodexCodeCheck is running from '$outputExe'. Close it before rebuilding; the process was left running."
            }
        } catch [System.Management.Automation.MethodInvocationException] {
            throw 'Could not verify whether the existing packaged app is running; refusing to replace it.'
        }
    }
}

# Launch.ps1 owns the Electron version, checksum, cache lookup, and unpacking.
# Its fast path uses the verified local runtime cache without downloading anything.
$prepareOutput = @(& $launchScript -PrepareOnly)
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Launch.ps1 could not prepare Electron.' }
$electronExe = $prepareOutput | Where-Object { $_ -is [string] -and $_.Trim() } | Select-Object -Last 1
if (-not $electronExe) { throw 'Launch.ps1 did not return an Electron executable path.' }
$electronExe = [IO.Path]::GetFullPath($electronExe.Trim())
$runtimeDir = Split-Path -Parent $electronExe
if ((Split-Path -Leaf $electronExe) -ne 'electron.exe' -or -not (Test-Path -LiteralPath $electronExe -PathType Leaf)) {
    throw "The prepared Electron executable is missing: $electronExe"
}

if ($PrepareOnly) {
    Write-Output $electronExe
    return
}

$stageName = '.CodexCodeCheck-stage-' + [guid]::NewGuid().ToString('N')
$stageDir = [IO.Path]::GetFullPath((Join-Path $distRoot $stageName))
if (-not $stageDir.StartsWith($resolvedDist, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to stage package outside this project dist directory.'
}
$stageCreated = $false
$backupDir = $null
try {
    $null = New-Item -ItemType Directory -Path $stageDir
    $stageCreated = $true
    foreach ($entry in (Get-ChildItem -LiteralPath $runtimeDir -Force)) {
        Copy-Item -LiteralPath $entry.FullName -Destination $stageDir -Recurse -Force
    }

    $resourcesDir = Join-Path $stageDir 'resources'
    if (-not (Test-Path -LiteralPath $resourcesDir -PathType Container)) {
        throw 'The Electron runtime has no resources directory.'
    }
    $appDir = Join-Path $resourcesDir 'app'
    $null = New-Item -ItemType Directory -Path $appDir
    foreach ($relativePath in $requiredFiles) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot $relativePath) -Destination $appDir -Recurse -Force
    }
    $scriptsDir = Join-Path $sourceRoot 'scripts'
    if (Test-Path -LiteralPath $scriptsDir -PathType Container) {
        Copy-Item -LiteralPath $scriptsDir -Destination $appDir -Recurse -Force
    }

    $stagedElectron = Join-Path $stageDir 'electron.exe'
    if (-not (Test-Path -LiteralPath $stagedElectron -PathType Leaf)) {
        throw 'Electron runtime staging did not contain electron.exe.'
    }
    Rename-Item -LiteralPath $stagedElectron -NewName 'CodexCodeCheck.exe'
    if ((-not (Test-Path -LiteralPath (Join-Path $appDir 'package.json') -PathType Leaf)) -or (-not (Test-Path -LiteralPath (Join-Path $appDir 'main.cjs') -PathType Leaf))) {
        throw 'The packaged Electron app is missing its manifest or main entrypoint.'
    }

    if (Test-Path -LiteralPath $outputDir) {
        $backupName = '.CodexCodeCheck-previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N')
        $backupDir = [IO.Path]::GetFullPath((Join-Path $distRoot $backupName))
        if (-not $backupDir.StartsWith($resolvedDist, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to move an existing package outside this project dist directory.'
        }
        Move-Item -LiteralPath $outputDir -Destination $backupDir
    }

    try {
        Move-Item -LiteralPath $stageDir -Destination $outputDir
        $stageCreated = $false
    } catch {
        if ($backupDir -and (Test-Path -LiteralPath $backupDir) -and -not (Test-Path -LiteralPath $outputDir)) {
            Move-Item -LiteralPath $backupDir -Destination $outputDir
            $backupDir = $null
        }
        throw
    }

    Write-Output $outputExe
} finally {
    if ($stageCreated -and (Test-Path -LiteralPath $stageDir)) {
        $resolvedStage = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $stageDir).ProviderPath)
        if ($resolvedStage.StartsWith($resolvedDist, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedStage).StartsWith('.CodexCodeCheck-stage-', [StringComparison]::Ordinal)) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
