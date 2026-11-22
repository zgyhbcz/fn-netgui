#!/usr/bin/env pwsh
<#
.SYNOPSIS
    把 fn-netgui 发布到 GitHub（创建仓库 + 首次推送）。

.DESCRIPTION
    需要环境变量 GH_TOKEN：一个带 repo + workflow 权限的 PAT
    （若还要删仓库，额外勾 delete_repo，见 README 的“发布”一节）。

.EXAMPLE
    $env:GH_TOKEN = "ghp_xxx"
    pwsh -File tools/publish.ps1
#>
param(
    [string]$Owner = "zgyhbcz",
    [string]$Repo = "fn-netgui",
    [string]$Description = "飞牛 fnOS 网络配置管家：第二网口 NAT 共享 / OVS 桥接 / WiFi 热点 / MAC 与静态 IP，fpk 一键安装",
    [switch]$Private
)

$ErrorActionPreference = "Stop"

if (-not $env:GH_TOKEN) {
    throw "未设置 GH_TOKEN。请先 `$env:GH_TOKEN = '<你的 PAT>'`（需要 repo + workflow 权限）。"
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
    $headers = @{
        Authorization          = "Bearer $env:GH_TOKEN"
        Accept                 = "application/vnd.github+json"
        "User-Agent"           = "fn-netgui-publish"
        "X-GitHub-Api-Version" = "2022-11-28"
    }

    Write-Host "[1/4] 检查仓库 $Owner/$Repo 是否存在…"
    $exists = $false
    try {
        Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo" -Headers $headers | Out-Null
        $exists = $true
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
    }

    if (-not $exists) {
        Write-Host "[2/4] 创建仓库…"
        $body = @{
            name        = $Repo
            description = $Description
            private     = [bool]$Private
            has_issues  = $true
            has_wiki    = $false
        } | ConvertTo-Json
        Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Method Post -Headers $headers -Body $body -ContentType "application/json" | Out-Null
        Write-Host "      已创建 https://github.com/$Owner/$Repo"
    } else {
        Write-Host "      已存在，跳过创建"
    }

    Write-Host "[3/4] 配置 topics…"
    $topics = @{ names = @("fnos", "fnnas", "fpk", "nas", "networkmanager", "nmcli", "ovs", "homelab") } | ConvertTo-Json
    try {
        Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/topics" -Method Put -Headers $headers -Body $topics -ContentType "application/json" | Out-Null
        Write-Host "      topics 已更新"
    } catch {
        Write-Warning "      topics 更新失败（不影响代码）：$($_.Exception.Message)"
    }

    Write-Host "[4/4] 推送 main…"
    if (-not (git remote get-url origin 2>$null)) {
        git remote add origin "https://github.com/$Owner/$Repo.git"
    } else {
        git remote set-url origin "https://github.com/$Owner/$Repo.git"
    }
    git push -u origin main
    Write-Host ""
    Write-Host "完成：https://github.com/$Owner/$Repo"
} finally {
    Pop-Location
}
