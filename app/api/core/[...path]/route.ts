import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const CORE_OVERRIDE_HEADER = "x-triaia-core-url";
const DEFAULT_CORE_URL = process.env.HTP_CORE_URL ?? "http://127.0.0.1:8081";

function normalizeCoreBaseUrl(rawUrl: string): string {
  const candidate = rawUrl.trim();
  if (!candidate) {
    throw new Error("Core URL is empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Core URL is invalid.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Core URL must use http or https.");
  }

  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function buildTargetUrl(request: NextRequest, pathSegments: string[], baseUrl: string): URL {
  const encodedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join("/");
  const target = new URL(`${baseUrl}/${encodedPath}`);
  target.search = request.nextUrl.search;
  return target;
}

async function proxyRequest(request: NextRequest, pathSegments: string[]): Promise<NextResponse> {
  try {
    const coreBase = normalizeCoreBaseUrl(request.headers.get(CORE_OVERRIDE_HEADER) ?? DEFAULT_CORE_URL);
    const target = buildTargetUrl(request, pathSegments, coreBase);

    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    const accept = request.headers.get("accept");
    if (contentType) {
      headers.set("content-type", contentType);
    }
    if (accept) {
      headers.set("accept", accept);
    }

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? await request.text() : undefined;

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: "no-store"
    });

    const responseText = await upstream.text();
    const responseHeaders = new Headers();
    const upstreamContentType = upstream.headers.get("content-type") ?? "application/json";
    responseHeaders.set("content-type", upstreamContentType);

    return new NextResponse(responseText, {
      status: upstream.status,
      headers: responseHeaders
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proxy request failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function parseSegments(params: { path?: string[] }): string[] {
  const segments = params.path ?? [];
  return segments.filter((segment) => segment.trim().length > 0);
}

export async function GET(request: NextRequest, context: { params: { path?: string[] } }): Promise<NextResponse> {
  return proxyRequest(request, parseSegments(context.params));
}

export async function POST(request: NextRequest, context: { params: { path?: string[] } }): Promise<NextResponse> {
  return proxyRequest(request, parseSegments(context.params));
}
