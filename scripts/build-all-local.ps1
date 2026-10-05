#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidatePattern('^25\.12\.[0-9]+$')]
    [string]$ApkVersion = '25.12.5',

    [ValidatePattern('^24\.10\.[0-9]+$')]
    [string]$IpkVersion = '24.10.8',

    [ValidateRange(1, 8)]
    [int]$Jobs = 2,

    [ValidateRange(1, 8)]
    [int]$BuildJobs = 2,

    [string]$OutputDirectory,

    [string[]]$Only,

    [switch]$Force,

    [switch]$RemoveImages,

    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$matrixPath = Join-Path $repoRoot 'scripts/build-matrix.json'
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot 'dist/build-all'
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$packagesRoot = Join-Path $outputRoot 'packages'
$logsRoot = Join-Path $outputRoot 'logs'
$sdkLockCandidate = Join-Path ([IO.Path]::GetTempPath()) "lucky-sdk-lock-$PID.json"

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)]
        [string]$Command,

        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command exited with code $LASTEXITCODE"
    }
}

function Test-CorePackage {
    param(
        [Parameter(Mandatory)]
        [string]$Directory,

        [Parameter(Mandatory)]
        [ValidateSet('apk', 'ipk')]
        [string]$Format,

        [Parameter(Mandatory)]
        [string]$SourceFingerprint,

        [Parameter(Mandatory)]
        [string]$SdkImage
    )

    $metadataPath = Join-Path $Directory 'PACKAGE-METADATA.txt'
    if (-not (Test-Path -LiteralPath $metadataPath)) {
        return $false
    }
    $metadata = Get-Content -Raw -LiteralPath $metadataPath
    if ($metadata -notmatch "(?m)^Source-Fingerprint\t$([regex]::Escape($SourceFingerprint))$") {
        return $false
    }
    if ($metadata -notmatch "(?m)^SDK-Image\t$([regex]::Escape($SdkImage))$") {
        return $false
    }
    $pattern = if ($Format -eq 'apk') { 'lucky-*.apk' } else { 'lucky_*.ipk' }
    return @(Get-ChildItem -LiteralPath $Directory -File -Filter $pattern -ErrorAction SilentlyContinue).Count -eq 1
}

function Get-SourceFingerprint {
    param(
        [Parameter(Mandatory)]
        [string]$Repository,

        [Parameter(Mandatory)]
        [string[]]$Paths
    )

    $hasher = [Security.Cryptography.IncrementalHash]::CreateHash(
        [Security.Cryptography.HashAlgorithmName]::SHA256
    )
    $separator = [byte[]]@(0)
    try {
        foreach ($relativePath in $paths) {
            $hasher.AppendData([Text.Encoding]::UTF8.GetBytes($relativePath.Replace('\\', '/')))
            $hasher.AppendData($separator)
            $fullPath = Join-Path $Repository $relativePath
            if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
                $stream = [IO.File]::OpenRead($fullPath)
                try {
                    $buffer = [byte[]]::new(1MB)
                    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $hasher.AppendData($buffer, 0, $read)
                    }
                }
                finally {
                    $stream.Dispose()
                }
            }
            else {
                $hasher.AppendData([Text.Encoding]::UTF8.GetBytes('<deleted>'))
            }
            $hasher.AppendData($separator)
        }
        return [Convert]::ToHexString($hasher.GetHashAndReset()).ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
    }
}

function Test-LuCIPackages {
    param(
        [Parameter(Mandatory)]
        [string]$Directory,

        [Parameter(Mandatory)]
        [ValidateSet('apk', 'ipk')]
        [string]$Format,

        [Parameter(Mandatory)]
        [string]$SourceFingerprint,

        [Parameter(Mandatory)]
        [string]$SdkImage
    )

    if (-not (Test-Path -LiteralPath $Directory)) {
        return $false
    }
    $metadataPath = Join-Path $Directory 'SDK-METADATA.txt'
    if (-not (Test-Path -LiteralPath $metadataPath)) {
        return $false
    }
    $metadata = Get-Content -Raw -LiteralPath $metadataPath
    if ($metadata -notmatch "(?m)^Source-Fingerprint\t$([regex]::Escape($SourceFingerprint))$" -or
        $metadata -notmatch "(?m)^SDK-Image\t$([regex]::Escape($SdkImage))$") {
        return $false
    }
    $appPattern = if ($Format -eq 'apk') { 'luci-app-lucky-*.apk' } else { 'luci-app-lucky_*.ipk' }
    $i18nPattern = if ($Format -eq 'apk') { 'luci-i18n-lucky-zh-cn-*.apk' } else { 'luci-i18n-lucky-zh-cn_*.ipk' }
    $apps = @(Get-ChildItem -LiteralPath $Directory -File -Filter $appPattern -ErrorAction SilentlyContinue)
    $translations = @(Get-ChildItem -LiteralPath $Directory -File -Filter $i18nPattern -ErrorAction SilentlyContinue)
    return $apps.Count -eq 1 -and $translations.Count -eq 1
}

