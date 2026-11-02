# deploy.ps1: заливка на GitHub и проверка деплоя в Vercel.
#   .\deploy.ps1                      сохранить всё, отправить на GitHub, дождаться деплоя
#   .\deploy.ps1 -Message "что сделал"  то же, с твоей подписью коммита
#   .\deploy.ps1 -Redeploy            без коммита: заново запустить последний деплой в Vercel
# Токен Vercel лежит в файле .vercel-token рядом со скриптом (в git он не попадает).
param(
  [string]$Message = "",
  [switch]$Redeploy
)

$ErrorActionPreference = "Continue"
Set-Location -Path $PSScriptRoot
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Notify($title, $text, $kind) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $n = New-Object System.Windows.Forms.NotifyIcon
    if ($kind -eq "Error") { $n.Icon = [System.Drawing.SystemIcons]::Error } else { $n.Icon = [System.Drawing.SystemIcons]::Information }
    $n.Visible = $true
    $n.ShowBalloonTip(10000, $title, $text, $kind)
    Start-Sleep -Seconds 6
    $n.Dispose()
  } catch {}
}

function Get-Token {
  if ($env:VERCEL_TOKEN) { return $env:VERCEL_TOKEN.Trim() }
  $f = Join-Path $PSScriptRoot ".vercel-token"
  if (Test-Path $f) { return (Get-Content $f -Raw).Trim() }
  return $null
}

function Vercel($method, $path, $body) {
  $headers = @{ Authorization = "Bearer $script:Token" }
  $uri = "https://api.vercel.com$path"
  if ($body) {
    return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -ContentType "application/json" -Body ($body | ConvertTo-Json -Depth 5)
  }
  return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers
}

function Show-Errors($dep) {
  Write-Host ""
  Write-Host "Причина ошибки:" -ForegroundColor Red
  $shown = $false
  try {
    $full = Vercel "GET" "/v13/deployments/$($dep.uid)" $null
    if ($full.errorMessage) { Write-Host "  $($full.errorMessage)" -ForegroundColor Red; $shown = $true }
    elseif ($full.error -and $full.error.message) { Write-Host "  $($full.error.message)" -ForegroundColor Red; $shown = $true }
  } catch {}
  try {
    $events = Vercel "GET" "/v3/deployments/$($dep.uid)/events?limit=-1" $null
    $lines = @()
    foreach ($e in $events) {
      $t = $null
      if ($e.text) { $t = $e.text } elseif ($e.payload -and $e.payload.text) { $t = $e.payload.text }
      if ($t) { $lines += $t }
    }
    if ($lines.Count -gt 0) {
      Write-Host "Последние строки лога билда:" -ForegroundColor Yellow
      $lines | Select-Object -Last 15 | ForEach-Object { Write-Host "  $_" }
      $shown = $true
    }
  } catch {}
  if (-not $shown) { Write-Host "  Не удалось получить лог. Смотри: https://$($dep.url)" -ForegroundColor Yellow }
  return $null
}

function Start-Redeploy($dep) {
  try {
    $body = @{ name = $dep.name; deploymentId = $dep.uid; target = "production" }
    $new = Vercel "POST" "/v13/deployments?forceNew=1" $body
    Write-Host "Редеплой запущен: https://$($new.url)" -ForegroundColor Cyan
    return $new
  } catch {
    Write-Host "Не получилось запустить редеплой: $($_.Exception.Message)" -ForegroundColor Red
    return $null
  }
}

function Wait-Deployment($find) {
  $deadline = (Get-Date).AddMinutes(10)
  $last = ""
  while ((Get-Date) -lt $deadline) {
    $dep = & $find
    if ($dep) {
      $state = $dep.state
      if (-not $state) { $state = $dep.readyState }
      if ($state -ne $last) { Write-Host "Статус деплоя: $state"; $last = $state }
      if ($state -eq "READY" -or $state -eq "ERROR" -or $state -eq "CANCELED") { return $dep }
    } elseif ($last -ne "wait") { Write-Host "Жду, пока Vercel заметит коммит..."; $last = "wait" }
    Start-Sleep -Seconds 5
  }
  return $null
}

