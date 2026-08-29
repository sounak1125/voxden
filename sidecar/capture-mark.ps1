param(
  [int]$Left,
  [int]$Top,
  [int]$Width,
  [int]$Height,
  [int]$Cx,
  [int]$Cy,
  [int]$Radius,
  [string]$Out
)

Add-Type -AssemblyName System.Drawing
if ($Width -lt 1) { $Width = 1 }
if ($Height -lt 1) { $Height = 1 }
if ($Radius -lt 24) { $Radius = 40 }

$bmp = New-Object System.Drawing.Bitmap $Width, $Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($Left, $Top, 0, 0, (New-Object System.Drawing.Size $Width, $Height))
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 82, 82), 4)
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(36, 255, 82, 82))
$d = [int]($Radius * 2)
$g.FillEllipse($brush, ($Cx - $Radius), ($Cy - $Radius), $d, $d)
$g.DrawEllipse($pen, ($Cx - $Radius), ($Cy - $Radius), $d, $d)
$dir = Split-Path $Out
if ($dir -and !(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$pen.Dispose()
$brush.Dispose()
