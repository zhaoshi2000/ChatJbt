$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $ProjectRoot
function Get-AppConfig {
    $cfg = @{ 'server.port'='48643'; 'provider'='browser'; 'data.dir'='data' }
    $file = if ($env:CHAT_CONFIG) { $env:CHAT_CONFIG } else { Join-Path $ProjectRoot 'config\application.properties' }
    if (Test-Path -LiteralPath $file) {
        foreach ($line in [IO.File]::ReadAllLines($file, [Text.Encoding]::UTF8)) {
            if ($line -match '^\s*([^#!\s][^=]*)=(.*)$') { $cfg[$matches[1].Trim()] = $matches[2].Trim() }
        }
    }
    if ($env:PORT) { $cfg['server.port']=$env:PORT }
    if ($env:PROVIDER) { $cfg['provider']=$env:PROVIDER }
    if ($env:DATA_DIR) { $cfg['data.dir']=$env:DATA_DIR }
    $cfg['base']='http://127.0.0.1:' + $cfg['server.port']
    $dataPath = if ([IO.Path]::IsPathRooted($cfg['data.dir'])) { $cfg['data.dir'] } else { Join-Path $ProjectRoot $cfg['data.dir'] }
    $cfg['data.path'] = [IO.Path]::GetFullPath($dataPath)
    return $cfg
}
function Get-JavaTool([string]$Name) {
    if ($env:JAVA_HOME) {
        $candidate=Join-Path $env:JAVA_HOME ('bin\'+$Name+'.exe')
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $tool=Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $tool) { throw "$Name not found. Install JDK 21 or newer and set JAVA_HOME / PATH." }
    return $tool.Source
}
function Test-JavaRuntime {
    $java=Get-JavaTool 'java'
    $old=$ErrorActionPreference; $ErrorActionPreference='Continue'
    $version=(& $java -version 2>&1 | Out-String)
    $code=$LASTEXITCODE; $ErrorActionPreference=$old
    if ($code -ne 0 -or $version -notmatch 'version\s+"(\d+)') { throw "Unable to detect Java version: $version" }
    if ([int]$matches[1] -lt 21) { throw 'Java 21 or newer is required. Java 8/11/17 cannot run these JARs.' }
    return $java
}
function Get-Health([string]$Base) {
    try { return Invoke-RestMethod -Uri ($Base+'/health') -Method Get -TimeoutSec 2 }
    catch { return $null }
}
function Assert-OurBackend($Health) {
    if ($Health.app -ne 'java-stream-chat' -or $Health.version -ne '1.2.1') {
        throw 'This port is occupied by an old or different backend. Stop that process explicitly; this script will not kill unrelated processes.'
    }
}
function Read-LocalToken($Cfg) {
    $file=Join-Path $Cfg['data.path'] 'local-token.txt'
    if (-not (Test-Path -LiteralPath $file)) { throw 'Pairing token missing. Start the backend first.' }
    return ([IO.File]::ReadAllText($file,[Text.Encoding]::UTF8)).Trim()
}
