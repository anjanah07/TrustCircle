import { authenticate, logout } from "@/server/auth";
import { handle } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handle(
  async (context) =>
    Response.json({
      id: context.user.id,
      name: context.user.name,
      username: context.user.username,
    }),
  { public: false },
);
