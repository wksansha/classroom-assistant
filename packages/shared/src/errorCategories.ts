export type ErrorCategory =
  | "语法错误"
  | "名称错误"
  | "类型错误"
  | "运算错误"
  | "容器访问错误"
  | "属性导入错误"
  | "文件权限错误"
  | "其他";

const MAP: Record<string, ErrorCategory> = {
  SyntaxError: "语法错误",
  IndentationError: "语法错误",
  TabError: "语法错误",
  NameError: "名称错误",
  TypeError: "类型错误",
  ValueError: "类型错误",
  ZeroDivisionError: "运算错误",
  OverflowError: "运算错误",
  IndexError: "容器访问错误",
  KeyError: "容器访问错误",
  AttributeError: "属性导入错误",
  ImportError: "属性导入错误",
  ModuleNotFoundError: "属性导入错误",
  FileNotFoundError: "文件权限错误",
  PermissionError: "文件权限错误",
};

export function categoryFor(errorType?: string | null): ErrorCategory {
  return (errorType && MAP[errorType]) || "其他";
}
