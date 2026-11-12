import type { ProgressStatus } from "./types";

export const STATUS_META: Record<ProgressStatus | "todo", { label: string; tone: "muted" | "primary" | "warning" | "destructive" | "success" }> = {
  todo: { label: "未开始", tone: "muted" },
  doing: { label: "学习中", tone: "primary" },
  submitted: { label: "待审核", tone: "warning" },
  approved: { label: "已完成", tone: "success" },
  rejected: { label: "需修改", tone: "destructive" },
};

export const TASK_STATUS_LABEL = { published: "已发布", draft: "草稿", archived: "已归档" } as const;

export function statusMeta(status: ProgressStatus | null | undefined) {
  return STATUS_META[status ?? "todo"];
}
