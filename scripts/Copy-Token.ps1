. "$PSScriptRoot\Common.ps1"
$cfg=Get-AppConfig
$token=Read-LocalToken $cfg
Set-Clipboard -Value $token
Write-Host 'Local pairing token copied. Paste it in Doubao Connection Settings.' -ForegroundColor Green
Write-Host 'Do not send this token to anyone. It is not a ChatGPT password or API key.'
