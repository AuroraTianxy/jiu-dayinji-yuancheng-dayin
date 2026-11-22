# Run explicitly on the printer Windows PC. Never displays the token.
[CmdletBinding()]
param([string]$TokenPath = (Join-Path $PSScriptRoot 'agent.token'))
$ErrorActionPreference = 'Stop'
$target = [System.IO.Path]::GetFullPath($TokenPath)
if (Test-Path -LiteralPath $target) { throw 'Token file already exists. Inspect it before replacing it.' }
$secret = Read-Host 'Paste this print agent token (hidden)' -AsSecureString
$token = [System.Net.NetworkCredential]::new('', $secret).Password
if ($token.Length -lt 32 -or $token.Length -gt 8192 -or $token -match '\s') { throw 'Invalid token format.' }
# Create an empty file, restrict ACL, then write the credential.
$stream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
$stream.Close()
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
[System.IO.File]::WriteAllText($target, $token, (New-Object System.Text.UTF8Encoding($false)))
$token = $null
$secret.Dispose()
Write-Host 'Saved private agent.token for this Windows user. Token not displayed.'
