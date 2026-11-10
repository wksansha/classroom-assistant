/**
 * 题面头解析（spec 2026-11-09 §3）：从学生提交代码中提取题面名与任务清单。
 *
 * 任务声明双格式等价（≥2 个声明才算多任务题）：
 *   - `# [任务X] 描述`        → 任务名 = 方括号内短名
 *   - `# ---- 第X部分：名称 ----` → 任务名 = 冒号后的名称（L15/L21 存量分节格式）
 *
 * 扫描范围：有「代码区」分隔线 → 仅分隔线前（题面区）；无分隔线 → 全文件注释行
 * （无分隔线时整个文件就是代码，教师提示注释天然散布文件内，见 L15 实测样本）。
 *
 * 题名优先级：注释中「练习N：标题」> docstring 中「练习N：标题」
 *           > 首条非空注释（跳过编码声明/解释器行）> docstring 首个非空行。
 */

export interface ExerciseHeader {
  /** 题面名；完全提取不到时 undefined（调用方回退文件名） */
  title?: string;
  /** 任务名清单（声明 ≥2 才非空；[] = 单任务题，整文件一桶走现状） */
  tasks: string[];
}

const SEP_RE = /={3,}\s*代码区\s*={3,}/;
/** `# [短名] 描述`：短名不含方括号 */
const BRACKET_TASK_RE = /^\s*#\s*\[([^\[\]]+)\]\s*(.*)$/;
/** `# --- 第X部分：名称 ---`：横线可有可无，冒号中英文均可，名称可空 */
const SECTION_TASK_RE = /^\s*#\s*-*\s*(第[一二三四五六七八九十百\d]+部分)\s*[：:]?\s*(.*?)\s*-*\s*$/;
/** 编码声明 / 解释器行：题名兜底时跳过 */
const META_LINE_RE = /^\s*#\s*(-\*-|!|coding\s*[:=])/;
const PRACTICE_RE = /练习\s*([^\s：:]{1,6})\s*[：:]\s*(.+)/;

/** 题名清洗（与既有 extractExerciseTitle 同语义）：练习N：标题，去尾部（备注） */
function cleanTitle(line: string): string | null {
  const m = line.match(PRACTICE_RE);
  if (m) return `练习${m[1]}：${m[2].replace(/\s*[（(][^）)]*[）)]\s*$/, "").trim()}`;
  return null;
}

/** 从注释行提取题名候选：练习N 匹配 → 强候选；普通注释 → 弱候选（去 # 前缀） */
function titleCandidateFromComment(line: string): { strong: string | null; weak: string | null } {
  const strong = cleanTitle(line);
  if (strong) return { strong, weak: null };
  if (META_LINE_RE.test(line)) return { strong: null, weak: null };
  const text = line.trim().replace(/^#+\s*/, "").trim();
  return { strong: null, weak: text || null };
}

/** 提取首个模块 docstring 的首个非空行（无 docstring 返回 null） */
function firstDocstringLine(code: string): string | null {
  const opener = code.search(/("""|''')/);
  if (opener < 0) return null;
  const quote = code[opener] === '"' ? '"""' : "'''";
  const rest = code.slice(opener + 3);
  const closeIdx = rest.indexOf(quote);
  const body = rest.slice(0, closeIdx >= 0 ? closeIdx : undefined);
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim().replace(/^#+\s*/, "").trim();
    if (t) return t;
  }
  return null;
}

export function parseExerciseHeader(code: string): ExerciseHeader {
  const sepIdx = code.search(SEP_RE);
  const hasSep = sepIdx >= 0;
  const head = hasSep ? code.slice(0, sepIdx) : code;
  const scanScope = hasSep ? head : code;   // 任务声明扫描范围（spec §3）

  // ── 任务清单：按行匹配双格式，重名去重（首现生效）──
  const tasks: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of scanScope.split(/\r?\n/)) {
    if (!/^\s*#/.test(rawLine)) continue;   // 只认注释行
    let name: string | null = null;
    const bracket = rawLine.match(BRACKET_TASK_RE);
    if (bracket) {
      name = bracket[1].trim();
    } else {
      const section = rawLine.match(SECTION_TASK_RE);
      if (section) name = (section[2] || section[1]).trim();   // 优先冒号后名称，空则用「第X部分」
    }
    if (name && !seen.has(name)) {
      seen.add(name);
      tasks.push(name);
    }
  }

  // ── 题名：四级优先 ──
  let strongFromComment: string | null = null;
  let weakFromComment: string | null = null;
  for (const rawLine of head.split(/\r?\n/)) {
    if (!/^\s*#/.test(rawLine)) continue;
    const { strong, weak } = titleCandidateFromComment(rawLine);
    if (strong) { strongFromComment = strong; break; }
    if (!weakFromComment && weak) weakFromComment = weak;
  }
  const docLine = firstDocstringLine(code);
  let strongFromDoc: string | null = null;
  if (docLine) {
    const m = docLine.match(PRACTICE_RE);
    if (m) strongFromDoc = `练习${m[1]}：${m[2].replace(/\s*[（(][^）)]*[）)]\s*$/, "").trim()}`;
  }

  const title =
    strongFromComment ?? strongFromDoc ?? weakFromComment
    ?? (docLine && !/-\*-|coding\s*[:=]/.test(docLine) ? docLine : undefined) ?? undefined;

  return { title, tasks: tasks.length >= 2 ? tasks : [] };
}
