import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAuth, requireStudent } from "../lib/session";
import { HttpError, dateStr, int, str, url } from "../lib/validate";

export const studentRoutes = new Hono<AppEnv>();
studentRoutes.use("*", requireAuth, requireStudent);

const VISIBLE = "t.status = 'published' AND (t.class_id IS NULL OR t.class_id = ?)";

type TaskRow = { id: number; require_review: number; step_count: number };
type ProgressRow = { status: string; percent: number };

async function loadVisibleTask(c: { env: AppEnv["Bindings"] }, taskId: number, classId: number | null) {
  const task = await c.env.DB.prepare(
    `SELECT t.id, t.require_review, (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id) AS step_count
       FROM tasks t WHERE t.id = ? AND ${VISIBLE}`,
  )
    .bind(taskId, classId)
    .first<TaskRow>();
  if (!task) throw new HttpError(404, "任务不存在或未发布");
  return task;
}

type TaskContext = TaskRow & { checked: number; step_ok: number; progress: ProgressRow | null };

// 一次往返取回任务、步骤勾选数与当前进度，减少写操作前的串行查询
async function loadTaskContext(
  c: { env: AppEnv["Bindings"] },
  taskId: number,
  user: { id: number; class_id: number | null },
  stepId = 0,
): Promise<TaskContext> {
  const db = c.env.DB;
  const [taskRes, progressRes] = await db.batch([
    db.prepare(
      `SELECT t.id, t.require_review,
              (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id) AS step_count,
              (SELECT COUNT(*) FROM step_checks sc WHERE sc.task_id = t.id AND sc.user_id = ?1) AS checked,
              EXISTS (SELECT 1 FROM task_steps s WHERE s.id = ?4 AND s.task_id = t.id) AS step_ok
         FROM tasks t
        WHERE t.id = ?2 AND t.status = 'published' AND (t.class_id IS NULL OR t.class_id = ?3)`,
    ).bind(user.id, taskId, user.class_id, stepId),
    db.prepare("SELECT status, percent FROM progress WHERE task_id = ? AND user_id = ?").bind(taskId, user.id),
  ]);
  const task = taskRes.results[0] as (TaskRow & { checked: number; step_ok: number }) | undefined;
  if (!task) throw new HttpError(404, "任务不存在或未发布");
  return { ...task, progress: (progressRes.results[0] as ProgressRow | undefined) ?? null };
}

function assertEditable(p: ProgressRow | null) {
  if (p && (p.status === "submitted" || p.status === "approved")) {
    throw new HttpError(409, p.status === "approved" ? "任务已完成，无法修改" : "已提交审核，如需修改请先撤回");
  }
}

studentRoutes.get("/tasks", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.title, t.tech_tags, t.due_date, t.require_review, t.created_at,
            (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id) AS step_count,
            p.status, COALESCE(p.percent, 0) AS percent, p.updated_at, p.review_comment, p.score
       FROM tasks t
       LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = ?
      WHERE ${VISIBLE}
      ORDER BY CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END,
               t.due_date IS NULL, t.due_date, t.id DESC`,
  )
    .bind(user.id, user.class_id)
    .all();
  return c.json({ tasks: results });
});

studentRoutes.get("/tasks/:id", async (c) => {
  const user = c.get("user");
  const id = int(c.req.param("id"), "任务ID")!;
  const [taskRes, stepsRes, progressRes, logsRes, eventsRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT t.id, t.title, t.description, t.tech_tags, t.due_date, t.require_review, t.created_at
         FROM tasks t WHERE t.id = ? AND ${VISIBLE}`,
    ).bind(id, user.class_id),
    c.env.DB.prepare(
      `SELECT s.id, s.title, s.position, (sc.step_id IS NOT NULL) AS done
         FROM task_steps s
         LEFT JOIN step_checks sc ON sc.step_id = s.id AND sc.user_id = ?
        WHERE s.task_id = ? ORDER BY s.position, s.id`,
    ).bind(user.id, id),
    c.env.DB.prepare("SELECT * FROM progress WHERE task_id = ? AND user_id = ?").bind(id, user.id),
    c.env.DB.prepare(
      "SELECT id, minutes, content, log_date, created_at FROM study_logs WHERE user_id = ? AND task_id = ? ORDER BY log_date DESC, id DESC LIMIT 50",
    ).bind(user.id, id),
    c.env.DB.prepare(
      `SELECT e.id, e.action, e.comment, e.score, e.created_at, a.name AS actor_name
         FROM progress_events e LEFT JOIN users a ON a.id = e.actor_id
        WHERE e.task_id = ? AND e.user_id = ? ORDER BY e.id DESC LIMIT 50`,
    ).bind(id, user.id),
  ]);
  const task = taskRes.results[0];
  if (!task) throw new HttpError(404, "任务不存在或未发布");
  return c.json({
    task,
    steps: stepsRes.results.map((s: any) => ({ ...s, done: !!s.done })),
    progress: progressRes.results[0] ?? null,
    logs: logsRes.results,
    events: eventsRes.results,
  });
});

