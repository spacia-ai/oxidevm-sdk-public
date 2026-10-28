import type { ImagePreparation } from "../../values.js";
import { integer, protocolError, string } from "../decode.js";

export type ImageAcquisitionReason = "first-install" | "automatic" | "update" | "import" | "repair";
export type ImagePreparationStage = "download" | "verify" | "commit";

export interface ImagePreparationReport {
  readonly completedBytes: number;
  readonly totalBytes: number;
  readonly stage?: ImagePreparationStage;
  readonly downloadedBytes?: number;
  readonly requestCount?: number;
  readonly imageSHA256?: string;
  readonly reason?: ImageAcquisitionReason;
}
export const IMAGE_PREPARATION_DETAILS = ["stage", "downloadedBytes", "requestCount", "imageSHA256", "reason"] as const;

/** Envelope owners validate exact keys; this decoder validates the shared installation facts. */
export function decodeImagePreparationReport(value: Readonly<Record<string, unknown>>): ImagePreparationReport {
  const totalBytes = integer(value["totalBytes"], "image bytes", 0), completedBytes = integer(value["completedBytes"], "prepared bytes", 0, totalBytes);
  const stage = value["stage"];
  if (stage !== undefined && stage !== "download" && stage !== "verify" && stage !== "commit") throw protocolError("invalid image preparation stage");
  const imageSHA256 = value["imageSHA256"] === undefined ? undefined : string(value["imageSHA256"], "image digest");
  if (imageSHA256 !== undefined && !/^[0-9a-f]{64}$/u.test(imageSHA256)) throw protocolError("invalid prepared image identity");
  return { completedBytes, totalBytes, ...(stage === undefined ? {} : { stage }),
    ...(imageSHA256 === undefined ? {} : { imageSHA256 }), ...(value["reason"] === undefined ? {} : { reason: decodeImageAcquisitionReason(value["reason"]) }),
    ...(value["downloadedBytes"] === undefined ? {} : { downloadedBytes: integer(value["downloadedBytes"], "downloaded image bytes", 0) }),
    ...(value["requestCount"] === undefined ? {} : { requestCount: integer(value["requestCount"], "image requests", 0) }) };
}

export function decodeImagePreparation(value: unknown): ImagePreparation {
  if (value === undefined) return "on-demand";
  if (value !== "on-demand" && value !== "before-ready") throw protocolError("imagePreparation must be on-demand or before-ready");
  return value;
}
export function decodeImageAcquisitionReason(value: unknown): ImageAcquisitionReason {
  if (value === undefined) return "automatic";
  if (value !== "first-install" && value !== "automatic" && value !== "update" && value !== "import" && value !== "repair") throw protocolError("invalid image acquisition reason");
  return value;
}
