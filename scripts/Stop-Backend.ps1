. "$PSScriptRoot\Common.ps1"
$cfg=Get-AppConfig;$health=Get-Health $cfg['base']
if(-not $health){Write-Host 'Backend is not responding; no unrelated Java process will be killed.';exit 1}
Assert-OurBackend $health
$token=Read-LocalToken $cfg
$result=Invoke-RestMethod -Uri ($cfg['base']+'/admin/shutdown') -Method Post -ContentType 'application/json' -Body '{}' -Headers @{Authorization='Bearer '+$token} -TimeoutSec 5
Write-Host 'Backend stopped.' -ForegroundColor Green
