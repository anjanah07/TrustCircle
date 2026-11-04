import { postCirclesIdClose } from "@/server/api";
import { handle } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle(postCirclesIdClose, { public: false });
