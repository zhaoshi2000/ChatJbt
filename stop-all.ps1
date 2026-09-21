#requires -Version 5.1
<#
Stops only verified Doubao / Java Stream Chat processes on this computer.
Does not kill all java.exe processes, stop Windows services, edit browser profiles,
remove history/tokens, or close the user's browser.
Usage: .\stop-all.ps1 [-PreviewOnly] [-NoForce] [-ExtraPorts '51234,51235']
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot = $PSScriptRoot,
    [string]$ExtraPorts = '',
    [switch]$PreviewOnly,
    [switch]$NoForce
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# Class fingerprints from the three delivered project archives, not generic JAR names.
# Fingerprinting a class (rather than a whole ZIP) ignores ZIP timestamps.
$script:ClassHashes = @{
    'BackendServer.class' = @(
        '4e73b18fe1fb88c4ea64bdb2545e10c8423194b6acf84d6f3e111162c880e0dd',
        'fa3531ac9c2be7d5a6da03b1b8c55d3ebcfc8ae87150a53c445340ceb7dc7eb4',
        'f2b334b5c23ae622918eed6ebf417b46986b35d223caaf7da912bc5a4f8cc974'
    )
    'ChatClient.class' = @(
        '47a2ebbdbf7eb577050a408f62bbe0685aa33b000edb989c55cfaffb3d5d2802',
        '3a1b8639fca96bc2d2cf57b70cb74a52bede3edca3d0de194e7c6997ae60c2ef'
    )
}
$script:JarCache = @{}

