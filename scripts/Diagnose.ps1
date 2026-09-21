. "$PSScriptRoot\Common.ps1"
$cfg=Get-AppConfig;$report=[ordered]@{time=(Get-Date).ToString('o');projectRoot=$ProjectRoot;backendUrl=$cfg['base'];java='';health=$null;diagnostics=$null;errors=@()}
try{$report.java=Test-JavaRuntime}catch{$report.errors+= $_.Exception.Message}
$report.health=Get-Health $cfg['base']
if($report.health){
    try{Assert-OurBackend $report.health;$token=Read-LocalToken $cfg
        $report.diagnostics=Invoke-RestMethod -Uri ($cfg['base']+'/api/diagnostics') -Headers @{Authorization='Bearer '+$token} -TimeoutSec 5
    }catch{$report.errors+=$_.Exception.Message}
}else{$report.errors+='No health response. Start backend; check port, JDK version, and logs.'}
$json=$report | ConvertTo-Json -Depth 12
Write-Host $json
$logs=Join-Path $ProjectRoot 'logs';$null=New-Item -ItemType Directory -Path $logs -Force
$file=Join-Path $logs 'diagnostics.json';[IO.File]::WriteAllText($file,$json,(New-Object Text.UTF8Encoding($false)))
Write-Host ('Saved '+$file+' (no pairing token or chat contents included).')
