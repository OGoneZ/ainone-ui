#!/usr/bin/env python3
# F-7-0 WebKitGTK 冒烟探针：起 WebKitWebDriver + MiniBrowser，读四个 data-smoke
# 元素的 computed backgroundColor，判定 Tailwind v4 基线特性是否被 WebKitGTK
# 正确解析（@property / oklch / color-mix / Tailwind 工具类）。
#
# 用标准库避 bash 引号地狱；需先起 dev server（serve smoke.html）。
# 用法（在外层用 xvfb-run 包，无显示时）：
#   xvfb-run -a python3 tools/smoke-webkit.py [dev_url]
# 或直接 python3 tools/smoke-webkit.py http://localhost:1420/smoke.html
import base64
import json
import subprocess
import sys
import time
import urllib.request

DEV_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:1420/smoke.html"
WD_PORT = 9515
BASE = f"http://localhost:{WD_PORT}"


def req(method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.urlopen(
        urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json"}),
        timeout=30,
    )
    return json.loads(r.read().decode())


def main() -> int:
    print("▶ 启动 WebKitWebDriver")
    driver = subprocess.Popen(["WebKitWebDriver", f"--port={WD_PORT}"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                req("GET", "/status")
                break
            except Exception:
                time.sleep(0.5)

        print("▶ 创建会话（MiniBrowser）")
        sess = req("POST", "/session",
                   {"capabilities": {"alwaysMatch": {"browserName": "MiniBrowser",
                                                      "acceptInsecureCerts": True}}})
        sid = sess["value"]["sessionId"]
        print(f"   session={sid}")

        print(f"▶ 导航到 {DEV_URL}")
        req("POST", f"/session/{sid}/url", {"url": DEV_URL})
        time.sleep(4)  # 等 React 渲染 + @property 动画首帧

        print("▶ 读取四个色块 computed backgroundColor")
        script = """const read=(sel)=>{const el=document.querySelector(sel);
        if(!el) return null;
        return getComputedStyle(el).backgroundColor;};
        return {oklch:read('[data-smoke=oklch]'),
                colorMix:read('[data-smoke=color-mix]'),
                property:read('[data-smoke=property]'),
                tailwind:read('[data-smoke=tailwind]')};"""
        try:
            res = req("POST", f"/session/{sid}/execute/sync",
                      {"script": script, "args": []})
            colors = res["value"]
        except Exception as e:
            # 旧版 WebKitWebDriver execute 别名 fallback
            res = req("POST", f"/session/{sid}/execute",
                      {"script": script, "args": []})
            colors = res["value"]
        print("   " + json.dumps(colors, ensure_ascii=False))

        # 截图留档（路径可用 SMOKE_SHOT 覆盖，便于容器挂载回传）
        import os
        shot_path = os.environ.get("SMOKE_SHOT", "/tmp/p7-f7-0-webkit.png")
        try:
            shot = req("GET", f"/session/{sid}/screenshot")["value"]
            with open(shot_path, "wb") as f:
                f.write(base64.b64decode(shot))
            print(f"   截图: {shot_path}")
        except Exception as e:
            print(f"   截图失败（不影响判定）: {e}")

        def nonempty(c):
            return bool(c) and not c.startswith("rgba(0, 0, 0, 0)") and not c.startswith("rgb(0, 0, 0)")

        fail = 0
        print("\n== 判定（transparent/空 = 特性未被解析）==")
        for label, key in [("oklch", "oklch"), ("color-mix", "colorMix"),
                           ("@property", "property"), ("tailwind", "tailwind")]:
            c = colors.get(key) if isinstance(colors, dict) else None
            print(f"  {label:12s} = {c}")
            if nonempty(c):
                print(f"  ✔ {label} 解析生效")
            else:
                print(f"  ✘ {label} 未生效"); fail = 1

        print()
        if fail == 0:
            print("✅ F-7-0 WebKitGTK 冒烟通过：@property/oklch/color-mix/Tailwind 全部生效")
            return 0
        print("❌ F-7-0 冒烟失败：存在未生效特性，需降级 Tailwind v3")
        return 1
    finally:
        driver.terminate()


if __name__ == "__main__":
    sys.exit(main())