import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "../index";

// 插件云分发（spec 2026-11-02-plugin-auto-update）：
// manifest 存在 → /api/pylearner/latest 原样返回 + /downloads/pylearner 托管 vsix；
// manifest 缺失 → 404（插件端静默忽略，与"未放包"现状一致）。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pylearner-dl-"));
const manifest = { version: "1.0.9", file: "vscode-pylearner-1.0.9.vsix", notes: "修复若干问题" };
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
fs.writeFileSync(path.join(dir, "vscode-pylearner-1.0.9.vsix"), Buffer.from("fake-vsix-bytes"));

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function app(withDir = true) {
  return createApp({ dbPath: ":memory:", staticDir: null, downloadsDir: withDir ? dir : null }).app;
}

describe("GET /api/pylearner/latest", () => {
  it("manifest 存在 → 200 原样返回清单", async () => {
    const res = await request(app()).get("/api/pylearner/latest").expect(200);
    expect(res.body).toEqual(manifest);
  });

  it("manifest 缺失 → 404（插件端静默）", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pylearner-dl-empty-"));
    try {
      await request(createApp({ dbPath: ":memory:", staticDir: null, downloadsDir: empty }).app)
        .get("/api/pylearner/latest")
        .expect(404);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("manifest 内容非法 JSON → 404", async () => {
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), "pylearner-dl-bad-"));
    fs.writeFileSync(path.join(bad, "manifest.json"), "{ not json");
    try {
      await request(createApp({ dbPath: ":memory:", staticDir: null, downloadsDir: bad }).app)
        .get("/api/pylearner/latest")
        .expect(404);
    } finally {
      fs.rmSync(bad, { recursive: true, force: true });
    }
  });
});

describe("GET /downloads/pylearner/:file", () => {
  it("托管 vsix 安装包", async () => {
    const res = await request(app())
      .get("/downloads/pylearner/vscode-pylearner-1.0.9.vsix")
      .expect(200);
    expect(res.body.toString()).toBe("fake-vsix-bytes");
  });

  it("downloadsDir=null 禁用 → 404", async () => {
    await request(app(false))
      .get("/downloads/pylearner/vscode-pylearner-1.0.9.vsix")
      .expect(404);
  });
});
