# Builds target\dova-<version>-x64.msi from a release build.
# Needs the WiX toolset on PATH:  dotnet tool install --global wix --version 5.0.2
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$version = (cargo metadata --no-deps --format-version 1 | ConvertFrom-Json).packages[0].version
cargo build --release --locked
if ($LASTEXITCODE) { exit $LASTEXITCODE }

$msi = "target\dova-$version-x64.msi"
wix build packaging\windows\dova.wxs -arch x64 -d "Version=$version" -d "Binary=target\release\dova.exe" -o $msi
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Write-Host "Built $msi"
