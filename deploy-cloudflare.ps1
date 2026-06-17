param(
  [string]$AccountId = $env:CLOUDFLARE_ACCOUNT_ID,
  [string]$ApiToken = $env:CLOUDFLARE_API_TOKEN,
  [string]$ScriptName = "aihot-feishu-briefing",
  [string]$Cron = "29 13 * * *",
  [string]$KvTitle = "AIHOT_KV",
  [string]$WorkerPath = ".\src\index.js",
  [string]$AdminToken = $env:ADMIN_TOKEN,
  [string]$OpenAIKey = $env:OPENAI_API_KEY,
  [string]$OpenAIBaseURL = $env:OPENAI_BASE_URL,
  [string]$OpenAIModel = "gpt-5.5",
  [string]$FeishuWebhook = $env:FEISHU_WEBHOOK,
  [string]$FeishuSecret = $env:FEISHU_SECRET,
  [string]$FeishuAppId = $env:FEISHU_APP_ID,
  [string]$FeishuAppSecret = $env:FEISHU_APP_SECRET,
  [string]$FeishuBitableAppToken = $env:FEISHU_BITABLE_APP_TOKEN,
  [string]$FeishuBitableTableId = $env:FEISHU_BITABLE_TABLE_ID,
  [string]$FeishuBitableUrl = $env:FEISHU_BITABLE_URL,
  [string]$PublicBaseURL = $env:PUBLIC_BASE_URL,
  [string]$AIHotMaxPages = $(if ($env:AIHOT_MAX_PAGES) { $env:AIHOT_MAX_PAGES } else { "6" }),
  [string]$AIHotPaperMaxPages = $(if ($env:AIHOT_PAPER_MAX_PAGES) { $env:AIHOT_PAPER_MAX_PAGES } else { "6" }),
  [string]$AIHotBitableMaxRecords = $(if ($env:AIHOT_BITABLE_MAX_RECORDS) { $env:AIHOT_BITABLE_MAX_RECORDS } else { "120" })
)

$ErrorActionPreference = "Stop"

if (-not $ApiToken) { throw "CLOUDFLARE_API_TOKEN is missing." }
if (-not $AccountId) { throw "CLOUDFLARE_ACCOUNT_ID is missing." }
if (-not (Test-Path -LiteralPath $WorkerPath)) { throw "Worker script not found: $WorkerPath" }
$resolvedWorkerPath = (Resolve-Path -LiteralPath $WorkerPath).Path
$workerRoot = Split-Path -Parent $resolvedWorkerPath
$mainModuleName = Split-Path -Leaf $resolvedWorkerPath
$moduleFiles = Get-ChildItem -LiteralPath $workerRoot -Filter *.js | Sort-Object Name
if (-not $AdminToken) {
  $randomBytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($randomBytes)
  $rng.Dispose()
  $AdminToken = [Convert]::ToBase64String($randomBytes)
}

$base = "https://api.cloudflare.com/client/v4/accounts/$AccountId"
$auth = @{ Authorization = "Bearer $ApiToken"; "Content-Type" = "application/json" }

function Invoke-CfJson {
  param([string]$Method, [string]$Uri, $Body = $null)
  $args = @{ Method = $Method; Uri = $Uri; Headers = $auth }
  if ($null -ne $Body) { $args.Body = (ConvertTo-Json -InputObject $Body -Depth 20) }
  try {
    $response = Invoke-RestMethod @args
  } catch {
    if ($_.Exception.Response) {
      $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
      throw $reader.ReadToEnd()
    }
    throw
  }
  if (-not $response.success) {
    throw (($response.errors | ConvertTo-Json -Depth 10) -as [string])
  }
  return $response.result
}

$namespaces = Invoke-CfJson -Method Get -Uri "$base/storage/kv/namespaces?per_page=100"
$kv = $namespaces | Where-Object { $_.title -eq $KvTitle } | Select-Object -First 1
if (-not $kv) {
  $kv = Invoke-CfJson -Method Post -Uri "$base/storage/kv/namespaces" -Body @{ title = $KvTitle }
}

$metadata = @{
  main_module = $mainModuleName
  compatibility_date = "2025-05-30"
  bindings = @(
    @{
      type = "kv_namespace"
      name = "AIHOT_KV"
      namespace_id = $kv.id
    }
  )
} | ConvertTo-Json -Depth 20

$boundary = "----aihot-" + [Guid]::NewGuid().ToString("N")
$encoding = [Text.Encoding]::UTF8
$body = New-Object System.Collections.Generic.List[byte]

