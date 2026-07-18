# Zips bridge/ → web/bridge.zip so machines can self-install from the hub URL.
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$bridge = Join-Path $root 'bridge'
$out = Join-Path $root 'web\bridge.zip'
if (Test-Path $out) { Remove-Item $out -Force }
$files = Get-ChildItem $bridge -Recurse -File | Where-Object {
  $_.FullName -notmatch '\\node_modules\\' -and
  $_.FullName -notmatch '\\data\\' -and
  $_.Name -ne 'config.json'
}
Compress-Archive -Path ($files.FullName) -DestinationPath $out -Force
# Compress-Archive flattens paths when given files; re-do preserving structure via staging
Remove-Item $out -Force
$stage = Join-Path $env:TEMP "ms-bridge-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force "$stage\lib" | Out-Null
Copy-Item "$bridge\*.js*" $stage -ErrorAction SilentlyContinue
Copy-Item "$bridge\package.json" $stage
Copy-Item "$bridge\config.example.json" $stage
Copy-Item "$bridge\install.ps1" $stage
Copy-Item "$bridge\run-hidden.vbs" $stage
Copy-Item "$bridge\lib\*" "$stage\lib\"
Compress-Archive -Path "$stage\*" -DestinationPath $out -Force
Remove-Item $stage -Recurse -Force
Write-Host "packed → $out"