studentRoutes.put("/tasks/:id/steps/:stepId", async (c) => {
  const user = c.get("user");
  const taskId = int(c.req.param("id"), "任务ID")!;
  const stepId = int(c.req.param("stepId"), "步骤ID")!;
  const { done } = await c.req.json<{ done: boolean }>();
  const task = await loadTaskContext(c, taskId, user, stepId);
  if (!task.step_ok) throw new HttpError(404, "步骤不存在");
  assertEditable(task.progress);

  const toggle = done
    ? c.env.DB.prepare("INSERT OR IGNORE INTO step_checks (user_id, step_id, task_id) VALUES (?, ?, ?)").bind(user.id, stepId, taskId)
    : c.env.DB.prepare("DELETE FROM step_checks WHERE user_id = ? AND step_id = ?").bind(user.id, stepId);

  const results = await c.env.DB.batch([
    toggle,
    c.env.DB.prepare(
      `INSERT INTO progress (task_id, user_id, status, percent, updated_at)
       VALUES (?1, ?2, 'doing', (SELECT CAST(COUNT(*) * 100 / CAST(?3 AS INTEGER) AS INTEGER) FROM step_checks WHERE task_id = ?1 AND user_id = ?2), unixepoch())
       ON CONFLICT (task_id, user_id) DO UPDATE SET
         status = CASE WHEN status = 'rejected' THEN 'rejected' ELSE 'doing' END,
         percent = excluded.percent, updated_at = unixepoch()
       RETURNING status, percent`,
    ).bind(taskId, user.id, task.step_count || 1),
  ]);
  return c.json({ progress: results[1].results[0] });
});

studentRoutes.put("/tasks/:id/progress", async (c) => {
  const user = c.get("user");
  const taskId = int(c.req.param("id"), "任务ID")!;
  const body = await c.req.json();
  const task = await loadTaskContext(c, taskId, user);
  assertEditable(task.progress);

  const note = str(body.note, "学习笔记", { optional: true, max: 2000 });
  const link = url(body.link);
  const manualPercent = task.step_count === 0 ? int(body.percent, "进度", { min: 0, max: 100, optional: true }) : null;

  const row = await c.env.DB.prepare(
    `INSERT INTO progress (task_id, user_id, status, percent, note, link, updated_at)
     VALUES (?1, ?2, 'doing', COALESCE(?3, 0), ?4, ?5, unixepoch())
     ON CONFLICT (task_id, user_id) DO UPDATE SET
       percent = COALESCE(?3, percent), note = ?4, link = ?5, updated_at = unixepoch()
     RETURNING *`,
  )
    .bind(taskId, user.id, manualPercent, note, link)
    .first();
  return c.json({ progress: row });
});

