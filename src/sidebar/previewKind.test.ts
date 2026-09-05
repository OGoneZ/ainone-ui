// preview 纯逻辑：previewKind 映射 + 文件行预览联动。

import { describe, it, expect } from "vitest";
import { resolvePreviewKind, shikiLangFor, extname, PREVIEW_TEXT_LIMIT } from "./previewKind";

describe("extname", () => {
  it("取小写扩展名", () => {
    expect(extname("/a/b/Cd.TS")).toBe("ts");
  });
  it("无扩展名与点开头文件返回空串", () => {
    expect(extname("/a/Makefile")).toBe("");
    expect(extname("/a/.gitignore")).toBe("");
    expect(extname("/a/.env.local")).toBe("local"); // 点分隔取最后段，属预期
  });
});

describe("resolvePreviewKind（DEC-48 渲染器映射）", () => {
  it("markdown 扩展名 → markdown", () => {
    expect(resolvePreviewKind("/w/README.md")).toBe("markdown");
    expect(resolvePreviewKind("/w/notes.markdown")).toBe("markdown");
  });

  it("图片扩展名 → image", () => {
    expect(resolvePreviewKind("/w/logo.png")).toBe("image");
    expect(resolvePreviewKind("/w/photo.JPG")).toBe("image"); // 大小写不敏感
    expect(resolvePreviewKind("/w/icon.svg")).toBe("image");
  });

  it("代码扩展名 → code", () => {
    expect(resolvePreviewKind("/w/main.rs")).toBe("code");
    expect(resolvePreviewKind("/w/app.tsx")).toBe("code");
    expect(resolvePreviewKind("/w/data.json")).toBe("code");
    expect(resolvePreviewKind("/w/run.sh")).toBe("code");
  });

  it("特殊文件名（无扩展名）→ code", () => {
    expect(resolvePreviewKind("/w/Makefile")).toBe("code");
    expect(resolvePreviewKind("/w/Dockerfile")).toBe("code");
  });

  it("未知扩展名/无扩展名 → text 兜底", () => {
    expect(resolvePreviewKind("/w/data.xyz123")).toBe("text");
    expect(resolvePreviewKind("/w/LICENSE")).toBe("text");
    expect(resolvePreviewKind("/w/.gitignore")).toBe("code"); // 点开头白名单
  });

  it("二进制格式 → binary（不读内容）", () => {
    expect(resolvePreviewKind("/w/report.pdf")).toBe("binary");
    expect(resolvePreviewKind("/w/archive.zip")).toBe("binary");
    expect(resolvePreviewKind("/w/vid.mp4")).toBe("binary");
    expect(resolvePreviewKind("/w/font.woff2")).toBe("binary");
  });
});

describe("shikiLangFor", () => {
  it("代码文件返回 shiki 语言 id", () => {
    expect(shikiLangFor("/w/main.rs")).toBe("rust");
    expect(shikiLangFor("/w/app.tsx")).toBe("tsx");
    expect(shikiLangFor("/w/compose.yaml")).toBe("yaml");
  });
  it("特殊文件名映射", () => {
    expect(shikiLangFor("/w/Makefile")).toBe("makefile");
    expect(shikiLangFor("/w/Dockerfile")).toBe("dockerfile");
  });
  it("非 code 类型返回 undefined", () => {
    expect(shikiLangFor("/w/README.md")).toBeUndefined();
    expect(shikiLangFor("/w/logo.png")).toBeUndefined();
    expect(shikiLangFor("/w/data.xyz")).toBeUndefined();
  });
});

describe("PREVIEW_TEXT_LIMIT（DEC-48：1MB 上限）", () => {
  it("为 1_000_000 字符", () => {
    expect(PREVIEW_TEXT_LIMIT).toBe(1_000_000);
  });
});
