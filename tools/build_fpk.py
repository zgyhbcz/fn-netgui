#!/usr/bin/env python3
"""把 fn-netgui 打包成可安装的 .fpk（无需 fnpack，纯标准库）。

fpk 结构（与官方 fnpack 产物一致）：

    fn-netgui_<version>_<platform>.fpk   (tar.gz)
    ├── manifest          # 含 checksum = md5(app.tgz)
    ├── app.tgz           # 应用负载（安装后解到 APP_DIR）
    │   ├── server/…      # node 后端
    │   └── ui/…          # GUI（desktop_uidir=ui）
    ├── cmd/              # 生命周期脚本（0755）
    ├── config/           # privilege / resource
    ├── wizard/           # 卸载向导
    ├── ICON.PNG          # 64x64
    └── ICON_256.PNG      # 256x256

用法：
    python tools/build_fpk.py                # 输出到 ./dist
    python tools/build_fpk.py --out dist --version 1.0.1

官方工具（等价）：在项目根目录执行 `fnpack build`。
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import re
import struct
import sys
import tarfile
import time
from pathlib import Path

ROOT_DEFAULT = Path(__file__).resolve().parent.parent

REQUIRED_MANIFEST_KEYS = ["appname", "version", "display_name", "desc", "source", "service_port"]
CMD_SCRIPTS = [
    "main",
    "install_init",
    "install_callback",
    "upgrade_init",
    "upgrade_callback",
    "config_init",
    "config_callback",
    "uninstall_init",
    "uninstall_callback",
]
PINNED_MTIME = 1700000000  # 固定时间戳，保证可重复构建

errors: list[str] = []
warnings: list[str] = []


def fail(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def parse_manifest(text: str) -> dict[str, str]:
    data: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key.strip()] = value.strip()
    return data


def png_size(path: Path) -> tuple[int, int] | None:
    try:
        with path.open("rb") as fh:
            head = fh.read(33)
    except OSError:
        return None
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", head[16:24])
    return width, height


def check_project(root: Path) -> dict[str, str]:
    manifest_path = root / "manifest"
    if not manifest_path.is_file():
        fail("缺少 manifest")
        return {}
    manifest = parse_manifest(manifest_path.read_text(encoding="utf-8"))

    for key in REQUIRED_MANIFEST_KEYS:
        if not manifest.get(key):
            fail(f"manifest 缺少必填字段：{key}")

    if manifest.get("source") != "thirdparty":
        fail("manifest source 必须是 thirdparty")

    if not re.fullmatch(r"\d+(\.\d+){0,2}(-[0-9A-Za-z.]+)?", manifest.get("version", "")):
        fail(f"版本号格式不合法：{manifest.get('version')}")

    port = manifest.get("service_port", "")
    if not port.isdigit() or not (1024 <= int(port) <= 65535):
        fail(f"service_port 不合法：{port}")

    ui_dir = manifest.get("desktop_uidir", "ui")
    if not (root / "app" / ui_dir).is_dir():
        fail(f"desktop_uidir 指向的目录不存在：app/{ui_dir}")

    for name in ("ICON.PNG", "ICON_256.PNG"):
        path = root / name
        if not path.is_file():
            fail(f"缺少图标 {name}")
            continue
        size = png_size(path)
        expected = 64 if name == "ICON.PNG" else 256
        if size is None:
            fail(f"{name} 不是合法 PNG")
        elif size != (expected, expected):
            fail(f"{name} 尺寸应为 {expected}x{expected}，实际 {size[0]}x{size[1]}")

    for name in ("privilege", "resource"):
        path = root / "config" / name
        if not path.is_file():
            fail(f"缺少 config/{name}")
            continue
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            fail(f"config/{name} 不是合法 JSON：{exc}")

    ui_config = root / "app" / ui_dir / "config"
    if not ui_config.is_file():
        fail(f"缺少桌面入口配置 app/{ui_dir}/config")
    else:
        try:
            entries = json.loads(ui_config.read_text(encoding="utf-8")).get(".url", {})
            appname = manifest.get("appname", "")
            for entry_id in entries:
                if not entry_id.startswith(f"{appname}."):
                    fail(f"入口 ID 必须以 appname 为前缀：{entry_id}")
            launch = manifest.get("desktop_applaunchname", "")
            if launch and launch not in entries:
                fail(f"desktop_applaunchname={launch} 未在 {ui_dir}/config 中定义")
            for entry_id, entry in entries.items():
                if not entry.get("icon"):
                    fail(f"入口 {entry_id} 缺少 icon")
        except Exception as exc:  # noqa: BLE001
            fail(f"app/{ui_dir}/config 不是合法 JSON：{exc}")

    for name in CMD_SCRIPTS:
        path = root / "cmd" / name
        if not path.is_file():
            fail(f"缺少 cmd/{name}")
            continue
        first = path.read_text(encoding="utf-8", errors="replace").splitlines()[:1]
        if not first or not first[0].startswith("#!"):
            fail(f"cmd/{name} 缺少 shebang")
        if b"\r\n" in path.read_bytes():
            fail(f"cmd/{name} 使用了 CRLF 换行，Linux 上会执行失败")

    if not (root / "app" / "server" / "server.js").is_file():
        fail("缺少 app/server/server.js")

    if not (root / "app" / ui_dir / "index.html").is_file():
        warn(f"app/{ui_dir}/index.html 不存在，GUI 可能无法打开")

    if manifest.get("platform") == "all" and any((root / "app").rglob("*.node")):
        fail("platform=all 但包含原生模块 (.node)")

    return manifest


def add_path(tar: tarfile.TarFile, src: Path, arc: str) -> None:
    """递归写入一条路径；cmd/ 下可执行文件给 0755，其余 0644。"""
    info = tar.gettarinfo(str(src), arcname=arc)
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    info.mtime = PINNED_MTIME

    if src.is_dir():
        info.mode = 0o755
        info.type = tarfile.DIRTYPE
        tar.addfile(info)
        for child in sorted(src.iterdir(), key=lambda p: p.name):
            add_path(tar, child, f"{arc.rstrip('/')}/{child.name}")
        return

    info.mode = 0o755 if arc.startswith("cmd/") else 0o644
    with src.open("rb") as fh:
        tar.addfile(info, fh)


def make_targz(items: list[tuple[Path, str]]) -> bytes:
    """items: [(source_path, arcname)]。"""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as tar:
        for src, arc in items:
            add_path(tar, src, arc)
    return raw.getvalue()


def build(root: Path, out_dir: Path, version_override: str | None) -> Path:
    manifest = check_project(root)
    if errors:
        print("项目校验失败：", file=sys.stderr)
        for err in errors:
            print(f"  [x] {err}", file=sys.stderr)
        sys.exit(1)

    appname = manifest["appname"]
    version = version_override or manifest["version"]
    platform = manifest.get("platform", "x86")

    # 1. app.tgz —— 内容为 app/ 目录下的相对路径（server/…, ui/…）
    app_root = root / "app"
    app_items = [(child, child.name) for child in sorted(app_root.iterdir(), key=lambda p: p.name)]
    app_payload = make_targz(app_items)
    app_tgz = gzip.compress(app_payload, compresslevel=9, mtime=PINNED_MTIME)
    checksum = hashlib.md5(app_tgz).hexdigest()

    # 2. manifest 写入 checksum
    manifest_text = (root / "manifest").read_text(encoding="utf-8")
    if re.search(r"^checksum\s*=", manifest_text, flags=re.MULTILINE):
        manifest_text = re.sub(r"^checksum\s*=.*$", f"checksum              = {checksum}", manifest_text, flags=re.MULTILINE)
    else:
        manifest_text = manifest_text.rstrip("\n") + f"\nchecksum              = {checksum}\n"
    if version_override:
        manifest_text = re.sub(r"^version\s*=.*$", f"version               = {version}", manifest_text, flags=re.MULTILINE)

    # 3. 组装 fpk
    staged: list[tuple[Path, str]] = []
    tmp = out_dir / ".staging"
    if tmp.exists():
        import shutil

        shutil.rmtree(tmp)
    tmp.mkdir(parents=True, exist_ok=True)

    (tmp / "manifest").write_text(manifest_text, encoding="utf-8")
    (tmp / "app.tgz").write_bytes(app_tgz)
    for name in ("ICON.PNG", "ICON_256.PNG"):
        (tmp / name).write_bytes((root / name).read_bytes())

    for arc in ("cmd", "config", "wizard"):
        src = root / arc
        if src.is_dir():
            staged.append((src, arc))
    staged.append((tmp / "manifest", "manifest"))
    staged.append((tmp / "app.tgz", "app.tgz"))
    staged.append((tmp / "ICON.PNG", "ICON.PNG"))
    staged.append((tmp / "ICON_256.PNG", "ICON_256.PNG"))

    fpk_bytes = gzip.compress(make_targz(staged), compresslevel=9, mtime=PINNED_MTIME)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{appname}_{version}_{platform}.fpk"
    out_path.write_bytes(fpk_bytes)

    import shutil

    shutil.rmtree(tmp)

    print(f"[OK] 打包完成：{out_path}")
    print(f"  appname   : {appname}")
    print(f"  version   : {version}")
    print(f"  platform  : {platform}")
    print(f"  app.tgz   : {len(app_tgz) / 1024:.1f} KiB  md5={checksum}")
    print(f"  fpk       : {len(fpk_bytes) / 1024:.1f} KiB")
    for item in warnings:
        print(f"  ! {item}")
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser(description="Build fn-netgui .fpk package")
    ap.add_argument("--root", default=str(ROOT_DEFAULT), help="项目根目录（含 manifest）")
    ap.add_argument("--out", default=str(ROOT_DEFAULT / "dist"), help="输出目录")
    ap.add_argument("--version", default=None, help="覆盖 manifest 中的版本号")
    args = ap.parse_args()
    build(Path(args.root).resolve(), Path(args.out).resolve(), args.version)


if __name__ == "__main__":
    main()