studentRoutes.post("/tasks/:id/submit", async (c) => {
  const user = c.get("user");
  const taskId = int(c.req.param("id"), "任务ID")!;
  const task = await loadTaskContext(c, taskId, user);
  assertEditable(task.progress);
  if (task.checked < task.step_count) throw new HttpError(400, "请先完成所有学习步骤再提交");

  const status = task.require_review ? "submitted" : "approved";
  const row = await c.env.DB.prepare(
    `INSERT INTO progress (task_id, user_id, status, percent, submitted_at, reviewed_at, updated_at)
     VALUES (?1, ?2, ?3, 100, unixepoch(), CASE WHEN ?3 = 'approved' THEN unixepoch() END, unixepoch())
     ON CONFLICT (task_id, user_id) DO UPDATE SET
       status = ?3, percent = 100, score = NULL, reviewer_id = NULL, review_comment = '', submitted_at = unixepoch(),
       reviewed_at = CASE WHEN ?3 = 'approved' THEN unixepoch() ELSE NULL END,
       updated_at = unixepoch()
     RETURNING *`,
  )
    .bind(taskId, user.id, status)
    .first();
  return c.json({ progress: row });
});

studentRoutes.post("/tasks/:id/withdraw", async (c) => {
  const user = c.get("user");
  const taskId = int(c.req.param("id"), "任务ID")!;
  const row = await c.env.DB.prepare(
    `UPDATE progress SET status = 'doing', submitted_at = NULL, updated_at = unixepoch()
      WHERE task_id = ? AND user_id = ? AND status = 'submitted' RETURNING *`,
  )
    .bind(taskId, user.id)
    .first();
  if (!row) throw new HttpError(409, "当前状态无法撤回");
  return c.json({ progress: row });
});

studentRoutes.get("/logs", async (c) => {
  const user = c.get("user");
  const [logs, daily] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT l.id, l.minutes, l.content, l.log_date, l.created_at, l.task_id, t.title AS task_title
         FROM study_logs l LEFT JOIN tasks t ON t.id = l.task_id
        WHERE l.user_id = ? ORDER BY l.log_date DESC, l.id DESC LIMIT 100`,
    ).bind(user.id),
    c.env.DB.prepare(
      `SELECT log_date, SUM(minutes) AS minutes, COUNT(*) AS count
         FROM study_logs WHERE user_id = ? GROUP BY log_date ORDER BY log_date DESC LIMIT 90`,
    ).bind(user.id),
  ]);
  return c.json({ logs: logs.results, daily: daily.results });
});

studentRoutes.post("/logs", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const content = str(body.content, "学习内容", { max: 2000 });
  const minutes = int(body.minutes, "学习时长", { min: 0, max: 1440 })!;
  const logDate = dateStr(body.log_date, "日期", false)!;
  const taskId = int(body.task_id, "关联任务", { optional: true });
  if (taskId) await loadVisibleTask(c, taskId, user.class_id);
  const row = await c.env.DB.prepare(
    "INSERT INTO study_logs (user_id, task_id, minutes, content, log_date) VALUES (?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(user.id, taskId, minutes, content, logDate)
    .first();
  return c.json({ log: row });
});

studentRoutes.patch("/logs/:id", async (c) => {
  const user = c.get("user");
  const id = int(c.req.param("id"), "日志ID")!;
  const body = await c.req.json();
  const content = str(body.content, "学习内容", { max: 2000 });
  const minutes = int(body.minutes, "学习时长", { min: 0, max: 1440 })!;
  const logDate = dateStr(body.log_date, "日期", false)!;
  const taskId = int(body.task_id, "关联任务", { optional: true });
  if (taskId) await loadVisibleTask(c, taskId, user.class_id);
  const row = await c.env.DB.prepare(
    "UPDATE study_logs SET content = ?, minutes = ?, log_date = ?, task_id = ? WHERE id = ? AND user_id = ? RETURNING id",
  )
    .bind(content, minutes, logDate, taskId, id, user.id)
    .first();
  if (!row) throw new HttpError(404, "日志不存在");
  return c.json({ log: row });
});

studentRoutes.delete("/logs/:id", async (c) => {
  const user = c.get("user");
  const id = int(c.req.param("id"), "日志ID")!;
  await c.env.DB.prepare("DELETE FROM study_logs WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return c.json({ ok: true });
});
