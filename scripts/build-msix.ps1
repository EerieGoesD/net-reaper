param(
  [string]$Version = "",
  [ValidateSet("x64", "arm64")]
  [string]$Architecture = "x64"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$TauriDir = Join-Path $Root "src-tauri"

if (-not $Version) {
  $conf = Get-Content -Raw -LiteralPath (Join-Path $TauriDir "tauri.conf.json") | ConvertFrom-Json
  $Version = "$($conf.version).0"
}

# makeappx/makepri are host tools (makepri has no ARM build), so always look
# them up under x64 whatever we are packaging for.
$ToolArch = "x64"

$Triple = if ($Architecture -eq "arm64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }
# A cross-compiled build lands in target\<rust-target>\release, not target\release.
$ReleaseDir = if ($Architecture -eq "arm64") {
  Join-Path $TauriDir "target\$Triple\release"
} else {
  Join-Path $TauriDir "target\release"
}
$ManifestSrc = Join-Path $Root "msix\AppxManifest.xml"
$AssetsSrc = Join-Path $Root "msix\Assets"
$DistRoot = Join-Path $Root "msix-dist"
$LayoutDir = Join-Path $DistRoot "layout"
$AssetsDir = Join-Path $LayoutDir "Assets"
$PackagePath = Join-Path $DistRoot "NetReaper_$($Version)_$($Architecture).msix"

function Find-WindowsKitTool {
  param([string]$ToolName)
  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (-not (Test-Path $kitsRoot)) {
    throw "Windows Kits folder not found. Install the Windows SDK (MSIX packaging tools)."
  }
  $versions = Get-ChildItem -LiteralPath $kitsRoot -Directory | Sort-Object Name -Descending
  foreach ($version in $versions) {
    $candidate = Join-Path $version.FullName "$ToolArch\$ToolName"
    if (Test-Path $candidate) { return $candidate }
  }
  throw "$ToolName not found under $kitsRoot"
}

New-Item -ItemType Directory -Force -Path $DistRoot | Out-Null

# BoringSSL (boring-sys, via wreq) is built with CMake, which must know the
# installed Visual Studio. Use the CMake that ships with Visual Studio itself.
$vsCmake = Get-ChildItem -Path "${env:ProgramFiles}\Microsoft Visual Studio\*\*\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if ($vsCmake) { $env:CMAKE = $vsCmake.FullName }

# 1. The browser extension's native host for this architecture. tauri-build
# refuses to compile while the sidecar file is missing, so a placeholder goes
# in first and the real binary replaces it.
$BinDir = Join-Path $TauriDir "binaries"
$Sidecar = Join-Path $BinDir "net-reaper-host-$Triple.exe"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
if (-not (Test-Path $Sidecar)) { New-Item -ItemType File -Path $Sidecar | Out-Null }
Push-Location $TauriDir
try {
  if ($Architecture -eq "arm64") { cargo build --release --bin net-reaper-host --target $Triple }
  else { cargo build --release --bin net-reaper-host }
  if ($LASTEXITCODE -ne 0) { throw "native host build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
Copy-Item -LiteralPath (Join-Path $ReleaseDir "net-reaper-host.exe") -Destination $Sidecar -Force

# 2. The app itself, always rebuilt so a stale exe is never packaged. The
# native host is already built above, so tauri.conf's beforeBuildCommand
# (x64 only) is switched off for this build.
$NoBefore = Join-Path $DistRoot "tauri.msix.json"
Set-Content -LiteralPath $NoBefore -Value '{ "build": { "beforeBuildCommand": null } }' -Encoding UTF8
Push-Location $Root
try {
  if ($Architecture -eq "arm64") { cargo tauri build --no-bundle --target $Triple --config $NoBefore }
  else { cargo tauri build --no-bundle --config $NoBefore }
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location; Remove-Item -LiteralPath $NoBefore -Force -ErrorAction SilentlyContinue }

$AppExe = Join-Path $ReleaseDir "net-reaper.exe"
$HostExe = Join-Path $ReleaseDir "net-reaper-host.exe"
foreach ($f in @($AppExe, $HostExe)) { if (-not (Test-Path $f)) { throw "Missing build output: $f" } }

# 3. Stage the package layout: both exes + Assets + manifest.
if (Test-Path $LayoutDir) { Remove-Item -LiteralPath $LayoutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null
Copy-Item -LiteralPath $AppExe -Destination $LayoutDir -Force
Copy-Item -LiteralPath $HostExe -Destination $LayoutDir -Force
Copy-Item -Path (Join-Path $AssetsSrc "*.png") -Destination $AssetsDir -Force

$manifest = Get-Content -Raw -LiteralPath $ManifestSrc
$manifest = $manifest -replace '(<Identity[^>]*?\sVersion=")[^"]*(")', "`${1}$Version`${2}"
$manifest = $manifest -replace '(ProcessorArchitecture=")[^"]*(")', "`${1}$Architecture`${2}"
Set-Content -LiteralPath (Join-Path $LayoutDir "AppxManifest.xml") -Value $manifest -Encoding UTF8

# 4. The target-based "unplated" taskbar icons are qualified resource names, so
# the package needs a resource index or Windows ignores them and plates the icon.
$makePri = Find-WindowsKitTool "makepri.exe"
$PriConfig = Join-Path $DistRoot "priconfig.xml"
if (Test-Path $PriConfig) { Remove-Item -LiteralPath $PriConfig -Force }
& $makePri createconfig /cf $PriConfig /dq en-US /o
if ($LASTEXITCODE -ne 0) { throw "makepri createconfig failed with exit code $LASTEXITCODE" }
& $makePri new /pr $LayoutDir /cf $PriConfig /of (Join-Path $LayoutDir "resources.pri") /o
if ($LASTEXITCODE -ne 0) { throw "makepri new failed with exit code $LASTEXITCODE" }
Remove-Item -LiteralPath $PriConfig -Force

# 5. Pack (unsigned; the Microsoft Store re-signs on submission).
$makeAppx = Find-WindowsKitTool "makeappx.exe"
& $makeAppx pack /d $LayoutDir /p $PackagePath /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }

Write-Host "MSIX created: $PackagePath"
