import { getCircles, postCircles } from "@/server/api";
import { handle } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(getCircles, { public: false });
export const POST = handle(postCircles, { public: false });
