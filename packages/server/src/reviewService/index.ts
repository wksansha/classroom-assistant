import crypto from "node:crypto";
import pLimit from "p-limit";
import type { ReviewResult } from "@classroom/shared";
import type { Persistence } from "../persistence";
import { createReviewCache } from "./cache";
import { callReviewLLM, type ReviewLlmOptions } from "./llm";
import { logEvent } from "../logger";

export type { ReviewLlmOptions };

/** 评审输入：filePath 定位（回填/监控锚点），code = 组装后评审输入全文（单文件=原文件，项目=多文件拼接） */
export interface ReviewInput { filePath: string; code: string }

export interface ReviewService {
  review(input: ReviewInput): Promise<ReviewResult>;
}

/** 作业域退役（spec §0.1）：key = sha256(filePath + 评审输入)，纯内容寻址（versionHash 已退役） */
export function computeReviewCacheKey(filePath: string, code: string): string {
  return crypto.createHash("sha256").update(filePath + code).digest("hex").slice(0, 32);
}

export function createReviewService(p: Persistence, opts: ReviewLlmOptions = {}): ReviewService {
  const cache = createReviewCache(p);
  const limit = pLimit(5);   // A11：真正的并发限制（pending Map 只去重同 key）
  return {
    async review(input) {
      const cacheKey = computeReviewCacheKey(input.filePath, input.code);
      const result = await cache.getReview(
        { cacheKey },
        () => limit(() => callReviewLLM({ code: input.code }, opts)),
      );
      logEvent({ event: "review.completed", level: "debug", data: { filePath: input.filePath, cacheKey, status: result.status, source: result.source } });
      return result;
    },
  };
}
