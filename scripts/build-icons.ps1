Add-Type -AssemblyName System.Drawing

# 生成 PWA 图标：整幅陶土橙底（maskable 安全区留白）+ 白色 corner 品牌标记
# 系统会自动做圆角/圆形裁切，所以图标本身不需要圆角。
function New-CornerIcon {
  param([int]$Size, [string]$Out)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::FromArgb(255, 210, 96, 58))

  # 安全区：标记画在中间 62% 区域，避免被裁切
  $cx = [float]($Size / 2)
  $cy = [float]($Size / 2)
  $half = [float]($Size * 0.31)
  $arm = [float]($Size * 0.115)
  $w = [float]($Size * 0.052)
  $white = [System.Drawing.Color]::FromArgb(255, 253, 248, 242)

  $pen = New-Object System.Drawing.Pen($white, $w)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

  $l = $cx - $half
  $r = $cx + $half
  $t = $cy - $half
  $b = $cy + $half

  # 左上
  $g.DrawLine($pen, [float]$l, [float]($t + $arm), [float]$l, [float]$t)
  $g.DrawLine($pen, [float]$l, [float]$t, [float]($l + $arm), [float]$t)
  # 右上
  $g.DrawLine($pen, [float]($r - $arm), [float]$t, [float]$r, [float]$t)
  $g.DrawLine($pen, [float]$r, [float]$t, [float]$r, [float]($t + $arm))
  # 右下
  $g.DrawLine($pen, [float]$r, [float]($b - $arm), [float]$r, [float]$b)
  $g.DrawLine($pen, [float]$r, [float]$b, [float]($r - $arm), [float]$b)
  # 左下
  $g.DrawLine($pen, [float]($l + $arm), [float]$b, [float]$l, [float]$b)
  $g.DrawLine($pen, [float]$l, [float]$b, [float]$l, [float]($b - $arm))

  # 中心点
  $dotR = [float]($Size * 0.095)
  $dotBrush = New-Object System.Drawing.SolidBrush($white)
  $g.FillEllipse($dotBrush, [float]($cx - $dotR), [float]($cy - $dotR), [float]($dotR * 2), [float]($dotR * 2))

  $g.Dispose()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("wrote {0} ({1}x{1}) {2} KB" -f $Out, $Size, [math]::Round((Get-Item $Out).Length / 1KB))
}

New-Item -ItemType Directory -Force -Path 'D:\OneProject\app\public\icons' | Out-Null
New-CornerIcon -Size 192 -Out 'D:\OneProject\app\public\icons\icon-192.png'
New-CornerIcon -Size 512 -Out 'D:\OneProject\app\public\icons\icon-512.png'
New-CornerIcon -Size 180 -Out 'D:\OneProject\app\public\icons\apple-touch-icon.png'
New-CornerIcon -Size 32 -Out 'D:\OneProject\app\public\icons\favicon-32.png'
