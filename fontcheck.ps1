# fontcheck — 按「值」查注册表确认霞鹜文楷 GB 是否在机（键名是中文，按键名搜必 0 命中）
# 用法: fontcheck.ps1 [关键字，默认 LXGWWenKaiGB]；命中退出码 0，未命中 1
param([string]$Key = 'LXGWWenKaiGB')
$hits = @()
foreach ($root in 'HKCU:', 'HKLM:') {
  $path = $root + '\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts'
  $hits += (Get-ItemProperty $path).PSObject.Properties |
    Where-Object Value -match $Key | ForEach-Object { "$($_.Name) => $($_.Value)" }
}
if ($hits) { $hits } else { Write-Output "MISS: '$Key' not found in font registry (searched by value)"; exit 1 }
