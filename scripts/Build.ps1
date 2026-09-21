. "$PSScriptRoot\Common.ps1"
$null=Test-JavaRuntime
$javac=Get-JavaTool 'javac';$jar=Get-JavaTool 'jar'
$out=Join-Path $ProjectRoot 'out\backend'
if(Test-Path -LiteralPath $out){Remove-Item -LiteralPath $out -Recurse -Force}
$null=New-Item -ItemType Directory -Path (Join-Path $out 'ui') -Force
$sources=@(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'common\src') -Filter '*.java' | ForEach-Object FullName)
$sources+=@(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'backend\src') -Filter '*.java' | ForEach-Object FullName)
& $javac --release 21 -encoding UTF-8 -d $out @sources
if($LASTEXITCODE -ne 0){throw 'Backend compilation failed'}
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'web') -File | Copy-Item -Destination (Join-Path $out 'ui')
& $jar --create --file (Join-Path $ProjectRoot 'out\backend.jar') --main-class BackendServer -C $out .
if($LASTEXITCODE -ne 0){throw 'Backend packaging failed'}
Write-Host 'Built out/backend.jar (Java 21+)'
