import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceServices } from "@/db/schema";
import { and, desc, eq, ilike, lt, ne, or } from "drizzle-orm";
import { parseLimit } from "@/lib/parse-limit";
import { fetchReputations } from "@/lib/reputation-ledger";
import { withTraceContext } from "@/lib/tracing";

type ServiceCursor = {
  createdAt: string;
  id: string;
};

function encodeCursor(cursor: ServiceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): ServiceCursor | null {
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<ServiceCursor>;
    const date = new Date(parsed.createdAt ?? "");
    if (
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(date.getTime()) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      return null;
    }
    return { createdAt: date.toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

// GET /api/services — Discover available services across all TALOS agents
async function handleGet(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category");
    const selfId = searchParams.get("self");
    const cursor = decodeCursor(searchParams.get("cursor"));
    if (searchParams.has("cursor") && !cursor) {
      return Response.json({ error: "cursor must be a valid service cursor" }, { status: 400 });
    }
    const parsedLimit = parseLimit(searchParams.get("limit"), 50, 100);
    if (!parsedLimit.ok) return parsedLimit.response;
    const limit = parsedLimit.limit;

    const minScore = searchParams.has("minScore") ? Number(searchParams.get("minScore")) : undefined;
    const minConfidence = searchParams.has("minConfidence") ? Number(searchParams.get("minConfidence")) : undefined;
    const allowColdStart = searchParams.get("allowColdStart") === "true";

    let currentCursor = cursor;
    const accumulated: any[] = [];
    let exhausted = false;

    // Loop until we fulfill the limit or exhaust the DB
    while (accumulated.length < limit && !exhausted) {
      const conditions = [eq(tlsTalos.status, "Active")];

      // Exclude the requesting TALOS's own services
      if (selfId) {
        conditions.push(ne(tlsCommerceServices.talosId, selfId));
      }

      // Filter by TALOS category (case-insensitive match in DB)
      if (category) {
        conditions.push(ilike(tlsTalos.category, category));
      }

      // Cursor condition (createdAt DESC with id tiebreaker)
      if (currentCursor) {
        conditions.push(
          or(
            lt(tlsCommerceServices.createdAt, new Date(currentCursor.createdAt)),
            and(
              eq(tlsCommerceServices.createdAt, new Date(currentCursor.createdAt)),
              lt(tlsCommerceServices.id, currentCursor.id),
            ),
          )!,
        );
      }

      const services = await db
        .select({
          id: tlsCommerceServices.id,
          talosId: tlsCommerceServices.talosId,
          talosName: tlsTalos.name,
          talosCategory: tlsTalos.category,
          serviceName: tlsCommerceServices.serviceName,
          description: tlsCommerceServices.description,
          price: tlsCommerceServices.price,
          currency: tlsCommerceServices.currency,
          chains: tlsCommerceServices.chains,
          createdAt: tlsCommerceServices.createdAt,
        })
        .from(tlsCommerceServices)
        .innerJoin(tlsTalos, eq(tlsCommerceServices.talosId, tlsTalos.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(tlsCommerceServices.createdAt), desc(tlsCommerceServices.id))
        .limit(limit * 2);

      if (services.length === 0) {
        exhausted = true;
        break;
      }

      if (services.length < limit * 2) {
        exhausted = true;
      }

      const talosIds = Array.from(new Set(services.map((s) => s.talosId)));
      const reputations = await fetchReputations(talosIds, new Date());

      for (const service of services) {
        let valid = true;
        
        if (minScore !== undefined || minConfidence !== undefined || allowColdStart) {
          const rep = reputations.get(service.talosId);
          if (rep) {
            if (rep.evidence === "insufficient") {
              if (!allowColdStart) valid = false;
            } else {
              if (minScore !== undefined && rep.score < minScore) valid = false;
              if (minConfidence !== undefined && rep.confidence < minConfidence) valid = false;
            }
          } else {
            // Cold start
            if (!allowColdStart) valid = false;
          }
        }

        if (valid) {
          accumulated.push({
            id: service.id,
            talosId: service.talosId,
            talosName: service.talosName,
            talosCategory: service.talosCategory,
            serviceName: service.serviceName,
            description: service.description,
            price: Number(service.price),
            currency: service.currency,
            chains: service.chains,
            createdAt: service.createdAt,
          });
          if (accumulated.length === limit) {
            currentCursor = { createdAt: service.createdAt.toISOString(), id: service.id };
            break;
          }
        }
        currentCursor = { createdAt: service.createdAt.toISOString(), id: service.id };
      }
    }

    const nextCursor = exhausted ? null : currentCursor;

    // Remove cursor tracking fields from the output to match original payload structure
    const results = accumulated.map(({ id, createdAt, ...rest }) => rest);

    return Response.json({ data: results, nextCursor: nextCursor ? encodeCursor(nextCursor) : null });
  } catch {
    return internalError(request);
  }
}

export const GET = withTraceContext(handleGet);
