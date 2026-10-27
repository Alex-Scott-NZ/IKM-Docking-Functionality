param([Parameter(Mandatory)][string]$CertificatePath, [Parameter(Mandatory)][securestring]$CertificatePassword)
Connect-PnPOnline -Url https://5pbdxb.sharepoint.com/sites/kc-sandpit -ClientId 142ad364-8e71-48f6-b8b1-93d85722c255 -Tenant a0478f05-ac37-4902-b66b-7228393e7362 -CertificatePath $CertificatePath -CertificatePassword $CertificatePassword
$item = Get-PnPListItem -List 'Lists/TenantWideExtensions' -Id 1
$p = $item['TenantWideExtensionComponentProperties'] | ConvertFrom-Json -AsHashtable
$orig = $item['TenantWideExtensionComponentProperties']
Set-Content -Path ./twe-sandpit-original.json -Value $orig
function U($t,$side,$align,$pri){ $u=@{enabled=$true;minimiseTarget=$t;bottomSide=$side;defaultState='expanded';priority=$pri}; if($align){$u.edgeAlign=$align}; $u }
$z = @{
 'zt-bl-a'=U 'bottom' 'left' $null 40; 'zt-bl-b'=U 'bottom' 'left' $null 41; 'zt-bl-c'=U 'bottom' 'left' $null 42;
 'zt-br-a'=U 'bottom' 'right' $null 40; 'zt-br-b'=U 'bottom' 'right' $null 41;
 'zt-el-a'=U 'edge-left' 'right' $null 40; 'zt-el-b'=U 'edge-left' 'right' $null 41; 'zt-el-c'=U 'edge-left' 'right' $null 42;
 'zt-er-a'=U 'edge-right' 'right' $null 40;
 'zt-erb-a'=U 'edge-right' 'right' 'bottom' 40; 'zt-erb-b'=U 'edge-right' 'right' 'bottom' 41; 'zt-erb-c'=U 'edge-right' 'right' 'bottom' 42;
 'zt-elt-a'=U 'edge-left' 'right' 'top' 40; 'zt-elt-b'=U 'edge-left' 'right' 'top' 41
}
foreach($k in $z.Keys){ $p.utilities[$k]=$z[$k] }
$json = $p | ConvertTo-Json -Depth 6 -Compress
Set-PnPListItem -List 'Lists/TenantWideExtensions' -Identity 1 -Values @{TenantWideExtensionComponentProperties=$json} | Out-Null
(Get-PnPListItem -List 'Lists/TenantWideExtensions' -Id 1)['TenantWideExtensionComponentProperties'].Length
