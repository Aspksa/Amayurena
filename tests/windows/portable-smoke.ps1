$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$portable = Join-Path $env:RUNNER_TEMP "Amayurena Проверка & Portable"
if (Test-Path -LiteralPath $portable) { Remove-Item -LiteralPath $portable -Recurse -Force }
New-Item -ItemType Directory -Path $portable | Out-Null
$allowed = @(".js", ".css", ".html", ".bat", ".md", ".json", ".svg")
Get-ChildItem -LiteralPath $root -File | Where-Object { $allowed -contains $_.Extension.ToLowerInvariant() } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $portable }
if (Test-Path (Join-Path $root "assets/avatars")) {
  New-Item -ItemType Directory -Path (Join-Path $portable "assets/avatars") -Force | Out-Null
  Get-ChildItem (Join-Path $root "assets/avatars") -File | Where-Object { @(".avif",".webp",".svg",".png") -contains $_.Extension.ToLowerInvariant() } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $portable "assets/avatars") }
}
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$env:AMAYURENA_PORT = "$port"
$env:AMAYURENA_NO_BROWSER = "1"
$env:AMAYURENA_NO_SELF_UPDATE = "1"
$log = Join-Path $portable "stdout.log"
$err = Join-Path $portable "stderr.log"
$exe = (Get-Command node).Source
$server = $null
$base = "http://127.0.0.1:$port"
try {
  $server = Start-Process -FilePath $exe -ArgumentList @("server.js") -WorkingDirectory $portable -PassThru -RedirectStandardOutput $log -RedirectStandardError $err
  $ready = $false
  for ($i = 0; $i -lt 55; $i++) {
    Start-Sleep -Milliseconds 250
    if ($server.HasExited) { throw "Server exited prematurely: $($server.ExitCode)" }
    try {
      $response = Invoke-WebRequest -Uri "$base/api/status" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) { throw "Portable server did not start." }
  $page = Invoke-WebRequest -Uri "$base/"
  if ($page.StatusCode -ne 200 -or $page.Content -notmatch "Amayurena") { throw "HTML smoke test failed." }
  $noteName = "Проверка Windows.md"
  $body = @{ path = $noteName; content = ("# Проверка Windows" + [Environment]::NewLine + "Сохранение из Unicode & portable.") } | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  $created = Invoke-RestMethod -Uri "$base/api/knowledge/note/create" -Method Post -ContentType "application/json; charset=utf-8" -Body $bytes
  $encoded = [Uri]::EscapeDataString($noteName)
  $note = Invoke-RestMethod -Uri "$base/api/knowledge/note?path=$encoded"
  if ($note.content -notmatch "Unicode & portable") { throw "Unicode knowledge save/read failed." }
  $catalog = Invoke-RestMethod -Uri "$base/api/knowledge/map/catalog"
  if ($catalog.total -lt 1) { throw "Knowledge map does not include new file." }
  $canvases = Invoke-RestMethod -Uri "$base/api/knowledge/canvases"
  $bases = Invoke-RestMethod -Uri "$base/api/knowledge/bases"
  $logText = Get-Content -LiteralPath $log -Raw -Encoding UTF8
  if ($logText -notmatch "127.0.0.1:$port") { throw "Localhost binding not confirmed." }
  Write-Host "Windows portable smoke: PASS; path=$portable, notes=$($catalog.total), no elevation."
} finally {
  if ($null -ne $server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    $server.WaitForExit(5000) | Out-Null
  }
  if (Test-Path -LiteralPath $err) {
    $stderr = Get-Content -LiteralPath $err -Raw -Encoding UTF8
    if ($stderr) { Write-Host "Server stderr: $stderr" }
  }
}