function Add-BodyString([string]$Text) {
  $body.AddRange($encoding.GetBytes($Text))
}

Add-BodyString "--$boundary`r`n"
Add-BodyString "Content-Disposition: form-data; name=`"metadata`"`r`n"
Add-BodyString "Content-Type: application/json`r`n`r`n"
Add-BodyString "$metadata`r`n"
foreach ($moduleFile in $moduleFiles) {
  Add-BodyString "--$boundary`r`n"
  Add-BodyString "Content-Disposition: form-data; name=`"$($moduleFile.Name)`"; filename=`"$($moduleFile.Name)`"`r`n"
  Add-BodyString "Content-Type: application/javascript+module`r`n`r`n"
  $body.AddRange([IO.File]::ReadAllBytes($moduleFile.FullName))
  Add-BodyString "`r`n"
}
Add-BodyString "--$boundary--`r`n"

$uploadHeaders = @{ Authorization = "Bearer $ApiToken" }
try {
  $upload = Invoke-RestMethod `
    -Method Put `
    -Uri "$base/workers/scripts/$ScriptName" `
    -Headers $uploadHeaders `
    -ContentType "multipart/form-data; boundary=$boundary" `
    -Body $body.ToArray()
} catch {
  if ($_.Exception.Response) {
    $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
    throw $reader.ReadToEnd()
  }
  throw
}

if (-not $upload.success) {
  throw (($upload.errors | ConvertTo-Json -Depth 10) -as [string])
}

function Put-WorkerSecret {
  param([string]$Name, [string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return }
  Invoke-CfJson -Method Put -Uri "$base/workers/scripts/$ScriptName/secrets" -Body @{
    name = $Name
    text = $Text
    type = "secret_text"
  } | Out-Null
}

Put-WorkerSecret -Name "ADMIN_TOKEN" -Text $AdminToken
Put-WorkerSecret -Name "OPENAI_API_KEY" -Text $OpenAIKey
Put-WorkerSecret -Name "OPENAI_BASE_URL" -Text $OpenAIBaseURL
Put-WorkerSecret -Name "OPENAI_MODEL" -Text $OpenAIModel
Put-WorkerSecret -Name "FEISHU_WEBHOOK" -Text $FeishuWebhook
Put-WorkerSecret -Name "FEISHU_SECRET" -Text $FeishuSecret
Put-WorkerSecret -Name "FEISHU_APP_ID" -Text $FeishuAppId
Put-WorkerSecret -Name "FEISHU_APP_SECRET" -Text $FeishuAppSecret
Put-WorkerSecret -Name "FEISHU_BITABLE_APP_TOKEN" -Text $FeishuBitableAppToken
Put-WorkerSecret -Name "FEISHU_BITABLE_TABLE_ID" -Text $FeishuBitableTableId
Put-WorkerSecret -Name "FEISHU_BITABLE_URL" -Text $FeishuBitableUrl
Put-WorkerSecret -Name "PUBLIC_BASE_URL" -Text $PublicBaseURL
Put-WorkerSecret -Name "AIHOT_MAX_PAGES" -Text $AIHotMaxPages
Put-WorkerSecret -Name "AIHOT_PAPER_MAX_PAGES" -Text $AIHotPaperMaxPages
Put-WorkerSecret -Name "AIHOT_BITABLE_MAX_RECORDS" -Text $AIHotBitableMaxRecords

Invoke-CfJson -Method Put -Uri "$base/workers/scripts/$ScriptName/schedules" -Body @(@{ cron = $Cron }) | Out-Null

try {
  Invoke-CfJson -Method Post -Uri "$base/workers/scripts/$ScriptName/subdomain" -Body @{ enabled = $true } | Out-Null
} catch {
  try {
    Invoke-CfJson -Method Put -Uri "$base/workers/scripts/$ScriptName/subdomain" -Body @{ enabled = $true } | Out-Null
  } catch {
    Write-Warning "Worker deployed, but enabling workers.dev subdomain failed. Enable workers.dev route in Cloudflare dashboard if needed."
  }
}

$subdomain = Invoke-CfJson -Method Get -Uri "$base/workers/subdomain"
$url = "https://$ScriptName.$($subdomain.subdomain).workers.dev"

[pscustomobject]@{
  ok = $true
  worker = $ScriptName
  url = $url
  kvNamespace = $kv.title
  cron = $Cron
  model = $OpenAIModel
} | ConvertTo-Json -Compress