Write-Host 'Validating the reviewed architecture matrix and official SDK tags...'
Invoke-CheckedCommand python @(
    (Join-Path $repoRoot 'scripts/check-build-matrix.py'),
    $matrixPath
)
Invoke-CheckedCommand python @(
    (Join-Path $repoRoot 'scripts/check-sdk-tags.py'),
    $matrixPath,
    '--apk-version', $ApkVersion,
    '--ipk-version', $IpkVersion,
    '--output', $sdkLockCandidate
)

if ($ValidateOnly) {
    [IO.File]::Delete($sdkLockCandidate)
    Write-Host 'Local build prerequisites and all SDK tags are valid.'
    exit 0
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install and start Docker Desktop first.'
}
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Desktop is installed but its Linux engine is not running.'
}

[IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$sourcePaths = @(& git -C $repoRoot ls-files --cached --others --exclude-standard | Sort-Object)
if ($LASTEXITCODE -ne 0 -or $sourcePaths.Count -eq 0) {
    throw 'Unable to enumerate source files for the immutable snapshot.'
}
$sourceCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
$sourceDirty = -not [string]::IsNullOrWhiteSpace((& git -C $repoRoot status --porcelain) -join '')
$snapshotStagingDirectory = Join-Path $outputRoot ".source-snapshot-$PID"
if (Test-Path -LiteralPath $snapshotStagingDirectory) {
    [IO.Directory]::Delete($snapshotStagingDirectory, $true)
}
[IO.Directory]::CreateDirectory($snapshotStagingDirectory) | Out-Null
foreach ($relativePath in $sourcePaths) {
    $sourcePath = Join-Path $repoRoot $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        continue
    }
    $snapshotPath = Join-Path $snapshotStagingDirectory $relativePath
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($snapshotPath)) | Out-Null
    [IO.File]::Copy($sourcePath, $snapshotPath, $true)
}
$sourceFingerprint = Get-SourceFingerprint -Repository $snapshotStagingDirectory -Paths $sourcePaths
$sdkLock = Get-Content -Raw -LiteralPath $sdkLockCandidate | ConvertFrom-Json
$sdkLockSha256 = (Get-FileHash -LiteralPath $sdkLockCandidate -Algorithm SHA256).Hash.ToLowerInvariant()
$buildIdentity = [ordered]@{
    schema_version = 1
    source_fingerprint = $sourceFingerprint
    apk_version = $ApkVersion
    ipk_version = $IpkVersion
    sdk_lock_sha256 = $sdkLockSha256
}
$buildIdentityJson = ($buildIdentity | ConvertTo-Json) + "`n"
$buildIdentityPath = Join-Path $outputRoot 'BUILD-IDENTITY.json'
$fingerprintPath = Join-Path $outputRoot 'SOURCE-FINGERPRINT.txt'
$identityMismatch = $false
if (Test-Path -LiteralPath $buildIdentityPath) {
    $identityMismatch = (Get-Content -Raw -LiteralPath $buildIdentityPath) -ne $buildIdentityJson
}
elseif (Test-Path -LiteralPath $packagesRoot) {
    $identityMismatch = @(Get-ChildItem -LiteralPath $packagesRoot -Recurse -File -ErrorAction SilentlyContinue).Count -gt 0
}
if ($identityMismatch) {
    if (-not $Force) {
        [IO.Directory]::Delete($snapshotStagingDirectory, $true)
        [IO.File]::Delete($sdkLockCandidate)
        throw 'The output directory belongs to another source/version/SDK lock. Use another -OutputDirectory or pass -Force.'
    }
    foreach ($generatedPath in @(
        $packagesRoot,
        $logsRoot,
        (Join-Path $outputRoot 'SHA256SUMS'),
        (Join-Path $outputRoot 'MANIFEST.json'),
        (Join-Path $outputRoot 'BUILD-INFO.txt'),
        (Join-Path $outputRoot 'SDK-LOCK.json'),
        $buildIdentityPath,
        $fingerprintPath
    )) {
        if (Test-Path -LiteralPath $generatedPath) {
            if ([IO.Directory]::Exists($generatedPath)) {
                [IO.Directory]::Delete($generatedPath, $true)
            }
            else {
                [IO.File]::Delete($generatedPath)
            }
        }
    }
}
[IO.File]::WriteAllText($buildIdentityPath, $buildIdentityJson, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($fingerprintPath, "$sourceFingerprint`n", [Text.UTF8Encoding]::new($false))
[IO.File]::Copy($sdkLockCandidate, (Join-Path $outputRoot 'SDK-LOCK.json'), $true)
[IO.File]::Delete($sdkLockCandidate)

$snapshotVolume = "lucky-source-$($sourceFingerprint.Substring(0, 16))"
& docker volume inspect $snapshotVolume *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating immutable Linux source snapshot $snapshotVolume..."
    Invoke-CheckedCommand docker @('pull', 'busybox:1.36')
    Invoke-CheckedCommand docker @('volume', 'create', $snapshotVolume)
    $snapshotScript = "set -eu; cp -a /source/. /snapshot/; chown -R 1000:1000 /snapshot; printf '%s\n' '$sourceFingerprint' > /snapshot/.lucky-source-fingerprint"
    try {
        Invoke-CheckedCommand docker @(
            'run', '--rm', '--user', '0:0',
            '--mount', "type=bind,source=$snapshotStagingDirectory,target=/source,readonly",
            '--mount', "type=volume,source=$snapshotVolume,target=/snapshot",
            'busybox:1.36', 'sh', '-c', $snapshotScript
        )
    }
    catch {
        & docker volume rm $snapshotVolume *> $null
        if (Test-Path -LiteralPath $snapshotStagingDirectory) {
            [IO.Directory]::Delete($snapshotStagingDirectory, $true)
        }
        throw
    }
}
$snapshotMarkerArguments = @(
    'run', '--rm',
    '--mount', "type=volume,source=$snapshotVolume,target=/snapshot,readonly",
    'busybox:1.36', 'cat', '/snapshot/.lucky-source-fingerprint'
)
$snapshotMarker = (& docker @snapshotMarkerArguments).Trim()
if ($LASTEXITCODE -ne 0 -or $snapshotMarker -ne $sourceFingerprint) {
    [IO.Directory]::Delete($snapshotStagingDirectory, $true)
    throw "Source snapshot volume $snapshotVolume is incomplete or corrupt."
}
[IO.Directory]::Delete($snapshotStagingDirectory, $true)

