import { getMembersIdSettlement } from "@/server/api";
import { handle } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(getMembersIdSettlement, { public: false });
