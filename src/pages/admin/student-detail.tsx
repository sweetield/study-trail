import { useState } from "react";
import { Link, useParams } from "react-router";
import useSWR from "swr";
import { ArrowLeft, ArrowUpRight, ExternalLink, NotebookPen, X } from "lucide-react";
import type { ProgressStatus } from "@/lib/types";
import { statusMeta } from "@/lib/status";
import { cn, formatMinutes, formatTime } from "@/lib/utils";
import { Badge, Button, Card, CardHeader, EmptyState, PageLoader, ProgressBar, StatCard } from "@/components/ui";
import { StarScore } from "@/components/star-rating";

interface Detail {
  student: { id: number; username: string; name: string; class_name: string | null; active: number; last_login_at: number | null; created_at: number };
  tasks: { id: number; title: string; due_date: string | null; status: ProgressStatus | null; percent: number; note: string | null; link: string | null; score: number | null; updated_at: number | null }[];
  logs: { id: number; minutes: number; content: string; log_date: string; task_id: number | null; task_title: string | null }[];
}

export default function AdminStudentDetail() {
  const { id } = useParams();
  const { data, error } = useSWR<Detail>(`/api/admin/students/${id}`);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  if (error) return <EmptyState title="学员不存在" />;
  if (!data) return <PageLoader />;
  const { student, tasks, logs } = data;
  const done = tasks.filter((t) => t.status === "approved").length;
  const avg = tasks.length ? Math.round(tasks.reduce((s, t) => s + t.percent, 0) / tasks.length) : 0;

  const logStats = new Map<number, { count: number; minutes: number }>();
  for (const l of logs) {
    if (l.task_id == null) continue;
    const s = logStats.get(l.task_id) ?? { count: 0, minutes: 0 };
    logStats.set(l.task_id, { count: s.count + 1, minutes: s.minutes + l.minutes });
  }
  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;
  const visibleLogs = selectedTask ? logs.filter((l) => l.task_id === selectedTask.id) : logs;
  const visibleMinutes = visibleLogs.reduce((s, l) => s + l.minutes, 0);

  return (
    <div className="flex flex-col gap-6">
      <Link to="/admin/students" className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> 学员管理
      </Link>
      <div className="flex items-center gap-4">
        <span className="flex size-14 items-center justify-center rounded-full bg-primary-soft text-xl font-semibold text-primary">{student.name.slice(0, 1)}</span>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {student.name}
            {!student.active && <Badge>已停用</Badge>}
          </h1>
          <p className="text-sm text-muted-foreground">
            {student.username} · {student.class_name ?? "未分班"} · 最近登录 {formatTime(student.last_login_at)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="已完成任务" value={`${done}/${tasks.length}`} />
        <StatCard label="平均进度" value={`${avg}%`} />
        <StatCard label="待审核" value={tasks.filter((t) => t.status === "submitted").length} />
        <StatCard label="近期学习" value={formatMinutes(logs.reduce((s, l) => s + l.minutes, 0))} hint={`最近 ${logs.length} 条日志`} />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="任务进度" description="点击任务，右侧只显示该任务的学习日志" />
          {tasks.length ? (
            <ul className="divide-y">
              {tasks.map((t) => {
                const meta = statusMeta(t.status);
                const stats = logStats.get(t.id);
                const selected = t.id === selectedTaskId;
                return (
                  <li key={t.id} className={cn("relative transition-colors", selected ? "bg-primary-soft/50" : "hover:bg-muted/40")}>
                    {selected && <span className="absolute inset-y-0 left-0 w-1 bg-primary" aria-hidden="true" />}
                    <button
                      type="button"
                      onClick={() => setSelectedTaskId(selected ? null : t.id)}
                      aria-pressed={selected}
                      className="flex w-full flex-col gap-2 px-5 py-3.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    >
                      <div className="flex items-center justify-between gap-3 pr-8">
                        <span className={cn("truncate text-sm font-medium", selected && "text-primary")}>{t.title}</span>
                          <span className="flex shrink-0 items-center gap-2">
                            {t.status === "approved" && <StarScore score={t.score} />}
                            <Badge tone={meta.tone}>{meta.label}</Badge>
                          </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <ProgressBar value={t.percent} tone={t.status === "submitted" ? "warning" : t.status ? "primary" : "muted"} />
                        <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{t.percent}%</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{stats ? `${stats.count} 条日志 · ${formatMinutes(stats.minutes)}` : "暂无关联日志"}</span>
                    </button>
                    <Link
                      to={`/admin/tasks/${t.id}`}
                      className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={`查看任务「${t.title}」`}
                      title="查看任务"
                    >
                      <ArrowUpRight className="size-4" />
                    </Link>
                    {(t.note || t.link) && (
                      <div className="mx-5 mb-3.5 -mt-1 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                        {t.note && <p className="line-clamp-2 whitespace-pre-wrap">{t.note}</p>}
                        {t.link && (
                          <a href={t.link} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 break-all text-primary hover:underline">
                            <ExternalLink className="size-3 shrink-0" /> {t.link}
                          </a>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title="暂无分配的任务" />
          )}
        </Card>

        <Card className="lg:sticky lg:top-6 lg:col-span-2">
          <CardHeader
            title="学习日志"
            description={selectedTask ? `「${selectedTask.title}」· ${visibleLogs.length} 条 · ${formatMinutes(visibleMinutes)}` : `全部任务 · ${logs.length} 条`}
            action={
              selectedTask && (
                <Button variant="ghost" size="sm" onClick={() => setSelectedTaskId(null)}>
                  <X aria-hidden="true" /> 显示全部
                </Button>
              )
            }
          />
          {visibleLogs.length ? (
            <ul className="divide-y lg:max-h-[70vh] lg:overflow-y-auto" aria-live="polite">
              {visibleLogs.map((l) => (
                <li key={l.id} className="flex flex-col gap-1 px-5 py-3">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{l.log_date}</span>
                    <span className="tabular-nums">{formatMinutes(l.minutes)}</span>
                  </div>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{l.content}</p>
                  {!selectedTask && l.task_title && <span className="text-xs text-muted-foreground">关联：{l.task_title}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<NotebookPen />} title={selectedTask ? "该任务暂无学习日志" : "暂无日志"} />
          )}
        </Card>
      </div>
    </div>
  );
}
