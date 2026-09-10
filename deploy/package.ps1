[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $repoRoot 'output/deployment'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$manifest = Join-Path $outputDirectory 'source-files.txt'
$archive = Join-Path $outputDirectory 'streetrove-deploy.tar.gz'
Push-Location $repoRoot
try {
    # Includes current edits and new deployment files, without ignored local data.
    $candidates = git -c core.quotepath=false ls-files --cached --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate project files.' }
    $files = $candidates | Where-Object {
        ($_ -match '^(apps/|packages/|database/|deploy/)' -or
         $_ -in @('Dockerfile', '.dockerignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'compose.production.yaml', 'LICENSE')) -and
        $_ -notmatch '(^|/)(private|node_modules|dist)/' -and
        $_ -notmatch '(^|/)\.env($|\.)|\.(pem|key)$' -and
        (Test-Path -LiteralPath $_ -PathType Leaf)
    }
    $files | Sort-Object -Unique | Set-Content -LiteralPath $manifest -Encoding utf8NoBOM
    tar -czf $archive -T $manifest
    if ($LASTEXITCODE -ne 0) { throw 'Archive creation failed.' }
    Get-FileHash -LiteralPath $archive -Algorithm SHA256 | Select-Object Path, Hash
} finally {
    Pop-Location
}
