import { describe, it, expect } from "vitest";
import { categoryFor } from "../errorCategories";

describe("categoryFor：error_type → 8 分类静态映射", () => {
  it("语法错误", () => {
    expect(categoryFor("SyntaxError")).toBe("语法错误");
    expect(categoryFor("IndentationError")).toBe("语法错误");
    expect(categoryFor("TabError")).toBe("语法错误");
  });
  it("名称错误", () => {
    expect(categoryFor("NameError")).toBe("名称错误");
  });
  it("类型错误", () => {
    expect(categoryFor("TypeError")).toBe("类型错误");
    expect(categoryFor("ValueError")).toBe("类型错误");
  });
  it("运算错误", () => {
    expect(categoryFor("ZeroDivisionError")).toBe("运算错误");
    expect(categoryFor("OverflowError")).toBe("运算错误");
  });
  it("容器访问错误", () => {
    expect(categoryFor("IndexError")).toBe("容器访问错误");
    expect(categoryFor("KeyError")).toBe("容器访问错误");
  });
  it("属性导入错误", () => {
    expect(categoryFor("AttributeError")).toBe("属性导入错误");
    expect(categoryFor("ImportError")).toBe("属性导入错误");
    expect(categoryFor("ModuleNotFoundError")).toBe("属性导入错误");
  });
  it("文件权限错误", () => {
    expect(categoryFor("FileNotFoundError")).toBe("文件权限错误");
    expect(categoryFor("PermissionError")).toBe("文件权限错误");
  });
  it("未知或缺失 → 其他", () => {
    expect(categoryFor("WhateverError")).toBe("其他");
    expect(categoryFor(undefined)).toBe("其他");
    expect(categoryFor("")).toBe("其他");
  });
});
