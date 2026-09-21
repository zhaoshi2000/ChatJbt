param([switch]$Background)
. "$PSScriptRoot\Common.ps1"
$java=Test-JavaRuntime;$cfg=Get-AppConfig
$jar=Join-Path $ProjectRoot 'out\backend.jar'
if(-not(Test-Path -LiteralPath $jar)){& "$PSScriptRoot\Build.ps1"}
$existing=Get-Health $cfg['base']
if($existing){Assert-OurBackend $existing;Write-Host ('Backend already running at '+$cfg['base']);return}
if(-not $Background){
    Write-Host ('Starting '+$cfg['base']+'  provider='+$cfg['provider'])
    & $java -jar $jar
    if($LASTEXITCODE -ne 0){throw 'Backend exited with an error. Check the message above.'}
    return
}
$logs=Join-Path $ProjectRoot 'logs';$null=New-Item -ItemType Directory -Path $logs -Force
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$outLog=Join-Path $logs ('backend-'+$stamp+'.log');$errLog=Join-Path $logs ('backend-'+$stamp+'.err.log')
$process=Start-Process -FilePath $java -ArgumentList @('-jar',('"'+$jar+'"')) -WorkingDirectory $ProjectRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
for($i=0;$i -lt 50;$i++){
    Start-Sleep -Milliseconds 300
    $health=Get-Health $cfg['base']
    if($health){Assert-OurBackend $health;Write-Host ('Backend ready at '+$cfg['base']) -ForegroundColor Green;return}
    if($process.HasExited){throw ('Backend failed to start. Read '+$errLog)}
}
throw ('Backend did not become ready. Inspect '+$errLog+'; no process was forcibly terminated.')
