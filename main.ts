const PORT = Number(Deno.env.get("PORT") || "8000");
const HOST = Deno.env.get("HOST") || "0.0.0.0";

const RESOLVER_SECRET = String(
  Deno.env.get("PLAYBACK_RESOLVER_SECRET") || "",
).trim();

const MOVIEBOX_API_URL = String(
  Deno.env.get("MOVIEBOX_API_URL") || "",
).trim().replace(/\/+$/, "");

const STREAM_TOKEN_TTL = Math.max(
  60,
  Number(Deno.env.get("STREAM_TOKEN_TTL_SECONDS") || "300") || 300,
);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, Range",
  "access-control-expose-headers":
    "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS,
    },
  });

const text = (value: unknown) => String(value ?? "").trim();

const fetchWithTimeout = async (
  url: string,
  init: RequestInit = {},
  timeout = 15000,
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};

const base64UrlEncode = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
};

const base64UrlDecode = (value: string) => {
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);

  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new TextDecoder().decode(bytes);
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const secretKey = RESOLVER_SECRET
  ? await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(RESOLVER_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    )
  : null;

const createToken = async (payload: Record<string, unknown>) => {
  if (!secretKey) {
    throw new Error("PLAYBACK_RESOLVER_SECRET is not configured");
  }

  const encoded = base64UrlEncode(
    JSON.stringify({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + STREAM_TOKEN_TTL,
    }),
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    new TextEncoder().encode(encoded),
  );

  return `${encoded}.${hex(new Uint8Array(signature))}`;
};

const verifyToken = async (token: string) => {
  if (!secretKey) return null;

  const [encoded, signatureHex] = token.split(".");

  if (
    !encoded ||
    !signatureHex ||
    !/^[0-9a-f]{64}$/i.test(signatureHex)
  ) {
    return null;
  }

  const signature = new Uint8Array(
    signatureHex.match(/.{2}/g)!.map((x) => parseInt(x, 16)),
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    secretKey,
    signature,
    new TextEncoder().encode(encoded),
  );

  if (!valid) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encoded));

    if (!payload?.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
};

