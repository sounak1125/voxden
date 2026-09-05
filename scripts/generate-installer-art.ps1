$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$artDirectory = Join-Path $projectRoot 'build'
$iconPath = Join-Path $projectRoot 'assets/icon.png'
[void][System.IO.Directory]::CreateDirectory($artDirectory)

# icon.png is the Windows-ready export of the supplied icon-reference.png.
# Composite its pixels directly: never reconstruct the waveform or its tile.
$logo = [System.Drawing.Image]::FromFile($iconPath)
$scale = 4
$exportScale = 2

function Color([string]$Hex) {
    return [System.Drawing.ColorTranslator]::FromHtml($Hex)
}

function Write-Art([string]$Name, [int]$Width, [int]$Height, [scriptblock]$Paint, [bool]$Dither = $false) {
    # Keep artwork at 2x for high-DPI displays. All lettering is rendered by
    # native NSIS controls at the display's actual resolution, never in a BMP.
    $outWidth = $Width * $exportScale
    $outHeight = $Height * $exportScale
    $large = [System.Drawing.Bitmap]::new($Width * $scale, $Height * $scale, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($large)
    $output = [System.Drawing.Bitmap]::new($outWidth, $outHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $downsample = [System.Drawing.Graphics]::FromImage($output)
    try {
        $graphics.ScaleTransform($scale, $scale)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        & $Paint $graphics

        $downsample.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $downsample.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $downsample.DrawImage($large, [System.Drawing.Rectangle]::new(0, 0, $outWidth, $outHeight))

        # Deterministic one-level grain breaks up 8-bit gradient bands.
        if ($Dither) {
            $noise = [System.Random]::new(821)
            for ($y = 0; $y -lt $outHeight; $y++) {
                for ($x = 0; $x -lt $outWidth; $x++) {
                    $jitter = $noise.Next(-1, 2)
                    $inLogo = $x -ge (34 * $exportScale) -and $x -lt (130 * $exportScale) -and $y -ge (47 * $exportScale) -and $y -lt (143 * $exportScale)
                    if ($inLogo) { continue }
                    $pixel = $output.GetPixel($x, $y)
                    $output.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(
                        [Math]::Max(0, [Math]::Min(255, [int]$pixel.R + $jitter)),
                        [Math]::Max(0, [Math]::Min(255, [int]$pixel.G + $jitter)),
                        [Math]::Max(0, [Math]::Min(255, [int]$pixel.B + $jitter))))
                }
            }
        }
        $output.Save((Join-Path $artDirectory $Name), [System.Drawing.Imaging.ImageFormat]::Bmp)
        Write-Output "Wrote build/$Name ($($outWidth)x$outHeight, 24-bit, no bitmap text)"
    } finally {
        $downsample.Dispose(); $output.Dispose(); $graphics.Dispose(); $large.Dispose()
    }
}

try {
    Write-Art 'installerSidebar.bmp' 164 314 {
        param($g)
        $gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            [System.Drawing.Rectangle]::new(0, 0, 164, 314), (Color '#14221e'), (Color '#0a0f12'), [single]90)
        try { $g.FillRectangle($gradient, 0, 0, 164, 314) } finally { $gradient.Dispose() }
        $g.DrawImage($logo, [System.Drawing.RectangleF]::new(34, 47, 96, 96))
        $rule = [System.Drawing.Pen]::new((Color '#518e73'), [single]0.75)
        try { $g.DrawLine($rule, [single]70, [single]253, [single]94, [single]253) } finally { $rule.Dispose() }
    } $true

    Write-Art 'installerHeader.bmp' 150 57 {
        param($g)
        $g.Clear([System.Drawing.Color]::White)
        $g.DrawImage($logo, [System.Drawing.RectangleF]::new(103, 10, 36, 36))
    }
} finally {
    $logo.Dispose()
}
