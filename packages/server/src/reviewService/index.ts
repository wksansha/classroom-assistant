import crypto from "node:crypto";
import pLimit from "p-limit";
import type { Exercise, ReviewResult } from "@classroom/shared";
import type { Persistence } from "../persistence";
import { createReviewCache } from "./cache";
import { callReviewLLM, type ReviewLlmOptions } from "./llm";
import { logEvent } from "../logger";

export type { ReviewLlmOptions };

export type ReviewableExercise = Pick<Exercise, "id" | "versionHash" | "problemStatement" | "testCases"> & { filePath: string };

export interface ReviewService {
  review(exercise: ReviewableExercise, code: string): Promise<ReviewResult>;
}

/** 学生分支直连模型（spec §6.3）：key = sha256(路径 + versionHash + code)，路径不可变 → 稳定映射 */
export function computeReviewCacheKey(filePath: string, versionHash: string, code: string): string {
  return crypto.createHash("sha256").update(filePath + versionHash + code).digest("hex").slice(0, 32);
}

export function createReviewService(p: Persistence, opts: ReviewLlmOptions = {}): ReviewService {
  const cache = createReviewCache(p);
  const limit = pLimit(5);   // A11：真正的并发限制（pending Map 只去重同 key）
  return {
    async review(exercise, code) {
      const cacheKey = computeReviewCacheKey(exercise.filePath, exercise.versionHash, code);
      const result = await cache.getReview(
        { cacheKey, exerciseId: exercise.id, versionHash: exercise.versionHash },
        () => limit(() => callReviewLLM(
          { problemStatement: exercise.problemStatement, testCases: exercise.testCases, code }, opts)),
      );
      logEvent({ event: "review.completed", level: "debug", data: { exerciseId: exercise.id, cacheKey, status: result.status, source: result.source } });
      return result;
    },
  };
}