const normalizeSources = (body: any) => {
  if (!Array.isArray(body?.sources)) return [];

  return body.sources
    .map((source: any, index: number) => {
      const url = text(source?.url);

      try {
        const parsed = new URL(url);

        if (parsed.protocol !== "https:") return null;

        return {
          id: text(source?.id) || `moviebox-${index}`,
          url,
          format:
            text(source?.format || source?.type).toLowerCase() ||
            (url.includes(".m3u8") ? "hls" :
              url.includes(".mpd") ? "dash" :
              url.includes(".mp4") ? "mp4" : ""),
          quality: text(
            source?.resolution || source?.quality || "Auto",
          ),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

const resolve = async (request: Request, payload: any) => {
  if (!MOVIEBOX_API_URL) {
    return {
      success: false,
      error: "MOVIEBOX_API_URL_NOT_CONFIGURED",
    };
  }

  const subjectId = text(payload?.subjectId);
  const detailPath = text(payload?.detailPath);

  if (!/^\d+$/.test(subjectId) || !detailPath) {
    return {
      success: false,
      error: "INVALID_SUBJECT_ID_OR_DETAIL_PATH",
    };
  }

  const season = Math.max(0, Number(payload?.season || 0));
  const episode = Math.max(0, Number(payload?.episode || 0));
  const resolution = text(payload?.resolution);

  const params = new URLSearchParams({
    detail_path: detailPath,
    se: String(season),
    ep: String(episode),
  });

  const upstream = await fetchWithTimeout(
    `${MOVIEBOX_API_URL}/api/stream/${encodeURIComponent(subjectId)}?${params}`,
    {
      headers: {
        accept: "application/json",
      },
    },
  );

  const body = await upstream.json().catch(() => ({}));

  if (!upstream.ok) {
    return {
      success: false,
      error: "MOVIEBOX_API_ERROR",
      status: upstream.status,
    };
  }

  let sources = normalizeSources(body);

  if (resolution) {
    const exact = sources.filter(
      (source: any) =>
        source.quality.replace(/\D/g, "") ===
        resolution.replace(/\D/g, ""),
    );

    if (exact.length) {
      sources = [
        ...exact,
        ...sources.filter((source: any) => !exact.includes(source)),
      ];
    }
  }

  const origin = new URL(request.url).origin;

  const result = [];

  for (const source of sources.slice(0, 12)) {
    const token = await createToken({
      subjectId,
      detailPath,
      season,
      episode,
      resolution: source.quality.replace(/\D/g, ""),
    });

    result.push({
      id: source.id,
      provider: "MovieBox",
      name: `MovieBox • ${source.quality}`,
      url: `${origin}/stream?token=${encodeURIComponent(token)}`,
      type: "stream",
      format: source.format,
      quality: source.quality,
      playable: true,
      status: "online",
    });
  }

  return {
    success: true,
    source: result[0] || null,
    sources: result,
    diagnostics: {
      provider: "MovieBox API",
      upstreamSourceCount: sources.length,
    },
  };
};

const stream = async (
  request: Request,
  payload: Record<string, unknown>,
) => {
  if (!MOVIEBOX_API_URL) {
    return json(
      {
        success: false,
        error: "MOVIEBOX_API_URL_NOT_CONFIGURED",
      },
      503,
    );
  }

  const subjectId = text(payload.subjectId);
  const detailPath = text(payload.detailPath);

  if (!/^\d+$/.test(subjectId) || !detailPath) {
    return json(
      {
        success: false,
        error: "INVALID_STREAM_TOKEN",
      },
      400,
    );
  }

  const params = new URLSearchParams({
    detail_path: detailPath,
    se: String(Number(payload.season || 0)),
    ep: String(Number(payload.episode || 0)),
  });

  const resolution = text(payload.resolution);

  if (resolution) {
    params.set("resolution", resolution);
  }

  const upstream = await fetchWithTimeout(
    `${MOVIEBOX_API_URL}/watch/${encodeURIComponent(subjectId)}?${params}`,
    {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: {
        accept: "video/*, application/octet-stream;q=0.9, */*;q=0.8",
        ...(request.headers.get("range")
          ? { range: request.headers.get("range")! }
          : {}),
      },
    },
    30000,
  );

  if (!upstream.ok) {
    return json(
      {
        success: false,
        error: "MOVIEBOX_STREAM_ERROR",
        status: upstream.status,
      },
      upstream.status,
    );
  }

  const headers = new Headers(CORS);

  headers.set("cache-control", "no-store");
  headers.set(
    "accept-ranges",
    upstream.headers.get("accept-ranges") || "bytes",
  );

  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
};

const handler = async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS,
    });
  }

  const url = new URL(request.url);

  if (url.pathname === "/health" && request.method === "GET") {
    return json({
      success: true,
      service: "chachty-stream-gateway",
      configured: Boolean(RESOLVER_SECRET && MOVIEBOX_API_URL),
      provider: MOVIEBOX_API_URL ? "moviebox-api" : null,
      streamProxy: true,
      timestamp: new Date().toISOString(),
    });
  }

  if (url.pathname === "/resolve" && request.method === "POST") {
    if (!RESOLVER_SECRET) {
      return json(
        {
          success: false,
          error: "PLAYBACK_RESOLVER_SECRET_NOT_CONFIGURED",
        },
        503,
      );
    }

    if (
      request.headers.get("authorization") !==
      `Bearer ${RESOLVER_SECRET}`
    ) {
      return json(
        {
          success: false,
          error: "UNAUTHORIZED",
        },
        401,
      );
    }

    try {
      const payload = await request.json();
      return json(await resolve(request, payload));
    } catch (error) {
      console.error("[Chachty Gateway]", error);

      return json(
        {
          success: false,
          error: "RESOLVER_INTERNAL_ERROR",
        },
        500,
      );
    }
  }

  if (url.pathname === "/stream" && request.method === "GET") {
    const token = url.searchParams.get("token") || "";
    const payload = await verifyToken(token);

    if (!payload) {
      return json(
        {
          success: false,
          error: "INVALID_OR_EXPIRED_STREAM_TOKEN",
        },
        401,
      );
    }

    return stream(request, payload);
  }

  return json(
    {
      success: false,
      error: "NOT_FOUND",
    },
    404,
  );
};

console.log(
  `Chachty Stream Gateway listening on ${HOST}:${PORT}`,
);

Deno.serve(
  {
    hostname: HOST,
    port: PORT,
  },
  handler,
);
