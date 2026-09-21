@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "DOUBAO_STOP_FILE=%~f0"
set "DOUBAO_STOP_ROOT=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:DOUBAO_STOP_FILE,[Text.Encoding]::UTF8); & ([scriptblock]::Create(($s -split '(?m)^# POWERSHELL_START\r?$',2)[1]))"
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
# POWERSHELL_START
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# 只检查本项目端口，不结束所有 Java 或浏览器进程。
$ports = @(48643, 48627)
$root = $env:DOUBAO_STOP_ROOT
$targets = @{}
$remaining = 0

function LocalJson($port, $path, $method = 'GET', $token = '') {
    $response = $null; $reader = $null
    try {
        $r = [Net.HttpWebRequest]::Create("http://127.0.0.1:$port$path")
        $r.Proxy = $null; $r.AllowAutoRedirect = $false
        $r.Timeout = 2500; $r.ReadWriteTimeout = 2500
        $r.Method = $method
        if ($token) { $r.Headers['Authorization'] = 'Bearer ' + $token }
        if ($method -eq 'POST') {
            $r.ContentType = 'application/json'; $r.ContentLength = 2
            $stream = $r.GetRequestStream()
            try { $stream.Write([byte[]]@(123, 125), 0, 2) } finally { $stream.Dispose() }
        }
        $response = $r.GetResponse()
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        return ($reader.ReadToEnd() | ConvertFrom-Json)
    } catch {
        if ($_.Exception.Response) { $_.Exception.Response.Close() }
        return $null
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Close() }
    }
}

try {
    Write-Host '正在停止逗包 / Java Stream Chat，当前生成会中断。'
    $config = Join-Path $root 'config\application.properties'
    if (Test-Path -LiteralPath $config) {
        foreach ($line in Get-Content -LiteralPath $config) {
            if ($line -match '^\s*server\.port\s*=\s*(\d+)\s*$') {
                $ports += [int]$matches[1]
            }
        }
    }
    if ($env:PORT -match '^\d{1,5}$') { $ports += [int]$env:PORT }
    $ports = @($ports | Where-Object { $_ -ge 1 -and $_ -le 65535 } | Select-Object -Unique)
    $token = ''
    $tokenFile = Join-Path $root 'data\local-token.txt'
    if (Test-Path -LiteralPath $tokenFile) {
        $token = [IO.File]::ReadAllText($tokenFile).Trim()
    }

    $processes = @(Get-CimInstance Win32_Process)
    $listeners = @(Get-NetTCPConnection | Where-Object { $_.State -eq 'Listen' })
    foreach ($port in $ports) {
        $owners = @($listeners | Where-Object { $_.LocalPort -eq $port -and
            $_.LocalAddress -in @('127.0.0.1', '0.0.0.0') } |
            Select-Object -ExpandProperty OwningProcess -Unique)
        foreach ($owner in $owners) {
            $p = $processes | Where-Object { $_.ProcessId -eq $owner } | Select-Object -First 1
            if (-not $p -or $p.Name -notin @('java.exe', 'javaw.exe')) {
                Write-Warning "端口 $port 不是可识别的 Java 后端，跳过 PID=$owner。"
                continue
            }
            $h = LocalJson $port '/health'
            $modern = $h -and $h.ok -eq $true -and $h.port -eq $port -and $h.app -eq 'java-stream-chat'
            $legacy = $false
            if (-not $modern -and $h -and $h.ok -eq $true -and $h.port -eq $port -and
                $h.version -in @('0.4.0', '1.0.0') -and $h.provider -in @('browser', 'mock', 'openai')) {
                $status = LocalJson $port '/api/extension/status'
                $legacy = $status -and $null -ne $status.openWindows -and $null -ne $status.lastSeenMsAgo
            }
            if (-not ($modern -or $legacy)) {
                Write-Warning "端口 $port 无法确认属于本项目，跳过 PID=$owner。"
                continue
            }
            $targets[[int]$owner] = $p
            Write-Host "已识别后端：端口 $port，PID=$owner"
            if ($modern -and $token) { $null = LocalJson $port '/admin/shutdown' 'POST' $token }
            elseif ($legacy) { $null = LocalJson $port '/admin/shutdown' 'POST' }
        }
    }

    # 旧版桌面客户端：同时匹配可执行文件名称和项目窗口标题。
    foreach ($p in $processes) {
        if ($p.Name -notin @('java.exe', 'javaw.exe', 'JavaStreamChat.exe')) { continue }
        $w = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
        if ($w -and $w.MainWindowTitle -match '^(Java Stream Chat 1\.0\.0 · 本地工作台|Java 实时流式聊天 Demo v0\.4\.0)$') {
            $targets[[int]$p.ProcessId] = $p
            $null = $w.CloseMainWindow()
        }
    }

    Start-Sleep -Seconds 3
    foreach ($p in $targets.Values) {
        $live = $null
        try {
            $live = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
            if (-not $live) { Write-Host "已停止 PID=$($p.ProcessId)"; continue }
            $null = $live.Handle
            $now = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ProcessId)"
            if (-not $now) { continue }
            if ($null -eq $p.CreationDate -or $now.CreationDate -ne $p.CreationDate -or $now.Name -ne $p.Name) {
                Write-Warning "PID=$($p.ProcessId) 身份变化，跳过。"; $remaining++; continue
            }
            Write-Warning "正常退出未完成，结束项目进程 PID=$($p.ProcessId)。未保存内容可能丢失。"
            Stop-Process -InputObject $live -Force
            if (-not $live.WaitForExit(5000)) { $remaining++ }
        } catch {
            Write-Warning "无法停止 PID=$($p.ProcessId)，请右键脚本，以管理员身份运行。"
            $remaining++
        } finally {
            if ($live) { $live.Dispose() }
        }
    }

    $after = @(Get-NetTCPConnection | Where-Object { $_.State -eq 'Listen' })
    foreach ($port in $ports) {
        $busy = @($after | Where-Object { $_.LocalPort -eq $port })
        if ($busy.Count) {
            Write-Warning "端口 $port 仍被占用，PID=$($busy.OwningProcess -join ',')"
            $remaining++
        } else { Write-Host "端口 $port 已释放。" }
    }
    if ($targets.Count -eq 0) { Write-Host '没有发现可确认的项目进程。' }
    Write-Host '检查结束。浏览器和扩展未关闭，历史记录和令牌未删除。'
    if ($remaining -gt 0) { exit 2 }
    exit 0
} catch {
    Write-Host ('停止失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
