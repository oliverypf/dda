$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IconHandle {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyIcon(IntPtr handle);
}
'@

$iconDirectory = Join-Path $PSScriptRoot '..\src-tauri\icons'
New-Item -ItemType Directory -Force $iconDirectory | Out-Null
$pngPath = Join-Path $iconDirectory 'app-icon.png'
$icoPath = Join-Path $iconDirectory 'icon.ico'

function New-BrandBitmap([int] $size) {
    $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.Clear([Drawing.Color]::Transparent)

    $margin = [single]($size * 0.0625)
    $radius = [single]($size * 0.1875)
    $path = [Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $radius * 2
    $path.AddArc($margin, $margin, $diameter, $diameter, 180, 90)
    $path.AddArc($size - $margin - $diameter, $margin, $diameter, $diameter, 270, 90)
    $path.AddArc($size - $margin - $diameter, $size - $margin - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($margin, $size - $margin - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    $graphics.FillPath([Drawing.Brushes]::Black, $path)

    $fontSize = [single]($size * 0.30)
    $font = [Drawing.Font]::new('Segoe UI', $fontSize, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
    $format = [Drawing.StringFormat]::new()
    $format.Alignment = [Drawing.StringAlignment]::Center
    $format.LineAlignment = [Drawing.StringAlignment]::Center
    $graphics.DrawString('dda', $font, [Drawing.Brushes]::White, [Drawing.RectangleF]::new(0, $size * 0.01, $size, $size * 0.98), $format)

    $format.Dispose()
    $font.Dispose()
    $path.Dispose()
    $graphics.Dispose()
    return $bitmap
}

$large = New-BrandBitmap 512
$large.Save($pngPath, [Drawing.Imaging.ImageFormat]::Png)

$small = [Drawing.Bitmap]::new($large, 256, 256)
$handle = $small.GetHicon()
$icon = [Drawing.Icon]::FromHandle($handle)
$stream = [IO.File]::Create($icoPath)
$icon.Save($stream)
$stream.Dispose()
$icon.Dispose()
[IconHandle]::DestroyIcon($handle) | Out-Null
$small.Dispose()
$large.Dispose()

Write-Host "Generated $pngPath"
Write-Host "Generated $icoPath"
