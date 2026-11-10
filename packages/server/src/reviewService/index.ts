import crypto from "node:crypto";
import pLimit from "p-limit";
import type { ReviewResult } from "@classroom/shared";
import type { Persistence } from "../persistence";
import { createReviewCache } from "./cache";
import { callReviewLLM, type ReviewLlmOptions } from "./llm";
import { logEvent } from "../logger";

export type { ReviewLlmOptions };

/** 评审输入：filePath 定位（回填/监控锚点），code = 组装后评审输入全文（单文件=原文件，项目=多文件拼接）；
 * tasks = 题面声明的任务名清单（≥2 = 多任务题，逐任务评审，spec 2026-11-09 §4） */
export interface ReviewInput { filePath: string; code: string; tasks?: string[] }

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
      const attempt = () => limit(() => callReviewLLM({ code: input.code, tasks: input.tasks }, opts));
      const result = await cache.getReview({ cacheKey }, attempt);
      // LLM 故障自愈（方案A配套）：繁忙/超时/抖动类失败 → 随机等 5~15 秒重试一次（not_configured 是配置缺失，重试无意义）；
      // unreviewed 不落缓存，重试会真实再打一次 LLM；学员请求同步等待最终结论
      if (result.status === "unreviewed" && result.source !== "not_configured") {
        const delay = typeof opts.retryDelayMs === "function" ? opts.retryDelayMs() : (opts.retryDelayMs ?? 5000 + Math.random() * 10_000);
        logEvent({ event: "review.retry_scheduled", level: "info", data: { filePath: input.filePath, cacheKey, delayMs: Math.round(delay), firstSource: result.source, firstReason: result.reason } });
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        const retried = await cache.getReview({ cacheKey }, attempt);
        logEvent({ event: "review.retry_completed", level: "info", data: { filePath: input.filePath, cacheKey, status: retried.status, source: retried.source } });
        return retried;
      }
      logEvent({ event: "review.completed", level: "debug", data: { filePath: input.filePath, cacheKey, status: result.status, source: result.source } });
      return result;
    },
  };
}
