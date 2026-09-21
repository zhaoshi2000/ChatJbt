. "$PSScriptRoot\Common.ps1"
& "$PSScriptRoot\Start-Backend.ps1" -Background
$cfg=Get-AppConfig
$health=Get-Health $cfg['base']
if(-not $health){throw 'Backend did not become ready; check logs/.'}
Assert-OurBackend $health
Write-Host ('Open Doubao: '+$cfg['base']+'/web/') -ForegroundColor Green
Write-Host 'First run: load the extension/ folder, then refresh the webpage.'
Write-Host 'First create account workspaces in Account Management using data/local-token.txt.'
Write-Host 'Then pair ONE account-scoped token in EACH independent browser profile.'
Write-Host 'Use open-account-A.bat / open-account-B.bat for isolated login windows.'
Write-Host 'No browser side panel is required. Keep the ChatGPT work tab open in the background.'
if($health.provider -eq 'mock') {Write-Warning 'MOCK mode is enabled. This is a test response, not a real model. Set provider=browser for page bridging.'}
Start-Process ($cfg['base']+'/web/')
