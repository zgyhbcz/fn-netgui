#!/usr/bin/env python3
"""GUI 静态一致性检查：HTML 里的 id / data-panel 与 app.js 引用的元素是否对得上。

在没有浏览器的环境下，这是发现「选择器写错导致白屏」最便宜的一道检查。

用法：python tools/check_ui.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from lxml import html

ROOT = Path(__file__).resolve().parent.parent
HTML_PATH = ROOT / "app" / "ui" / "index.html"
JS_PATH = ROOT / "app" / "ui" / "app.js"

DOC_ID_RE = re.compile(r"""getElementById\(\s*['"]([^'"]+)['"]""")
DOLLAR_RE = re.compile(r"""\$\('#([A-Za-z0-9_-]+)'\)""")
DOLLAR_ALL_RE = re.compile(r"""\$\$\('#([A-Za-z0-9_-]+)""")

data_id_re = re.compile(r'data-(?:tab|panel)="([^"]+)"')

errors: list[str] = []
notes: list[str] = []


def main() -> int:
    if not HTML_PATH.is_file() or not JS_PATH.is_file():
        print("找不到 index.html 或 app.js", file=sys.stderr)
        return 1

    doc = html.fromstring(HTML_PATH.read_text(encoding="utf-8"))
    html_text = HTML_PATH.read_text(encoding="utf-8")
    js = JS_PATH.read_text(encoding="utf-8")

    ids = set(doc.xpath("//@id"))
    js_ids = set(DOC_ID_RE.findall(js)) | set(DOLLAR_RE.findall(js))
    js_ids |= set(re.findall(r"val\('([A-Za-z0-9_-]+)'\)", js))
    js_ids |= set(re.findall(r"checked\('([A-Za-z0-9_-]+)'\)", js))
    js_ids |= set(re.findall(r"getElementById\('([A-Za-z0-9_-]+)'\)", js))
    missing = sorted(js_ids - ids)
    for item in missing:
        errors.append(f"app.js 引用了不存在的 id：#{item}")

    unused = sorted(ids - js_ids)
    for item in unused:
        notes.append(f"HTML 中存在未被脚本引用的 id：#{item}")

    # tab / panel 一一对应
    tabs = set(re.findall(r'data-tab="([^"]+)"', html_text))
    panels = set(re.findall(r'data-panel="([^"]+)"', html_text))
    for tab in sorted(tabs - panels):
        errors.append(f"tab「{tab}」没有对应的 panel")
    for panel in sorted(panels - tabs):
        errors.append(f"panel「{panel}」没有对应的 tab 按钮")

    # app.js 里 state.tab 的取值必须与 tab 对齐
    js_tabs = set(re.findall(r"state\.tab === '([a-z]+)'", js)) | set(
        re.findall(r"if \(state\.tab === '([a-z]+)'\)", js)
    )
    for tab in sorted(js_tabs - tabs):
        errors.append(f"app.js 判断了不存在的 tab：{tab}")
    for tab in sorted(tabs - js_tabs):
        notes.append(f"tab「{tab}」在 app.js 中没有分支（可能不需要）")

    # 表单输入 id 必须被 collectPayload / 事件绑定覆盖
    payload_ids = set(re.findall(r"val\('([A-Za-z0-9_-]+)'\)", js))
    for item in sorted(payload_ids - ids):
        errors.append(f"collectPayload 读取了不存在的 id：{item}")

    # data-format 取值必须被 installFormatters 处理
    formats = set(re.findall(r'data-format="([a-z0-9]+)"', html_text))
    handled = {"mac", "ip", "ip4", "dns"}
    for fmt in sorted(formats - handled):
        errors.append(f"data-format=\"{fmt}\" 没有对应的格式化函数")

    print(f"HTML id 数：{len(ids)}，脚本引用：{len(js_ids)}，tab：{len(tabs)}，panel：{len(panels)}")
    for note in notes:
        print(f"  note  {note}")
    if errors:
        print()
        for err in errors:
            print(f"  FAIL  {err}")
        return 1
    print("GUI 静态检查通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
