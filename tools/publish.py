#!/usr/bin/env python3
"""用 GitHub REST API 建仓库并上传当前 git 索引的内容（一次提交）。

为什么不用 `git push`：本机到 github.com:443 的连接时通时断（TCP 三次握手经常超时），
而 api.github.com 稳定可达。Git Data API 只需要 api.github.com，能绕开这个问题。

前置：一个 PAT（Fine-grained 或 Classic 均可）
  - 上传：需要 Contents: Read and write（classic 的 repo）
  - 删除仓库：需要 Administration: Read and write（classic 的 delete_repo）

用法：
    export GH_TOKEN=github_pat_xxx          # Windows: $env:GH_TOKEN="..."
    python tools/publish.py --dry-run       # 只打印将要做什么
    python tools/publish.py                 # 建仓库（若不存在）+ 上传
    python tools/publish.py --repo fn-netgui --private
    python tools/publish.py --delete zgyhbcz/hosts --yes

退出码：0 成功；1 失败；2 参数/环境错误。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.github.com"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OWNER = "zgyhbcz"
DEFAULT_REPO = "fn-netgui"
DEFAULT_BRANCH = "main"
TOPICS = ["fnos", "fnnas", "fpk", "nas", "networkmanager", "nmcli", "ovs", "homelab"]


# ---------------------------------------------------------------- HTTP

def request(method: str, path: str, token: str, payload: dict | None = None) -> tuple[int, object]:
    url = path if path.startswith("http") else f"{API}{path}"
    data = None
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "fn-netgui-publish",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    last_error = ""
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=45) as resp:
                body = resp.read()
                return resp.status, (json.loads(body) if body.strip() else None)
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", "replace")
            if err.code in (429, 500, 502, 503, 504) and attempt < 3:
                wait = 2 ** attempt
                print(f"  [!] {err.code}，{wait}s 后重试（{attempt + 1}/3）")
                time.sleep(wait)
                continue
            try:
                detail = json.loads(body).get("message", body)
            except Exception:  # noqa: BLE001
                detail = body
            raise RuntimeError(f"{method} {path} -> HTTP {err.code}: {detail}") from None
        except urllib.error.URLError as err:
            last_error = str(err.reason)
            if attempt < 3:
                wait = 2 ** attempt
                print(f"  [!] 网络错误 {last_error}，{wait}s 后重试")
                time.sleep(wait)
                continue
            raise RuntimeError(f"{method} {url} 连接失败：{last_error}") from None
    raise RuntimeError(f"{method} {url} 失败：{last_error}")


def get_optional(path: str, token: str) -> object | None:
    try:
        _, body = request("GET", path, token)
        return body
    except RuntimeError as err:
        if "HTTP 404" in str(err) or "HTTP 409" in str(err):
            return None
        raise


# ---------------------------------------------------------------- git

def git(*args: str) -> str:
    res = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{res.stderr.strip()}")
    return res.stdout


def indexed_files() -> list[tuple[str, str]]:
    """返回 [(mode, path)]，来自 git 索引，自动遵循 .gitignore。"""
    out = git("ls-files", "-s")
    files: list[tuple[str, str]] = []
    for line in out.splitlines():
        if not line.strip():
            continue
        meta, path = line.split("\t", 1)
        mode = meta.split()[0]
        if mode == "160000":  # submodule
            continue
        files.append((mode, path))
    return files


def head_message() -> str:
    try:
        return git("log", "-1", "--format=%B").strip() or "chore: sync"
    except RuntimeError:
        return "chore: sync"


def identity() -> tuple[dict, dict]:
    try:
        name = git("config", "user.name").strip() or DEFAULT_OWNER
        email = git("config", "user.email").strip() or f"{DEFAULT_OWNER}@users.noreply.github.com"
    except RuntimeError:
        name, email = DEFAULT_OWNER, f"{DEFAULT_OWNER}@users.noreply.github.com"
    person = {"name": name, "email": email}
    return person, person


# ---------------------------------------------------------------- actions

def ensure_repo(owner: str, repo: str, token: str, description: str, private: bool) -> bool:
    info = get_optional(f"/repos/{owner}/{repo}", token)
    if info:
        print(f"  仓库已存在：{info.get('full_name')}（{info.get('default_branch')}）")
        return False

    print("  创建仓库…")
    payload = {
        "name": repo,
        "description": description,
        "private": private,
        "has_issues": True,
        "has_wiki": False,
        "auto_init": False,
    }
    _, created = request("POST", "/user/repos", token, payload)
    print(f"  已创建：{created.get('html_url')}")
    return True


def set_topics(owner: str, repo: str, token: str) -> None:
    try:
        request("PUT", f"/repos/{owner}/{repo}/topics", token, {"names": TOPICS})
        print(f"  topics：{', '.join(TOPICS)}")
    except RuntimeError as err:
        print(f"  [!] topics 设置失败（不影响代码）：{err}")


def upload(owner: str, repo: str, token: str, branch: str, dry_run: bool) -> int:
    files = indexed_files()
    print(f"  索引文件：{len(files)} 个，目标分支：{branch}")
    if dry_run:
        for mode, path in files[:8]:
            print(f"    {mode} {path}")
        if len(files) > 8:
            print(f"    … 其余 {len(files) - 8} 个")
        print("  [dry-run] 不实际写入")
        return 0

    print("  上传 blob…")
    entries = []
    for idx, (mode, path) in enumerate(files, 1):
        raw = (ROOT / path).read_bytes()
        _, blob = request("POST", f"/repos/{owner}/{repo}/git/blobs", token,
                          {"content": base64.b64encode(raw).decode("ascii"), "encoding": "base64"})
        entries.append({"path": path, "mode": mode, "type": "blob", "sha": blob["sha"]})
        if idx % 10 == 0 or idx == len(files):
            print(f"    {idx}/{len(files)}")

    ref = get_optional(f"/repos/{owner}/{repo}/git/ref/heads/{branch}", token)
    parent_sha = ref["object"]["sha"] if ref else None
    base_tree = None
    parents: list[str] = []
    if parent_sha:
        commit = request("GET", f"/repos/{owner}/{repo}/git/commits/{parent_sha}", token)[1]
        base_tree = commit["tree"]["sha"]
        parents = [parent_sha]
        print(f"  基于已有提交：{parent_sha[:8]}")

    tree_payload: dict = {"tree": entries}
    if base_tree:
        tree_payload["base_tree"] = base_tree
    _, tree = request("POST", f"/repos/{owner}/{repo}/git/trees", token, tree_payload)

    if base_tree and tree["sha"] == base_tree:
        print("  内容无变化，跳过提交")
        return 0

    author, committer = identity()
    _, commit = request("POST", f"/repos/{owner}/{repo}/git/commits", token, {
        "message": head_message(),
        "tree": tree["sha"],
        "parents": parents,
        "author": author,
        "committer": committer,
    })

    if parent_sha:
        request("PATCH", f"/repos/{owner}/{repo}/git/refs/heads/{branch}", token, {"sha": commit["sha"], "force": False})
    else:
        request("POST", f"/repos/{owner}/{repo}/git/refs", token, {"ref": f"refs/heads/{branch}", "sha": commit["sha"]})

    print(f"  已提交：{commit['sha'][:8]}")
    return 0


def delete_repo(full_name: str, token: str, confirmed: bool) -> int:
    if "/" not in full_name:
        print("[x] --delete 需要 owner/repo 形式", file=sys.stderr)
        return 2
    info = get_optional(f"/repos/{full_name}", token)
    if not info:
        print(f"[x] 仓库不存在或无权限：{full_name}", file=sys.stderr)
        return 1

    print("即将删除的仓库：")
    for key in ("full_name", "description", "private", "created_at", "pushed_at", "size", "forks_count", "stargazers_count", "open_issues_count"):
        print(f"  {key:18s}: {info.get(key)}")
    print(f"  url               : {info.get('html_url')}")
    print("\n[!] 删除不可恢复：代码、Issues、Releases、Star、Fork 关系都会消失。")

    if not confirmed:
        print("\n未加 --yes，已中止。确认要删就重跑：")
        print(f"  python tools/publish.py --delete {full_name} --yes")
        return 0

    request("DELETE", f"/repos/{full_name}", token)
    print(f"[ok] 已删除 {full_name}")
    return 0


# ---------------------------------------------------------------- CLI

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="通过 GitHub API 建仓库并上传 fn-netgui")
    ap.add_argument("--owner", default=DEFAULT_OWNER)
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--branch", default=DEFAULT_BRANCH)
    ap.add_argument("--description", default="飞牛 fnOS 网络配置管家：第二网口 NAT 共享 / OVS 桥接 / WiFi 热点 / MAC 与静态 IP，fpk 一键安装")
    ap.add_argument("--private", action="store_true", help="创建私有仓库")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不写入")
    ap.add_argument("--delete", metavar="OWNER/REPO", help="删除指定仓库（需 delete_repo 权限）")
    ap.add_argument("--yes", action="store_true", help="配合 --delete，跳过交互确认")
    args = ap.parse_args(argv[1:])

    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        print("[x] 未设置 GH_TOKEN。\n    Windows: $env:GH_TOKEN=\"<PAT>\"\n    Linux/macOS: export GH_TOKEN=<PAT>", file=sys.stderr)
        return 2

    try:
        user = request("GET", "/user", token)[1]
        print(f"身份：{user.get('login')}（token 可用）")
    except RuntimeError as err:
        print(f"[x] token 无效：{err}", file=sys.stderr)
        return 2

    if args.delete:
        return delete_repo(args.delete, token, args.yes)

    try:
        print(f"[1/3] 仓库 {args.owner}/{args.repo}")
        ensure_repo(args.owner, args.repo, token, args.description, args.private)
        print("[2/3] 上传代码")
        upload(args.owner, args.repo, token, args.branch, args.dry_run)
        if not args.dry_run:
            print("[3/3] 设置 topics")
            set_topics(args.owner, args.repo, token)
        print(f"\n[ok] https://github.com/{args.owner}/{args.repo}")
        return 0
    except RuntimeError as err:
        print(f"\n[x] {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
