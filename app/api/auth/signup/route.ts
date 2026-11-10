import { authenticate, logout } from "@/server/auth";
import { handle } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = handle((context) => authenticate(context, true), { public: true });