[IO.Directory]::CreateDirectory($packagesRoot) | Out-Null
[IO.Directory]::CreateDirectory($logsRoot) | Out-Null
$matrix = Get-Content -Raw -LiteralPath $matrixPath | ConvertFrom-Json
$versions = @{ apk = $ApkVersion; ipk = $IpkVersion }
$sdkLockIndex = @{}
foreach ($lockedImage in $sdkLock.sdk_images) {
    $sdkLockIndex["$($lockedImage.format):$($lockedImage.package_arch)"] = $lockedImage
}
$filters = @{}
foreach ($item in @($Only)) {
    if ([string]::IsNullOrWhiteSpace($item)) {
        continue
    }
    if ($item -notmatch '^(apk|ipk):(.+)$') {
        throw "Invalid -Only value '$item'; use apk:ARCH or ipk:ARCH"
    }
    $filters[$item] = $true
}

$tasks = foreach ($format in @('apk', 'ipk')) {
    $version = $versions[$format]
    foreach ($entry in $matrix.$format) {
        $architecture = [string]$entry.package_arch
        $key = "${format}:$architecture"
        if ($filters.Count -gt 0 -and -not $filters.ContainsKey($key)) {
            continue
        }
        $lockedImage = $sdkLockIndex[$key]
        if ($null -eq $lockedImage) {
            throw "SDK lock is missing $key"
        }
        [pscustomobject]@{
            Format = $format
            Version = $version
            Architecture = $architecture
            Image = "ghcr.io/openwrt/sdk:$architecture-$version"
            ResolvedImage = [string]$lockedImage.image
            BuildLuCI = $architecture -eq 'x86_64'
            FormatRoot = Join-Path $packagesRoot "openwrt-$version/$format"
        }
    }
}

