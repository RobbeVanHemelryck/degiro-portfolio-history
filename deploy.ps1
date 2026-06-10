$ErrorActionPreference = 'Stop'

$repo = 'taltiko/degiro-portfolio-history'
$api = "https://registry.hub.docker.com/v2/repositories/$repo/tags?page_size=100"
$resp = Invoke-RestMethod -Uri $api -Method Get

$latest = ($resp.results.name |
    Where-Object { $_ -match '^\d+$' } |
    ForEach-Object { [int]$_ } |
    Measure-Object -Maximum).Maximum

if ($null -eq $latest) { $latest = 0 }

$newTag = $latest + 1
$image = "${repo}:$newTag"

Write-Host "Building $image"
docker build -t $image .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Pushing $image"
docker push $image
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Done: $image"
