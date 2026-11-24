#!/usr/bin/env python3
"""校验构建出的 .fpk 是否可安装：结构、权限位、换行、checksum、内层 app.tgz。

支持一次校验多个文件：
    python tools/verify_fpk.py dist/*.fpk

任一文件失败则退出码为 1。
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import struct
import sys
import tarfile
from pathlib import Path

REQUIRED_ENTRIES = [
    "manifest",
    "app.tgz",
    "cmd/main",
    "cmd/install_init",
    "config/privilege",
    "ICON.PNG",
    "ICON_256.PNG",
]
CMD_SCRIPTS = [
    "cmd/main",
    "cmd/install_init",
    "cmd/install_callback",
    "cmd/upgrade_init",
    "cmd/upgrade_callback",
    "cmd/config_init",
    "cmd/config_callback",
    "cmd/uninstall_init",
    "cmd/uninstall_callback",
]
PLATFORMS = ("x86", "arm", "loongarch", "risc-v")

errors: list[str] = []
checks: list[str] = []


def ok(msg: str) -> None:
    checks.append(msg)


def bad(msg: str) -> None:
    errors.append(msg)


def png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])


def parse_manifest(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip()
    return out


def verify_file(path: Path) -> bool:
    """校验单个 fpk，返回是否全部通过。"""
    global errors, checks
    errors, checks = [], []

    with tarfile.open(path, "r:gz") as fpk:
        names = set(fpk.getnames())
        members = {m.name: m for m in fpk.getmembers()}

        for entry in REQUIRED_ENTRIES:
            if entry not in names:
                bad(f"缺少条目：{entry}")
        if not errors:
            ok(f"必需条目齐全（{len(REQUIRED_ENTRIES)} 项）")

        manifest_text = fpk.extractfile("manifest").read().decode("utf-8")
        manifest = parse_manifest(manifest_text)
        appname = manifest.get("appname", "")
        checksum = manifest.get("checksum", "")
        if not appname:
            bad("manifest 缺少 appname")
        if not re.fullmatch(r"[0-9a-f]{32}", checksum or ""):
            bad(f"manifest checksum 不是 32 位 md5：{checksum!r}")
        if not manifest.get("service_port", "").isdigit():
            bad("manifest service_port 不合法")
        if manifest.get("source") != "thirdparty":
            bad("manifest source 必须是 thirdparty")
        platform = manifest.get("platform", "x86")
        if platform not in PLATFORMS:
            bad(f"platform 非法：{platform!r}（appcenter 只接受 x86/arm/loongarch/risc-v，all 会被判约束检查失败）")
        if not errors:
            ok(
                f"manifest 合法（{appname} {manifest.get('version')} / {platform} / port {manifest.get('service_port')}）"
            )

        for script in CMD_SCRIPTS:
            member = members.get(script)
            if member is None:
                bad(f"缺少脚本：{script}")
                continue
            if not member.mode & 0o111:
                bad(f"{script} 不可执行（mode {oct(member.mode)}）")
            body = fpk.extractfile(script).read()
            if b"\r\n" in body:
                bad(f"{script} 使用了 CRLF 换行")
            if not body.startswith(b"#!"):
                bad(f"{script} 缺少 shebang")
        if not errors:
            ok(f"cmd/ 脚本可执行且为 LF 换行（{len(CMD_SCRIPTS)} 个）")

        for icon, size in (("ICON.PNG", 64), ("ICON_256.PNG", 256)):
            data = fpk.extractfile(icon).read() if icon in names else b""
            got = png_size(data) if data else None
            if got != (size, size):
                bad(f"{icon} 尺寸应为 {size}x{size}，实际 {got}")
        if not errors:
            ok("图标尺寸正确（64 / 256）")

        app_tgz = fpk.extractfile("app.tgz").read()
        actual = hashlib.md5(app_tgz).hexdigest()
        if actual != checksum:
            bad(f"checksum 不匹配：manifest={checksum} 实际={actual}")
        else:
            ok(f"app.tgz checksum 匹配（{actual}）")

        with tarfile.open(fileobj=io.BytesIO(app_tgz), mode="r:gz") as app:
            app_names = set(app.getnames())
            for need in ("server/server.js", "ui/index.html", "ui/app.js", "ui/style.css", "ui/config"):
                if need not in app_names:
                    bad(f"app.tgz 缺少：{need}")
            if "ui/config" in app_names:
                try:
                    cfg = json.loads(app.extractfile("ui/config").read().decode("utf-8"))
                    entries = cfg.get(".url", {})
                    if not entries:
                        bad("ui/config 没有定义入口")
                    for entry_id, entry in entries.items():
                        if not entry_id.startswith(f"{appname}."):
                            bad(f"入口 ID 未以 appname 为前缀：{entry_id}")
                        if entry.get("type") not in ("url", "iframe"):
                            bad(f"入口 {entry_id} 的 type 非法：{entry.get('type')}")
                        if str(entry.get("port")) != manifest.get("service_port"):
                            bad(f"入口 {entry_id} 端口与 manifest service_port 不一致")
                except Exception as exc:  # noqa: BLE001
                    bad(f"ui/config 不是合法 JSON：{exc}")
        if not errors:
            ok("app.tgz 内容完整（server + ui）")

    print(f"校验：{path.name}（{path.stat().st_size / 1024:.1f} KiB）")
    for line in checks:
        print(f"  [OK] {line}")
    for line in errors:
        print(f"  [FAIL] {line}")
    return not errors


def main(argv: list[str]) -> int:
    targets = argv[1:]
    if not targets:
        print("用法：python tools/verify_fpk.py <file.fpk> [more.fpk ...]", file=sys.stderr)
        return 2

    failed: list[str] = []
    for target in targets:
        path = Path(target)
        if not path.is_file():
            print(f"[FAIL] 找不到文件：{path}", file=sys.stderr)
            failed.append(str(path))
            continue
        if not verify_file(path):
            failed.append(path.name)
        print()

    if len(targets) > 1:
        if failed:
            print(f"共 {len(targets)} 个包，失败 {len(failed)} 个：{', '.join(failed)}")
        else:
            print(f"共 {len(targets)} 个包，全部通过")
    if failed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
