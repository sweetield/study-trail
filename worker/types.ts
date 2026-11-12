export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

export interface SessionUser {
  id: number;
  username: string;
  name: string;
  role: "admin" | "student";
  class_id: number | null;
  class_name: string | null;
  must_change_password: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser; sessionId: string };
};