if ($tasks.Count -eq 0) {
    throw 'No architectures matched -Only.'
}

$pending = foreach ($task in $tasks) {
    $coreDirectory = Join-Path $task.FormatRoot $task.Architecture
    $complete = Test-CorePackage -Directory $coreDirectory -Format $task.Format -SourceFingerprint $sourceFingerprint -SdkImage $task.ResolvedImage
    if ($task.BuildLuCI) {
        $complete = $complete -and (Test-LuCIPackages -Directory (Join-Path $task.FormatRoot 'all') -Format $task.Format -SourceFingerprint $sourceFingerprint -SdkImage $task.ResolvedImage)
    }
    if ($complete -and -not $Force) {
        Write-Host "[skip] $($task.Format):$($task.Architecture)"
        continue
    }
    $task
}

Write-Host "Building $($pending.Count) of $($tasks.Count) selected SDK targets with max parallelism $Jobs."
$results = @($pending | ForEach-Object -Parallel {
    $task = $_
    $repoRoot = $using:repoRoot
    $logsRoot = $using:logsRoot
    $sourceFingerprint = $using:sourceFingerprint
    $snapshotVolume = $using:snapshotVolume
    $buildJobs = $using:BuildJobs
    $formatRoot = [IO.Path]::GetFullPath([string]$task.FormatRoot)
    $coreDirectory = Join-Path $formatRoot $task.Architecture
    $allDirectory = Join-Path $formatRoot 'all'
    [IO.Directory]::CreateDirectory($formatRoot) | Out-Null

    if (Test-Path -LiteralPath $coreDirectory) {
        [IO.Directory]::Delete($coreDirectory, $true)
    }
    if ($task.BuildLuCI -and (Test-Path -LiteralPath $allDirectory)) {
        [IO.Directory]::Delete($allDirectory, $true)
    }

    $logPath = Join-Path $logsRoot "$($task.Format)-$($task.Architecture).log"
    $pullLogPath = Join-Path $logsRoot "$($task.Format)-$($task.Architecture)-pull.log"
    $diagnosticDirectory = Join-Path $logsRoot "$($task.Format)-$($task.Architecture)"
    if (Test-Path -LiteralPath $diagnosticDirectory) {
        [IO.Directory]::Delete($diagnosticDirectory, $true)
    }
    [IO.Directory]::CreateDirectory($diagnosticDirectory) | Out-Null
    Write-Host "[pull] $($task.Image)"
    & docker pull $task.Image *> $pullLogPath
    if ($LASTEXITCODE -ne 0) {
        return [pscustomobject]@{
            Success = $false
            Key = "$($task.Format):$($task.Architecture)"
            Log = $pullLogPath
            Image = $task.Image
        }
    }
    & docker image inspect $task.ResolvedImage *> $null
    if ($LASTEXITCODE -ne 0) {
        return [pscustomobject]@{
            Success = $false
            Key = "$($task.Format):$($task.Architecture)"
            Log = $pullLogPath
            Image = $task.Image
        }
    }

    $buildLuCI = if ($task.BuildLuCI) { '1' } else { '0' }
    $corePattern = if ($task.Format -eq 'apk') { 'lucky-*.apk' } else { 'lucky_*.ipk' }
    $appPattern = if ($task.Format -eq 'apk') { 'luci-app-lucky-*.apk' } else { 'luci-app-lucky_*.ipk' }
    $i18nPattern = if ($task.Format -eq 'apk') { 'luci-i18n-lucky-zh-cn-*.apk' } else { 'luci-i18n-lucky-zh-cn_*.ipk' }
    $containerScript = @'
set -euo pipefail
finish() {
  status=$?
  trap - EXIT
  mkdir -p /work/job-logs
  [ ! -d /builder/logs ] || cp -a /builder/logs/. /work/job-logs/
  [ ! -f /builder/.config ] || cp -a /builder/.config /work/job-logs/sdk.config
  [ ! -f /builder/feeds.conf ] || cp -a /builder/feeds.conf /work/job-logs/
  printf '%s\n' "$status" > /work/job-logs/exit-code
  exit "$status"
}
trap finish EXIT
bash /work/repo/scripts/build-sdk.sh /builder /work/repo
mkdir -p "/work/output/$PACKAGE_ARCH"
mapfile -t core_files < <(find /builder/bin/packages -type f -name "$CORE_PATTERN" -print)
test "${#core_files[@]}" -eq 1
cp -v "${core_files[0]}" "/work/output/$PACKAGE_ARCH/"
printf 'OpenWrt\t%s\nFormat\t%s\nPackage-Architecture\t%s\nSDK-Image\t%s\nSource-Fingerprint\t%s\n' \
  "$OPENWRT_VERSION" "$PACKAGE_FORMAT" "$PACKAGE_ARCH" "$SDK_IMAGE" "$SOURCE_FINGERPRINT" \
  > "/work/output/$PACKAGE_ARCH/PACKAGE-METADATA.txt"
if [ "$LUCKY_BUILD_LUCI" = "1" ]; then
  mkdir -p /work/output/all
  mapfile -t luci_files < <(find /builder/bin/packages -type f \
    \( -name "$LUCI_APP_PATTERN" -o -name "$LUCI_I18N_PATTERN" \) -print)
  test "${#luci_files[@]}" -eq 2
  cp -v "${luci_files[@]}" /work/output/all/
  printf 'SDK-Image\t%s\nSource-Fingerprint\t%s\n' "$SDK_IMAGE" "$SOURCE_FINGERPRINT" \
    > /work/output/all/SDK-METADATA.txt
fi
'@
    $dockerArguments = @(
        'run', '--rm',
        '--env', "LUCKY_BUILD_LUCI=$buildLuCI",
        '--env', "LUCKY_MAKE_JOBS=$buildJobs",
        '--env', "OPENWRT_VERSION=$($task.Version)",
        '--env', "PACKAGE_FORMAT=$($task.Format)",
        '--env', "PACKAGE_ARCH=$($task.Architecture)",
        '--env', "SDK_IMAGE=$($task.ResolvedImage)",
        '--env', "SOURCE_FINGERPRINT=$sourceFingerprint",
        '--env', "CORE_PATTERN=$corePattern",
        '--env', "LUCI_APP_PATTERN=$appPattern",
        '--env', "LUCI_I18N_PATTERN=$i18nPattern",
        '--mount', "type=volume,source=$snapshotVolume,target=/work/repo,readonly",
        '--mount', "type=bind,source=$formatRoot,target=/work/output",
        '--mount', "type=bind,source=$diagnosticDirectory,target=/work/job-logs",
        $task.ResolvedImage,
        '/bin/bash', '-lc', $containerScript
    )
    Write-Host "[build] $($task.Format):$($task.Architecture)"
    & docker @dockerArguments *> $logPath
    $dockerExitCode = $LASTEXITCODE
    $coreFiles = @(Get-ChildItem -LiteralPath $coreDirectory -File -Filter $corePattern -ErrorAction SilentlyContinue)
    $metadataExists = Test-Path -LiteralPath (Join-Path $coreDirectory 'PACKAGE-METADATA.txt')
    $outputComplete = $coreFiles.Count -eq 1 -and $metadataExists
    if ($task.BuildLuCI) {
        $appFiles = @(Get-ChildItem -LiteralPath $allDirectory -File -Filter $appPattern -ErrorAction SilentlyContinue)
        $i18nFiles = @(Get-ChildItem -LiteralPath $allDirectory -File -Filter $i18nPattern -ErrorAction SilentlyContinue)
        $outputComplete = $outputComplete -and $appFiles.Count -eq 1 -and $i18nFiles.Count -eq 1
    }
    $reportedExitCodePath = Join-Path $diagnosticDirectory 'exit-code'
    $reportedExitCode = if (Test-Path -LiteralPath $reportedExitCodePath) {
        (Get-Content -Raw -LiteralPath $reportedExitCodePath).Trim()
    }
    else {
        '<missing>'
    }
    [pscustomobject]@{
        Success = $reportedExitCode -eq '0' -and $outputComplete
        Key = "$($task.Format):$($task.Architecture)"
        Log = $logPath
        Image = $task.Image
        DockerExitCode = $dockerExitCode
        ContainerExitCode = $reportedExitCode
    }
} -ThrottleLimit $Jobs)