function Finish($dep) {
  if (-not $dep) {
    Write-Host "Деплой не завершился за 10 минут. Проверь Vercel вручную." -ForegroundColor Yellow
    Notify "Деплой: нет ответа" "Дольше 10 минут. Проверь Vercel." "Warning"
    return
  }
  $state = $dep.state
  if (-not $state) { $state = $dep.readyState }
  if ($state -eq "READY") {
    Write-Host ""
    Write-Host "ГОТОВО: деплой успешен. https://$($dep.url)" -ForegroundColor Green
    Notify "Деплой успешен" "Бот обновлён." "Info"
    return
  }
  Write-Host ""
  Write-Host "ДЕПЛОЙ УПАЛ (статус $state)." -ForegroundColor Red
  Show-Errors $dep
  Notify "Деплой упал" "Статус: $state. Подробности в окне скрипта." "Error"
  $ans = Read-Host "Запустить редеплой? (y/n)"
  if ($ans -eq "y" -or $ans -eq "Y" -or $ans -eq "д" -or $ans -eq "Д") {
    $new = Start-Redeploy $dep
    if ($new) {
      $id = $new.id
      if (-not $id) { $id = $new.uid }
      $res = Wait-Deployment { try { $d = Vercel "GET" "/v13/deployments/$id" $null; $d | Add-Member -NotePropertyName uid -NotePropertyValue $id -Force; $d } catch { $null } }
      if ($res -and $res.readyState -eq "READY" -or ($res -and $res.state -eq "READY")) {
        Write-Host "ГОТОВО: редеплой успешен. https://$($res.url)" -ForegroundColor Green
        Notify "Редеплой успешен" "Бот обновлён." "Info"
      } else {
        Write-Host "Редеплой тоже не прошёл." -ForegroundColor Red
        if ($res) { Show-Errors $res }
        Notify "Редеплой упал" "Подробности в окне скрипта." "Error"
      }
    }
  }
}

$script:Token = Get-Token

if ($Redeploy) {
  if (-not $script:Token) { Write-Host "Нужен токен Vercel в файле .vercel-token" -ForegroundColor Red; exit 1 }
  $list = Vercel "GET" "/v6/deployments?limit=1&target=production" $null
  if (-not $list.deployments -or $list.deployments.Count -eq 0) { Write-Host "Деплоев не найдено." -ForegroundColor Red; exit 1 }
  $dep = $list.deployments[0]
  $new = Start-Redeploy $dep
  if ($new) {
    $id = $new.id
    if (-not $id) { $id = $new.uid }
    $res = Wait-Deployment { try { $d = Vercel "GET" "/v13/deployments/$id" $null; $d | Add-Member -NotePropertyName uid -NotePropertyValue $id -Force; $d } catch { $null } }
    if ($res -and ($res.readyState -eq "READY" -or $res.state -eq "READY")) {
      Write-Host "ГОТОВО: редеплой успешен. https://$($res.url)" -ForegroundColor Green
      Notify "Редеплой успешен" "Бот обновлён." "Info"
    } else {
      Write-Host "Редеплой не прошёл." -ForegroundColor Red
      if ($res) { Show-Errors $res }
      Notify "Редеплой упал" "Подробности в окне скрипта." "Error"
    }
  }
  exit 0
}

# 1. Коммит
git add -A
$changes = git status --porcelain
if ($changes) {
  if (-not $Message) {
    $Message = Read-Host "Подпись коммита (Enter = 'update')"
    if (-not $Message) { $Message = "update" }
  }
  git commit -m $Message
  if ($LASTEXITCODE -ne 0) { Write-Host "Коммит не удался." -ForegroundColor Red; exit 1 }
} else {
  Write-Host "Новых изменений нет, отправляю то, что уже сохранено."
}

# 2. Push
git push
if ($LASTEXITCODE -ne 0) {
  Write-Host "git push не удался (см. текст выше)." -ForegroundColor Red
  Notify "GitHub: ошибка" "git push не удался." "Error"
  exit 1
}
$sha = (git rev-parse HEAD).Trim()
Write-Host "Отправлено на GitHub: $($sha.Substring(0,7))" -ForegroundColor Green

# 3. Ждём Vercel
if (-not $script:Token) {
  Write-Host "Файла .vercel-token нет, статус деплоя не проверяю. Смотри Vercel вручную." -ForegroundColor Yellow
  Notify "Отправлено на GitHub" "Статус деплоя не проверяется (нет токена)." "Info"
  exit 0
}
$find = {
  try {
    $r = Vercel "GET" "/v6/deployments?limit=5&meta-githubCommitSha=$sha" $null
    if ($r.deployments -and $r.deployments.Count -gt 0) { return $r.deployments[0] }
  } catch { Write-Host "Ошибка запроса к Vercel: $($_.Exception.Message)" -ForegroundColor Yellow }
  return $null
}
$dep = Wait-Deployment $find
Finish $dep
