import type { Persistence } from "../persistence";

/** 文件路径 → 命中的练习：第一段=作业目录名；单文件题=<dir>/<filename>；项目题=<dir>/<projectDir>/... */
export function resolveExercisesByFiles(persistence: Persistence, files: string[]): { exerciseId: string }[] {
  const hit = new Set<string>();
  for (const f of files) {
    const segs = f.split("/");
    if (segs.length < 2) continue;                       // 仓库根散文件不对应练习
    const [dir, ...rest] = segs;
    for (const ex of persistence.getExercisesByDir(dir)) {
      if (ex.kind === "project") {
        if (rest[0] === ex.filename) hit.add(ex.id);     // 项目：lesson5/weather-app/** → exercise.filename=weather-app
      } else if (rest.join("/") === ex.filename) {
        hit.add(ex.id);                                   // 单文件：lesson5/a.py → exercise.filename=a.py
      }
    }
  }
  return [...hit].map((exerciseId) => ({ exerciseId }));
}
