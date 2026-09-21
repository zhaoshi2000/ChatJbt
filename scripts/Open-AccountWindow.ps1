param(
    [string]$Profile = '',
    [ValidateSet('Auto','Edge','Chrome')][string]$Browser = 'Auto',
    [switch]$NoBackend
)
. "$PSScriptRoot\Common.ps1"

# A separate user-data directory isolates cookies and extension storage.
# Do not point this at existing browser profile data, and do not copy profiles.
if (-not $Profile) { $Profile = Read-Host 'Account window ID (A / B / work / personal)' }
if ($Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$' -or $Profile -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {
    throw 'Use 1-40 letters/numbers/hyphens/underscores; for example A or B. Windows reserved names are not allowed.'
}
$Profile = $Profile.ToLowerInvariant()
function Find-Browser([string]$Name) {
    $file = if ($Name -eq 'Edge') { 'msedge.exe' } else { 'chrome.exe' }
    $relative = if ($Name -eq 'Edge') { 'Microsoft\Edge\Application\msedge.exe' } else { 'Google\Chrome\Application\chrome.exe' }
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if ($base) { $path=Join-Path $base $relative; if (Test-Path -LiteralPath $path) {return $path} }
    }
    $cmd=Get-Command $file -ErrorAction SilentlyContinue
    if ($cmd) {return $cmd.Source}
    return $null
}
$exe=$null;$choice=$Browser
foreach ($name in $(if ($Browser -eq 'Auto') { @('Edge','Chrome') } else { @($Browser) })) {
    $candidate=Find-Browser $name
    if ($candidate) { $exe=$candidate;$choice=$name;break }
}
if (-not $exe) {throw 'Edge / Chrome executable not found. Install a browser or set -Browser Edge / Chrome.'}
# Enterprise UserDataDir policy overrides the command-line directory. Refuse
# rather than accidentally opening A and B in the same managed profile.
$policySuffix = if ($choice -eq 'Edge') { 'Microsoft\Edge' } else { 'Google\Chrome' }
foreach ($prefix in @('HKCU:\SOFTWARE\Policies\','HKLM:\SOFTWARE\Policies\','HKCU:\SOFTWARE\WOW6432Node\Policies\','HKLM:\SOFTWARE\WOW6432Node\Policies\')) {
    $key = $prefix + $policySuffix
    if (Test-Path -LiteralPath $key) {
        $policy = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
        if ($policy.UserDataDir) { throw 'Managed UserDataDir policy overrides profile isolation. Ask your administrator; this script will not bypass policy or reuse a shared profile.' }
    }
}
if (-not $env:LOCALAPPDATA) {throw 'LOCALAPPDATA missing; cannot create an isolated browser data directory.'}

# Outside the project, so upgrading the project does not discard login or extension settings.
$base = Join-Path $env:LOCALAPPDATA 'Doubao\BrowserProfiles'
$data = Join-Path $base ($choice.ToLowerInvariant()+'-'+$Profile)
$null=New-Item -ItemType Directory -Path $data -Force
$marker=Join-Path $data 'doubao-profile.txt'
if (-not (Test-Path -LiteralPath $marker)) {
    [IO.File]::WriteAllText($marker, ('Browser='+$choice+"`r`nProfile="+$Profile+"`r`nCreated="+[DateTime]::UtcNow.ToString('o')), [Text.Encoding]::UTF8)
}
if (-not $NoBackend) { & "$PSScriptRoot\Start-Backend.ps1" -Background }
$cfg=Get-AppConfig
$health=Get-Health $cfg['base']
if (-not $health) {throw 'Backend is not ready. Run run-doubao-web.bat first.'}
Assert-OurBackend $health
Write-Host ('Account window ID: '+$Profile+' / '+$choice) -ForegroundColor Green
Write-Host ('Isolated browser data: '+$data)
Write-Host 'First time in this window: load this project extension/, create/use ONE scoped account token, and log in to that ChatGPT account.'
Write-Host 'Reopen this same ID to reuse its login. Use a different ID (e.g. B) for another account.'
Write-Host 'Do not enable browser profile sync, copy profile folders, or switch ChatGPT accounts inside a bound profile.'
Write-Host 'This does not bypass browser enterprise policy. If separate profiles are forbidden, ask your administrator.'
$arguments=@(('--user-data-dir="'+$data+'"'),'--new-window',('"'+$cfg['base']+'/web/"'))
Start-Process -FilePath $exe -ArgumentList $arguments
