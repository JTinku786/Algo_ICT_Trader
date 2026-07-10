param(
  [string]$ShareToken = "algoicttraderapi",
  [string]$ZrokPath = "zrok"
)

$ErrorActionPreference = "Stop"

& $ZrokPath share reserved $ShareToken --headless
