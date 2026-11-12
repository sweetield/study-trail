import { useState, type FormEvent } from "react";
import { mutate } from "swr";
import { api } from "@/lib/api";
import { todayStr } from "@/lib/utils";
import type { StudyLog } from "@/lib/types";
import { useToast } from "./toast";
import { Button, Dialog, Field, Input, Select, Textarea } from "./ui";

const QUICK_MINUTES = [30, 60, 90, 120];

export function LogDialog({
  open,
  onClose,
  tasks,
  defaultTaskId,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  tasks: { id: number; title: string }[];
  defaultTaskId?: number;
  editing?: StudyLog | null;
}) {
  const toast = useToast();
  const [minutes, setMinutes] = useState(editing?.minutes ?? 60);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setLoading(true);
    setError("");
    try {
      const taskId = form.get("task_id");
      const payload = {
        content: form.get("content"),
        minutes,
        log_date: form.get("log_date"),
        task_id: taskId ? Number(taskId) : null,
      };
      if (editing) await api.patch(`/api/me/logs/${editing.id}`, payload);
      else await api.post("/api/me/logs", payload);
      await mutate((key) => typeof key === "string" && key.startsWith("/api/me/"));
      toast(editing ? "日志已更新" : "学习打卡成功");
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? "编辑日志" : "学习打卡"}
      description={editing ? "修改后会同步更新学习统计" : "记录今天学了什么，坚持就是进步"}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="日期" htmlFor="log_date">
            <Input id="log_date" name="log_date" type="date" defaultValue={editing?.log_date ?? todayStr()} max={todayStr()} required />
          </Field>
          <Field label="关联任务" htmlFor="task_id">
            <Select id="task_id" name="task_id" defaultValue={editing ? (editing.task_id ?? "") : (defaultTaskId ?? "")}>
              <option value="">不关联</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="学习时长" htmlFor="minutes">
          <div className="flex flex-wrap items-center gap-2">
            {QUICK_MINUTES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMinutes(m)}
                className={`h-9 rounded-lg border px-3 text-sm transition-colors ${minutes === m ? "border-primary bg-primary-soft text-primary" : "hover:bg-muted"}`}
              >
                {m < 60 ? `${m} 分钟` : `${m / 60} 小时`}
              </button>
            ))}
            <div className="flex items-center gap-1.5">
              <Input
                id="minutes"
                type="number"
                min={0}
                max={1440}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                className="h-9 w-20"
                aria-label="自定义分钟数"
              />
              <span className="text-sm text-muted-foreground">分钟</span>
            </div>
          </div>
        </Field>
        <Field label="学习内容" htmlFor="content">
          <Textarea id="content" name="content" defaultValue={editing?.content} required maxLength={2000} placeholder="例如：完成了 useEffect 的练习，理解了依赖数组的作用" />
        </Field>
        {error && (
          <p className="rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" loading={loading}>
            {editing ? "保存修改" : "提交打卡"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
