import crypto from "node:crypto";
import pLimit from "p-limit";
import type { Exercise, ReviewResult } from "@classroom/shared";
import type { Persistence } from "../persistence";
import { createReviewCache } from "./cache";
import { callReviewLLM, type ReviewLlmOptions } from "./llm";
import { logEvent } from "../logger";

export type ReviewableExercise = Pick<Exercise, "id" | "versionHash" | "problemStatement" | "testCases">;

export interface ReviewService {
  review(exercise: ReviewableExercise, code: string): Promise<ReviewResult>;
}

export function computeReviewCacheKey(exerciseId: string, versionHash: string, code: string): string {
  return crypto.createHash("sha256").update(exerciseId + versionHash + code).digest("hex").slice(0, 32);
}

export function createReviewService(p: Persistence, opts: ReviewLlmOptions = {}): ReviewService {
  const cache = createReviewCache(p);
  const limit = pLimit(5);   // A11：真正的并发限制（pending Map 只去重同 key）
  return {
    async review(exercise, code) {
      const cacheKey = computeReviewCacheKey(exercise.id, exercise.versionHash, code);
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