$failed = @($results | Where-Object { -not $_.Success })
if ($failed.Count -gt 0) {
    Write-Error ("Failed targets:`n" + (($failed | ForEach-Object {
        "  $($_.Key): docker=$($_.DockerExitCode), container=$($_.ContainerExitCode), log=$($_.Log)"
    }) -join "`n"))
    exit 1
}

if ($RemoveImages) {
    foreach ($image in @($results.Image | Sort-Object -Unique)) {
        Write-Host "[remove image] $image"
        & docker image rm $image *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not remove $image"
        }
    }
}

if ($filters.Count -gt 0) {
    Write-Host "Selected local builds completed under $packagesRoot"
    exit 0
}

$apkRoot = Join-Path $packagesRoot "openwrt-$ApkVersion/apk"
$ipkRoot = Join-Path $packagesRoot "openwrt-$IpkVersion/ipk"
foreach ($format in @('apk', 'ipk')) {
    $version = $versions[$format]
    $formatRoot = Join-Path $packagesRoot "openwrt-$version/$format"
    foreach ($entry in $matrix.$format) {
        $architecture = [string]$entry.package_arch
        $lockedImage = $sdkLockIndex["${format}:$architecture"]
        $architectureRoot = Join-Path $formatRoot $architecture
        if (-not (Test-CorePackage -Directory $architectureRoot -Format $format -SourceFingerprint $sourceFingerprint -SdkImage $lockedImage.image)) {
            throw "Incomplete or mismatched package: ${format}:$architecture"
        }
    }
    $x86Image = $sdkLockIndex["${format}:x86_64"].image
    if (-not (Test-LuCIPackages -Directory (Join-Path $formatRoot 'all') -Format $format -SourceFingerprint $sourceFingerprint -SdkImage $x86Image)) {
        throw "Incomplete or mismatched LuCI packages for $format"
    }
}
$apkCoreCount = @(Get-ChildItem -LiteralPath $apkRoot -Recurse -File -Filter 'lucky-*.apk').Count
$ipkCoreCount = @(Get-ChildItem -LiteralPath $ipkRoot -Recurse -File -Filter 'lucky_*.ipk').Count
if ($apkCoreCount -ne 26 -or $ipkCoreCount -ne 27) {
    throw "Incomplete core package set: APK=$apkCoreCount/26, IPK=$ipkCoreCount/27"
}
$packageFiles = @(Get-ChildItem -LiteralPath $packagesRoot -Recurse -File | Where-Object {
    $_.Extension -in @('.apk', '.ipk')
} | Sort-Object FullName)
if ($packageFiles.Count -ne 57) {
    throw "Unexpected installable package count: $($packageFiles.Count), expected exactly 57"
}
$checksumLines = foreach ($file in $packageFiles) {
    $relative = [IO.Path]::GetRelativePath($outputRoot, $file.FullName).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $relative"
}
[IO.File]::WriteAllLines(
    (Join-Path $outputRoot 'SHA256SUMS'),
    $checksumLines,
    [Text.UTF8Encoding]::new($false)
)

