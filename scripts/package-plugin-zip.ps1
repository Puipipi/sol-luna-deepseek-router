param(
    [Parameter(Mandatory = $true)][ValidateSet('create', 'inspect', 'manifest')][string]$Action,
    [string]$Stage,
    [string]$Zip
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

if ($Action -eq 'create') {
    if (-not $Stage -or -not $Zip) { throw 'ZIP create requires stage and output paths.' }
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $Stage,
        $Zip,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )
    exit 0
}

if (-not $Zip) { throw 'ZIP inspect requires an archive path.' }
$archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    if ($Action -eq 'manifest') {
        $manifestEntry = $archive.GetEntry('package-manifest.json')
        if (-not $manifestEntry) { throw 'Package manifest is missing from the ZIP.' }
        $input = $manifestEntry.Open()
        $output = [System.IO.MemoryStream]::new()
        try {
            $input.CopyTo($output)
            [Convert]::ToBase64String($output.ToArray())
        } finally {
            $input.Dispose()
            $output.Dispose()
        }
        exit 0
    }
    $entries = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $archive.Entries) {
        $stream = $entry.Open()
        try {
            $hashBytes = $sha.ComputeHash($stream)
            $hash = [BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
        } finally {
            $stream.Dispose()
        }
        $entries.Add([ordered]@{
            path = $entry.FullName.Replace([char]92, [char]47)
            size = [long]$entry.Length
            sha256 = $hash
        })
    }
    ConvertTo-Json -InputObject @($entries.ToArray()) -Compress -Depth 3
} finally {
    $sha.Dispose()
    $archive.Dispose()
}
