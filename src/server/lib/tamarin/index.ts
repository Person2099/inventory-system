import { Hono } from "hono";
import { getTamarinService } from "./service";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`${key} must be set in environment`);
  return val;
}

export function mountTamarinRoutes(app: Hono): void {
  const service = getTamarinService();
  if (!service) return;

  const bearerToken = requireEnv("TAMARIN_API_BEARER_TOKEN");

  const router = new Hono();

  router.use("/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (token !== bearerToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  router.get("/members/:studentNumber", async (c) => {
    const studentNumber = c.req.param("studentNumber");
    try {
      const member = await service.getMember(studentNumber);
      return c.json(member);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "NOT_FOUND") {
        return c.json({ error: "Member not found" }, 404);
      }
      if ((err as { notionStatus?: number }).notionStatus) {
        return c.json({ error: (err as Error).message }, 502);
      }
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  router.get("/projects", async (c) => {
    try {
      const projects = await service.getProjects();
      return c.json(projects);
    } catch (err) {
      if ((err as { notionStatus?: number }).notionStatus) {
        return c.json({ error: (err as Error).message }, 502);
      }
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  router.post("/afterhours", async (c) => {
    let body: { message?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    if (typeof body.message !== "string" || !body.message) {
      return c.json({ error: "message is required" }, 400);
    }

    try {
      const result = await service.postAfterHours({ message: body.message });
      return c.json(result);
    } catch {
      return c.json({ error: "Failed to send message" }, 502);
    }
  });

  app.route("/api/tamarin", router);
}