function Write-Info([string]$Text) { Write-Host $Text }
function Get-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -ne $p) { return $p.Value }
    return $null
}
function Resolve-LocalPath([string]$Base, [string]$Value) {
    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $Base $Value))
}
function Read-Properties([string]$Path) {
    $result = @{}
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        foreach ($line in [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)) {
            if ($line -match '^\s*([^#!\s][^=]*)=(.*)$') {
                $result[$matches[1].Trim()] = $matches[2].Trim()
            }
        }
    }
    return $result
}
function Get-Listeners {
    try {
        # A successful empty result must not be confused with a query failure.
        return @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' } |
            Select-Object LocalAddress, LocalPort, OwningProcess)
    } catch {
        $rows = @(& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp 2>$null)
        if ($LASTEXITCODE -ne 0) { throw '无法读取端口列表，请右键以管理员身份运行。' }
        $result = @()
        foreach ($line in $rows) {
            if ($line -match '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
                $result += [pscustomobject]@{ LocalAddress=$matches[1]; LocalPort=[int]$matches[2]; OwningProcess=[int]$matches[3] }
            }
        }
        if ($rows.Count -gt 0 -and $result.Count -eq 0 -and ($rows -join "`n") -match '\bTCP\b') {
            throw '无法可靠解析端口列表，已停止操作，不会按端口盲目结束进程。'
        }
        return $result
    }
}
function Invoke-LocalJson([int]$Port, [string]$Path, [string]$Method='GET', [string]$Token='') {
    $response=$null; $reader=$null
    try {
        # No system proxy and no redirects: a local pairing token must stay local.
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port$Path")
        $request.Proxy=$null; $request.AllowAutoRedirect=$false
        $request.Timeout=2500; $request.ReadWriteTimeout=2500; $request.KeepAlive=$false
        $request.Method=$Method
        if ($Token) { $request.Headers['Authorization']='Bearer '+$Token }
        if ($Method -eq 'POST') {
            $bytes=[Text.Encoding]::UTF8.GetBytes('{}')
            $request.ContentType='application/json; charset=utf-8'; $request.ContentLength=$bytes.Length
            $stream=$request.GetRequestStream()
            try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
        }
        $response=$request.GetResponse()
        $reader=[IO.StreamReader]::new($response.GetResponseStream(),[Text.Encoding]::UTF8)
        $json=$reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
        return [pscustomobject]@{ Success=$true; Data=$json }
    } catch {
        # Never print raw exceptions/headers/response bodies: they may contain secrets or chats.
        if ($_.Exception -is [Net.WebException] -and $_.Exception.Response) { $_.Exception.Response.Close() }
        return [pscustomobject]@{ Success=$false; Data=$null }
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Close() }
    }
}
function Get-JarArgument([string]$CommandLine) {
    if ($CommandLine -match '(?i)(?:^|\s)-jar\s+(?:"([^"]+)"|([^\s"]+))') {
        if ($matches[1]) { return $matches[1] }
        return $matches[2]
    }
    return ''
}
function Get-JvmDirectory($ProcessInfo) {
    # Only needed for old launchers using relative JAR paths; bounded to 2.5 seconds.
    $javaPath=[string]$ProcessInfo.ExecutablePath
    $jcmd=''
    if ($javaPath) {
        $candidate=Join-Path (Split-Path $javaPath -Parent) 'jcmd.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $jcmd=$candidate }
    }
    if (-not $jcmd) { return '' }
    $process=New-Object Diagnostics.Process
    try {
        $process.StartInfo.FileName=$jcmd
        $process.StartInfo.Arguments=([string]$ProcessInfo.ProcessId)+' VM.system_properties'
        $process.StartInfo.UseShellExecute=$false; $process.StartInfo.CreateNoWindow=$true
        $process.StartInfo.RedirectStandardOutput=$true; $process.StartInfo.RedirectStandardError=$true
        $process.StartInfo.StandardOutputEncoding=[Text.Encoding]::Default
        $null=$process.Start()
        $output=$process.StandardOutput.ReadToEndAsync(); $errors=$process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(2500)) {
            try { $process.Kill() } catch {} # Kills only our jcmd helper, never the target JVM.
            return ''
        }
        if ($process.ExitCode -eq 0) {
            $text=$output.GetAwaiter().GetResult()
            if ($text -match '(?m)^user\.dir=(.+)\r?$') { return $matches[1].Trim() }
        }
    } catch {} finally { $process.Dispose() }
    return ''
}
function Get-JarRole([string]$JarPath) {
    if (-not $JarPath -or -not (Test-Path -LiteralPath $JarPath -PathType Leaf)) { return '' }
    if ($script:JarCache.ContainsKey($JarPath)) { return $script:JarCache[$JarPath] }
    $archive=$null; $role=''
    try {
        $archive=[IO.Compression.ZipFile]::OpenRead($JarPath)
        foreach ($entryName in @('BackendServer.class','ChatClient.class')) {
            $entry=$archive.GetEntry($entryName)
            if (-not $entry -or $entry.Length -gt 524288) { continue }
            $stream=$entry.Open(); $sha=[Security.Cryptography.SHA256]::Create()
            try { $hash=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
            finally { $sha.Dispose(); $stream.Dispose() }
            if ($script:ClassHashes[$entryName] -contains $hash) {
                $role=if($entryName -eq 'BackendServer.class'){'backend'}else{'client'}
                break
            }
        }
    } catch {} finally { if ($archive) { $archive.Dispose() } }
    $script:JarCache[$JarPath]=$role
    return $role
}
function Test-SameProcess($Original) {
    $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+[string]$Original.ProcessId) -ErrorAction Stop
    return ($null -ne $current -and $null -ne $Original.CreationDate -and
        $current.CreationDate -eq $Original.CreationDate -and $current.Name -eq $Original.Name -and
        $current.CommandLine -eq $Original.CommandLine)
}
function Stop-VerifiedProcess($Original) {
    # Open a process handle, then revalidate creation time/command line before stopping it.
    # This avoids blindly killing a new process that reused an old PID.
    $live=$null
    try {
        if (-not (Test-SameProcess $Original)) { return $true }
        $live=Get-Process -Id $Original.ProcessId -ErrorAction Stop
        $null=$live.Handle
        if (-not (Test-SameProcess $Original)) { return $true }
        Stop-Process -InputObject $live -Force -ErrorAction Stop
        return $live.WaitForExit(5000)
    } catch {
        try { if (-not (Test-SameProcess $Original)) { return $true } } catch {}
        return $false
    } finally { if ($live) { $live.Dispose() } }
}
function Get-LocalTokens([string[]]$Roots) {
    $tokens=@()
    foreach ($root in ($Roots | Select-Object -Unique)) {
        if (-not $root) { continue }
        $paths=@((Join-Path $root 'data\local-token.txt'))
        try {
            $cfg=Read-Properties (Join-Path $root 'config\application.properties')
            if ($cfg.ContainsKey('data.dir')) { $paths += Join-Path (Resolve-LocalPath $root $cfg['data.dir']) 'local-token.txt' }
            if ($env:DATA_DIR) { $paths += Join-Path (Resolve-LocalPath $root $env:DATA_DIR) 'local-token.txt' }
            if ($env:CHAT_CONFIG) {
                $extra=Read-Properties (Resolve-LocalPath $root $env:CHAT_CONFIG)
                if ($extra.ContainsKey('data.dir')) { $paths += Join-Path (Resolve-LocalPath $root $extra['data.dir']) 'local-token.txt' }
            }
            foreach ($file in ($paths | Select-Object -Unique)) {
                if (Test-Path -LiteralPath $file -PathType Leaf) {
                    $token=([IO.File]::ReadAllText($file,[Text.Encoding]::UTF8)).Trim()
                    if ($token -match '^[A-Za-z0-9_-]{40,100}$' -and $tokens -notcontains $token) { $tokens += $token }
                }
            }
        } catch { Write-Warning '某个项目的令牌文件无法读取，将只对已验证的进程尝试后备停止。' }
    }
    return $tokens
}
function Get-BackendType($Health, [int]$Port, [string]$JarArgument, [string]$Role) {
    if ($null -eq $Health -or (Get-Field $Health 'ok') -ne $true -or (Get-Field $Health 'port') -ne $Port) { return '' }
    if ((Get-Field $Health 'app') -eq 'java-stream-chat') { return 'modern' }
    if ((Get-Field $Health 'version') -notin @('0.4.0','1.0.0')) { return '' }
    if ((Get-Field $Health 'provider') -notin @('browser','mock','openai')) { return '' }
    if ($Role -eq 'backend') { return 'legacy' }
    # Old demo health had no app ID; require independent legacy protocol evidence too.
    if ($JarArgument -and [IO.Path]::GetFileName($JarArgument) -ieq 'backend.jar') {
        $status=Invoke-LocalJson $Port '/api/extension/status'
        if ($status.Success -and $null -ne (Get-Field $status.Data 'openWindows') -and
            $null -ne (Get-Field $status.Data 'lastSeenMsAgo')) { return 'legacy' }
    }
    return ''
}
function Invoke-StopProject {
    if ($env:OS -ne 'Windows_NT') { throw '此脚本用于 Windows 10/11，请在项目所在的 Windows 电脑上运行。' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $root=[IO.Path]::GetFullPath($ProjectRoot)
    $roots=@($root)
    $ports=@(48643,48627)
    $cfg=Read-Properties (Join-Path $root 'config\application.properties')
    if ($env:CHAT_CONFIG) { $cfg=Read-Properties (Resolve-LocalPath $root $env:CHAT_CONFIG) }
    $values=@($ExtraPorts -split '[,;\s]+')
    if ($cfg.ContainsKey('server.port')) { $values += $cfg['server.port'] }
    if ($env:PORT) { $values += $env:PORT }
    foreach ($value in $values) {
        if (-not $value) { continue }
        $number=0
        if (-not [int]::TryParse([string]$value,[ref]$number) -or $number -lt 1024 -or $number -gt 65535) {
            throw '端口必须为 1024 到 65535 的整数；多个额外端口用英文逗号分隔。'
        }
        $ports += $number
    }
    $ports=@($ports | Select-Object -Unique)
    Write-Info '========================================'
    Write-Info ' 逗包 / Java Stream Chat 一键停止'
    Write-Info '========================================'
    Write-Info '只处理已验证的项目进程，不会关闭浏览器或删除历史、令牌。'
    if ($PreviewOnly) { Write-Info '预览模式：只检测，不取消任务、不结束服务。' }
    else { Write-Info '当前任务将尝试取消；未发送的草稿请提前保存。' }
    Write-Info ('检查端口：'+($ports -join ', '))

    $processes=@(Get-CimInstance Win32_Process -ErrorAction Stop)
    $listeners=@(Get-Listeners)
    $targets=@{}; $endpoints=@(); $ambiguous=@()
    foreach ($p in $processes) {
        if ($p.Name -notin @('java.exe','javaw.exe','JavaStreamChat.exe')) { continue }
        $argument=Get-JarArgument ([string]$p.CommandLine)
        $jar=''; $role=''; $reason=''; $working=''
        if ($argument) {
            if ([IO.Path]::IsPathRooted($argument)) { $jar=$argument }
            elseif ([IO.Path]::GetFileName($argument) -in @('backend.jar','client.jar')) {
                $working=Get-JvmDirectory $p
                if ($working) { $jar=Resolve-LocalPath $working $argument }
            }
        } elseif ($p.Name -ieq 'JavaStreamChat.exe' -and $p.ExecutablePath) {
            $jar=Join-Path (Split-Path $p.ExecutablePath -Parent) 'app\client.jar'
        }
        if ($jar) { $role=Get-JarRole $jar }
        if ($role) {
            $reason='与已交付项目的 class 指纹一致'
            $folder=Split-Path $jar -Parent
            if ((Split-Path $folder -Leaf) -in @('out','app')) { $folder=Split-Path $folder -Parent }
            $roots += $folder
        }
        # Old relative-path desktop launcher, without a JDK diagnostic helper.
        if (-not $role -and $argument -and [IO.Path]::GetFileName($argument) -ieq 'client.jar') {
            try {
                $window=Get-Process -Id $p.ProcessId -ErrorAction Stop
                $title=$window.MainWindowTitle
                $window.Dispose()
                if ($title -match '^Java Stream Chat 1\.0\.0 · 本地工作台$|^Java 实时流式聊天 Demo v0\.4\.0$') {
                    $role='client'; $reason='已知桌面标题 + client.jar 启动参数'
                }
            } catch {}
        }
        $owned=@($listeners | Where-Object { $_.OwningProcess -eq $p.ProcessId })
        foreach ($connection in $owned) {
            $port=[int]$connection.LocalPort
            if ($ports -notcontains $port -and $role -ne 'backend') { continue }
            if ($endpoints | Where-Object { $_.Port -eq $port }) { continue }
            if ($connection.LocalAddress -notin @('127.0.0.1','0.0.0.0','::','[::]')) { continue }
            $health=Invoke-LocalJson $port '/health'
            if (-not $health.Success) { continue }
            $type=Get-BackendType $health.Data $port $argument $role
            if ($type) {
                $role='backend'; $reason='本机端口所属 JVM + 项目健康检查/协议'
                $endpoints += [pscustomobject]@{ Port=$port; Process=$p; Type=$type; Health=$health.Data }
                $ports += $port
            }
        }
        if ($role) {
            $targets[[int]$p.ProcessId]=[pscustomobject]@{ Process=$p; Role=$role; Reason=$reason; Jar=$jar }
        } elseif ($argument -and [IO.Path]::GetFileName($argument) -in @('backend.jar','client.jar')) {
            $ambiguous += [int]$p.ProcessId
        }
    }
    $ports=@($ports | Select-Object -Unique)
    foreach ($target in $targets.Values) {
        $name=if($target.Role -eq 'backend'){'后端'}else{'桌面客户端'}
        Write-Info ("已识别：$name  PID="+$target.Process.ProcessId+'  '+$target.Reason)
    }
    foreach ($id in $ambiguous) { Write-Warning ("跳过 PID=$id：无法确认此同名 JAR 属于本项目。可从对应项目目录再次运行，或检查是否缺少 JDK/权限。") }
    $blocked=@($listeners | Where-Object { $ports -contains [int]$_.LocalPort -and -not $targets.ContainsKey([int]$_.OwningProcess) })
    foreach ($item in $blocked) { Write-Warning ('端口 '+$item.LocalPort+' 由未确认进程 PID='+$item.OwningProcess+' 占用，不会误杀。') }
    if ($targets.Count -eq 0) { Write-Info '没有发现可确认的逗包 / Java Stream Chat 运行进程。' }
    if ($PreviewOnly) { Write-Info '检测结束，未执行停止操作。'; return 0 }

    $tokens=@(Get-LocalTokens $roots)
    foreach ($endpoint in $endpoints) {
        if (-not (Test-SameProcess $endpoint.Process)) { continue }
        $port=$endpoint.Port
        # Recheck the server instance so a replaced listener never receives a pairing token.
        $check=Invoke-LocalJson $port '/health'
        if (-not $check.Success) { continue }
        if ($endpoint.Type -eq 'modern') {
            if ((Get-Field $check.Data 'app') -ne 'java-stream-chat' -or
                (Get-Field $check.Data 'instanceId') -ne (Get-Field $endpoint.Health 'instanceId')) { continue }
            $selected=''; $tasks=@()
            foreach ($token in $tokens) {
                $result=Invoke-LocalJson $port '/api/tasks' 'GET' $token
                if ($result.Success -and $null -ne $result.Data.PSObject.Properties['tasks']) {
                    $selected=$token; $tasks=@(Get-Field $result.Data 'tasks'); break
                }
            }
            if (-not $selected) { Write-Warning ("端口 $port 无可用配对令牌，无法正常取消任务；将按已验证进程身份处理。"); continue }
            $cancelled=0
            foreach ($task in $tasks) {
                $id=[string](Get-Field $task 'id')
                if ((Get-Field $task 'state') -in @('completed','error','cancelled','interrupted')) { continue }
                if ($id -notmatch '^[A-Za-z0-9_-]{8,80}$') { continue }
                $cancel=Invoke-LocalJson $port ("/api/tasks/$id/cancel") 'POST' $selected
                if ($cancel.Success) { $cancelled++ }
            }
            if ($cancelled -gt 0) {
                Write-Info ("端口 $port 已取消 $cancelled 个本地任务，等待网页桥接同步…")
                Start-Sleep -Seconds 4
            }
            $shutdown=Invoke-LocalJson $port '/admin/shutdown' 'POST' $selected
        } else {
            # Old demo has no authentication; never sends any local token to it.
            if ((Get-Field $check.Data 'version') -ne (Get-Field $endpoint.Health 'version')) { continue }
            $shutdown=Invoke-LocalJson $port '/admin/shutdown' 'POST'
        }
        if ($shutdown.Success) { Write-Info ("已请求端口 $port 正常关停。") }
        else { Write-Warning ("端口 $port 正常关停失败，将检查进程是否仍存在。") }
    }
    # Close the Swing window through its regular close handler before considering termination.
    foreach ($target in $targets.Values) {
        if ($target.Role -ne 'client' -or -not (Test-SameProcess $target.Process)) { continue }
        $window=$null
        try {
            $window=Get-Process -Id $target.Process.ProcessId -ErrorAction Stop
            $null=$window.Handle
            if (Test-SameProcess $target.Process) { $null=$window.CloseMainWindow() }
        } catch {} finally { if ($window) { $window.Dispose() } }
    }
    if ($targets.Count -gt 0) { Start-Sleep -Seconds 3 }
    $remaining=0
    foreach ($target in $targets.Values) {
        $id=[int]$target.Process.ProcessId
        if (-not (Test-SameProcess $target.Process)) { Write-Info ("已停止 PID=$id"); continue }
        if ($NoForce) { Write-Warning ("PID=$id 仍在运行；NoForce 模式不强制结束。"); $remaining++; continue }
        Write-Warning ("正常退出未完成，结束已确认的项目进程 PID=$id。尚未落盘的内容可能丢失。")
        if (Stop-VerifiedProcess $target.Process) { Write-Info ("已结束 PID=$id") }
        else { Write-Warning ("无法结束 PID=$id。请右键 stop-all.bat，以管理员身份运行后重试。"); $remaining++ }
    }
    $after=@(Get-Listeners)
    foreach ($port in $ports) {
        $busy=@($after | Where-Object { $_.LocalPort -eq $port })
        if ($busy.Count -eq 0) { Write-Info ("端口 $port：已释放") }
        else { Write-Warning ("端口 $port：仍被占用，PID="+(($busy.OwningProcess | Select-Object -Unique) -join ',')); $remaining++ }
    }
    Write-Info '浏览器和扩展不会被强行关闭；要完全停用桥接，请在扩展管理页禁用对应扩展。'
    Write-Info '网页里已经开始的生成只能尽力取消，必要时请在工作标签页手动点击停止。'
    if ($ambiguous.Count -gt 0 -or $remaining -gt 0) {
        Write-Warning '存在未处理或未确认项目，不能保证全部停止。请查看上方 PID/端口提示。'
        return 2
    }
    Write-Info '本轮已识别的项目进程均已停止，检查的端口均已释放。'
    return 0
}

# Dot-sourcing only defines functions; useful for controlled tests.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        try { [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false) } catch {}
        $exitCode=Invoke-StopProject
        exit $exitCode
    } catch {
        Write-Host ('停止失败：'+$_.Exception.Message) -ForegroundColor Red
        Write-Host '未执行广泛进程清理。请检查运行目录/权限，勿使用结束所有 Java 的命令。'
        exit 1
    }
}
