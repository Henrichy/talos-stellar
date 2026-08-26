import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("@/lib/reputation-ledger", () => ({
  fetchReputations: vi.fn().mockResolvedValue(new Map()),
}));

import { GET as servicesGET } from "@/app/api/services/route";

function chain(rows: unknown[]) {
  const result: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "innerJoin"]) {
    result[method] = vi.fn(() => result);
  }
  result.limit = vi.fn(() => result);
  result.then = vi.fn((onFulfilled: (value: unknown[]) => unknown) =>
    Promise.resolve(onFulfilled(rows)),
  );
  return result;
}

function request(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/services");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new NextRequest(url);
}

const timestamp = new Date("2026-01-01T00:00:00.000Z");
const services = [
  { id: "service-b", talosId: "talos-b", talosName: "B", talosCategory: "Development", serviceName: "B", description: null, price: "2", currency: "USDC", chains: ["stellar"], createdAt: timestamp },
  { id: "service-a", talosId: "talos-a", talosName: "A", talosCategory: "Development", serviceName: "A", description: null, price: "1", currency: "USDC", chains: ["stellar"], createdAt: timestamp },
];

describe("GET /api/services cursor pagination", () => {
  it("paginates timestamp ties without duplication", async () => {
    mockDb.select
      .mockReturnValueOnce(chain(services))
      .mockReturnValueOnce(chain([services[1]]));

    const first = await servicesGET(request({ limit: "1" }));
    const firstBody = await first.json();
    expect(firstBody.data.map((service: { serviceName: string }) => service.serviceName)).toEqual(["B"]);
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    expect(firstBody.nextCursor).not.toContain("|");

    const second = await servicesGET(request({ limit: "1", cursor: firstBody.nextCursor }));
    const secondBody = await second.json();
    expect(secondBody.data.map((service: { serviceName: string }) => service.serviceName)).toEqual(["A"]);
    expect(secondBody.nextCursor).toBeNull();
  });

  it("returns null nextCursor for empty results", async () => {
    mockDb.select.mockReturnValue(chain([]));
    const response = await servicesGET(request({ limit: "1" }));
    expect((await response.json()).nextCursor).toBeNull();
  });

  it.each(["not-a-cursor", "", "e30="])('rejects invalid cursor "%s"', async (cursor) => {
    const response = await servicesGET(request({ cursor }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("cursor");
  });
});
