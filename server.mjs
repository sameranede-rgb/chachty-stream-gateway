import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 10000);

const SECRET = String(
  process.env.PLAYBACK_RESOLVER_SECRET || ""
).trim();

const MOVIEBOX_API_URL = String(
  process.env.MOVIEBOX_API_URL || ""
).trim().replace(/\/+$/, "");

const TOKEN_TTL = Math.max(
  60,
  Number(process.env.STREAM_TOKEN_TTL_SECONDS || 300)
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Range",
  "Access-Control-Expose-Headers":
    "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified"
};

function sendJson(res, body, status = 200) {
  const data = JSON.stringify(body);

  res.writeHead(status, {
    ...corsHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(data);
}

function text(value) {
  return String(value ?? "").trim();
}

async function fetchTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function createToken(payload) {
  if (!SECRET) {
    throw new Error("PLAYBACK_RESOLVER_SECRET is not configured");
  }

  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(body)
    .digest("hex");

  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (!SECRET || !token) return null;

  const [body, signature] = token.split(".");

  if (!body || !signature) return null;

  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(body)
    .digest("hex");

  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    )
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString()
    );

    if (
      !payload.exp ||
      Number(payload.exp) <
        Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function normalizeSources(body) {
  if (!Array.isArray(body?.sources)) return [];

  return body.sources
    .map((source, index) => {
      const url = text(source?.url);

      try {
        const parsed = new URL(url);

        if (parsed.protocol !== "https:") return null;

        let format = text(
          source?.format || source?.type
        ).toLowerCase();

        if (!["mp4", "hls", "dash"].includes(format)) {
          if (/\.m3u8(?:$|[?#])/i.test(url)) {
            format = "hls";
          } else if (/\.mpd(?:$|[?#])/i.test(url)) {
            format = "dash";
          } else if (/\.mp4(?:$|[?#])/i.test(url)) {
            format = "mp4";
          }
        }

        if (!format) return null;

        return {
          id: text(source?.id) || `moviebox-${index}`,
          url,
          format,
          quality: text(
            source?.resolution ||
              source?.quality ||
              "Auto"
          )
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function resolveMovieBox(req, payload) {
  if (!MOVIEBOX_API_URL) {
    return {
      success: false,
      error: "MOVIEBOX_API_URL_NOT_CONFIGURED"
    };
  }

  const subjectId = text(payload?.subjectId);
  const detailPath = text(payload?.detailPath);

  if (!/^\d+$/.test(subjectId) || !detailPath) {
    return {
      success: false,
      error: "INVALID_SUBJECT_ID_OR_DETAIL_PATH"
    };
  }

  const season = Math.max(
    0,
    Number(payload?.season || 0)
  );

  const episode = Math.max(
    0,
    Number(payload?.episode || 0)
  );

  const resolution = text(payload?.resolution);

  const params = new URLSearchParams({
    detail_path: detailPath,
    se: String(season),
    ep: String(episode)
  });

  const response = await fetchTimeout(
    `${MOVIEBOX_API_URL}/api/stream/${encodeURIComponent(
      subjectId
    )}?${params}`,
    {
      headers: {
        Accept: "application/json"
      }
    }
  );

  const body = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    return {
      success: false,
      error: "MOVIEBOX_API_ERROR",
      status: response.status
    };
  }

  let sources = normalizeSources(body);

  if (resolution) {
    const requested = resolution.replace(/\D/g, "");

    const exact = sources.filter(
      source =>
        source.quality.replace(/\D/g, "") === requested
    );

    if (exact.length) {
      sources = [
        ...exact,
        ...sources.filter(
          source => !exact.includes(source)
        )
      ];
    }
  }

  sources.sort((a, b) => {
    const formatScore = {
      mp4: 3,
      hls: 2,
      dash: 1
    };

    const scoreDiff =
      (formatScore[b.format] || 0) -
      (formatScore[a.format] || 0);

    if (scoreDiff !== 0) return scoreDiff;

    const aq =
      Number(a.quality.replace(/\D/g, "")) || 0;

    const bq =
      Number(b.quality.replace(/\D/g, "")) || 0;

    return bq - aq;
  });

  const origin = `http://${req.headers.host}`;

  const sourcesOut = [];

  for (const source of sources.slice(0, 12)) {
    const token = createToken({
      subjectId,
      detailPath,
      season,
      episode,
      resolution: source.quality.replace(/\D/g, "")
    });

    sourcesOut.push({
      id: source.id,
      provider: "MovieBox",
      name: `MovieBox • ${source.quality}`,
      url: `${origin}/stream?token=${encodeURIComponent(token)}`,
      type: "stream",
      format: source.format,
      quality: source.quality,
      playable: true,
      status: "online"
    });
  }

  return {
    success: sourcesOut.length > 0,
    source: sourcesOut[0] || null,
    sources: sourcesOut,
    diagnostics: {
      provider: "MovieBox API",
      upstreamSourceCount: sources.length
    }
  };
}

async function streamMovieBox(req, res, payload) {
  if (!MOVIEBOX_API_URL) {
    return sendJson(
      res,
      {
        success: false,
        error: "MOVIEBOX_API_URL_NOT_CONFIGURED"
      },
      503
    );
  }

  const subjectId = text(payload.subjectId);
  const detailPath = text(payload.detailPath);

  if (!/^\d+$/.test(subjectId) || !detailPath) {
    return sendJson(
      res,
      {
        success: false,
        error: "INVALID_STREAM_TOKEN"
      },
      400
    );
  }

  const params = new URLSearchParams({
    detail_path: detailPath,
    se: String(Number(payload.season || 0)),
    ep: String(Number(payload.episode || 0))
  });

  if (payload.resolution) {
    params.set(
      "resolution",
      text(payload.resolution)
    );
  }

  const headers = {
    Accept:
      "video/*, application/octet-stream;q=0.9, */*;q=0.8",
    "User-Agent": "Chachty-Stream-Gateway/1.0"
  };

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  const upstream = await fetchTimeout(
    `${MOVIEBOX_API_URL}/watch/${encodeURIComponent(
      subjectId
    )}?${params}`,
    {
      method: req.method,
      headers
    }
  );

  if (!upstream.ok) {
    return sendJson(
      res,
      {
        success: false,
        error: "MOVIEBOX_STREAM_ERROR",
        status: upstream.status
      },
      upstream.status
    );
  }

  const responseHeaders = {
    ...corsHeaders,
    "Cache-Control": "no-store",
    "Accept-Ranges":
      upstream.headers.get("accept-ranges") || "bytes"
  };

  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "etag",
    "last-modified"
  ]) {
    const value = upstream.headers.get(name);

    if (value) {
      responseHeaders[
        name.replace(
          /(^|-)(\w)/g,
          (_, __, c) => c.toUpperCase()
        )
      ] = value;
    }
  }

  res.writeHead(
    upstream.status,
    responseHeaders
  );

  if (req.method === "HEAD") {
    return res.end();
  }

  if (!upstream.body) {
    return res.end();
  }

  const reader = upstream.body.getReader();

  try {
    while (true) {
      const { done, value } =
        await reader.read();

      if (done) break;

      if (!res.write(value)) {
        await new Promise(resolve =>
          res.once("drain", resolve)
        );
      }
    }

    res.end();
  } catch (error) {
    console.error(
      "[Chachty stream]",
      error
    );

    res.destroy();
  }
}

const server = http.createServer(
  async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        return res.end();
      }

      const url = new URL(
        req.url,
        `http://${req.headers.host}`
      );

      if (
        url.pathname === "/health" &&
        req.method === "GET"
      ) {
        return sendJson(res, {
          success: true,
          service: "chachty-stream-gateway",
          configured: Boolean(
            SECRET && MOVIEBOX_API_URL
          ),
          provider: MOVIEBOX_API_URL
            ? "moviebox-api"
            : null,
          streamProxy: true,
          timestamp:
            new Date().toISOString()
        });
      }

      if (
        url.pathname === "/debug/h5" &&
        req.method === "GET"
      ) {
        const h5 = "https://h5-api.aoneroom.com/wefeed-h5api-bff/home?host=moviebox.ph";
        const upstream = await fetchTimeout(h5, {
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0"
          }
        }, 20000);
        const body = await upstream.text();
        return sendJson(res, {
          ok: upstream.ok,
          status: upstream.status,
          contentType: upstream.headers.get("content-type"),
          bodyPreview: body.slice(0, 500)
        }, upstream.ok ? 200 : 502);
      }

      if (
        url.pathname === "/resolve" &&
        req.method === "POST"
      ) {
        if (!SECRET) {
          return sendJson(
            res,
            {
              success: false,
              error:
                "PLAYBACK_RESOLVER_SECRET_NOT_CONFIGURED"
            },
            503
          );
        }

        if (
          req.headers.authorization !==
          `Bearer ${SECRET}`
        ) {
          return sendJson(
            res,
            {
              success: false,
              error: "UNAUTHORIZED"
            },
            401
          );
        }

        let body = "";

        for await (const chunk of req) {
          body += chunk;
        }

        const payload = JSON.parse(body);

        const result =
          await resolveMovieBox(
            req,
            payload
          );

        return sendJson(res, result);
      }

      if (
        url.pathname === "/stream" &&
        req.method === "GET"
      ) {
        const token =
          url.searchParams.get("token") || "";

        const payload =
          verifyToken(token);

        if (!payload) {
          return sendJson(
            res,
            {
              success: false,
              error:
                "INVALID_OR_EXPIRED_STREAM_TOKEN"
            },
            401
          );
        }

        return streamMovieBox(
          req,
          res,
          payload
        );
      }

      return sendJson(
        res,
        {
          success: false,
          error: "NOT_FOUND"
        },
        404
      );
    } catch (error) {
      console.error(
        "[Chachty Gateway]",
        error
      );

      if (!res.headersSent) {
        return sendJson(
          res,
          {
            success: false,
            error: "INTERNAL_SERVER_ERROR"
          },
          500
        );
      }

      res.destroy();
    }
  }
);

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Chachty Stream Gateway listening on port ${PORT}`
  );
});
