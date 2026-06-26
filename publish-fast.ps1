# Fast LOCAL build — win-x64 only, for the dev loop. NOT a release (use publish.ps1 for all
# platforms + single-file zips). Non-single-file self-contained: faster than single-file (no
# bundle/compress) and the loose wwwroot beside the exe is served directly. Kills the old
# instance first — a stale dingoConfig process keeps serving old files and 404s after a rebuild.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$out  = Join-Path $root 'publish\fast-win-x64'

Write-Host 'Building SPA (web/clientapp -> web/wwwroot)...' -ForegroundColor Yellow
Push-Location (Join-Path $root 'web\clientapp')
npm run build
$spa = $LASTEXITCODE
Pop-Location
if ($spa -ne 0) { Write-Error 'SPA build failed'; exit 1 }

# Stop the running instance FIRST — it locks its own dingoConfig.dll/exe in the output dir, which
# makes the publish copy fail (MSB3021). Then publish into the freed directory and relaunch.
Get-Process dingoConfig -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host 'Publishing win-x64 (self-contained)...' -ForegroundColor Yellow
dotnet publish (Join-Path $root 'web\web.csproj') -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=false -p:DebugType=none -o $out -v q --nologo
if ($LASTEXITCODE -ne 0) { Write-Error 'publish failed'; exit 1 }

Start-Process (Join-Path $out 'dingoConfig.exe')
Write-Host 'dingoConfig (fast build) starting on http://localhost:5000' -ForegroundColor Green