$manifestArguments = @(
    (Join-Path $repoRoot 'scripts/create-release-manifest.py'),
    $packagesRoot,
    (Join-Path $outputRoot 'MANIFEST.json'),
    '--commit', $sourceCommit,
    '--source-fingerprint', $sourceFingerprint
)
if ($sourceDirty) {
    $manifestArguments += '--source-dirty'
}
Invoke-CheckedCommand python $manifestArguments

$buildInfo = @"
Lucky complete local OpenWrt package set / Lucky OpenWrt 本地全架构软件包
OpenWrt ${ApkVersion}: 26 architecture-specific APK core packages
OpenWrt ${IpkVersion}: 27 architecture-specific IPK core packages
LuCI application and zh-cn translation: one architecture-independent package per format
LuCI 应用和简体中文翻译：每种格式各一份 all 架构包
Git commit: $sourceCommit
Source fingerprint: $sourceFingerprint
Source snapshot volume: $snapshotVolume
SDK lock SHA-256: $sdkLockSha256
Source tree dirty / 源码包含未提交修改: $($sourceDirty.ToString().ToLowerInvariant())
"@
[IO.File]::WriteAllText(
    (Join-Path $outputRoot 'BUILD-INFO.txt'),
    $buildInfo,
    [Text.UTF8Encoding]::new($false)
)

Write-Host "Local build complete: $($packageFiles.Count) installable packages"
Write-Host "Output: $outputRoot"
