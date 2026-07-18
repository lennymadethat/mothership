# Generates PWA icons (dark rounded square, blue M, green status dot)
Add-Type -AssemblyName System.Drawing
$out = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'web\icons'
New-Item -ItemType Directory -Force $out | Out-Null

foreach ($size in 192, 512) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'

  # rounded dark background
  $r = [int]($size * 0.22)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $r*2, $r*2, 180, 90)
  $path.AddArc($size-$r*2, 0, $r*2, $r*2, 270, 90)
  $path.AddArc($size-$r*2, $size-$r*2, $r*2, $r*2, 0, 90)
  $path.AddArc(0, $size-$r*2, $r*2, $r*2, 90, 90)
  $path.CloseFigure()
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0,0)), (New-Object System.Drawing.Point($size,$size)),
    [System.Drawing.Color]::FromArgb(255,13,18,32), [System.Drawing.Color]::FromArgb(255,7,10,18))
  $g.FillPath($bg, $path)

  # "M"
  $font = New-Object System.Drawing.Font('Segoe UI', [int]($size*0.42), [System.Drawing.FontStyle]::Bold)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,91,157,255))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString('M', $font, $brush, (New-Object System.Drawing.RectangleF(0, [int](-$size*0.03), $size, $size)), $fmt)

  # green dot (online)
  $dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,61,220,132))
  $d = [int]($size * 0.14)
  $g.FillEllipse($dot, $size - $d - [int]($size*0.16), $size - $d - [int]($size*0.16), $d, $d)

  $bmp.Save((Join-Path $out "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "icon-$size.png"
}
