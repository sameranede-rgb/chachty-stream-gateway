import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const SECRET = String(process.env.PLAYBACK_RESOLVER_SECRET || "").trim();
const H5_API = "https://h5-api.aoneroom.com";
const BASE_URL = "https://moviebox.ph";
const DEFAULT_DOMAIN = "https://123movienow.cc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const TOKEN_TTL = Math.max(60, Number(process.env.STREAM_TOKEN_TTL_SECONDS || 300));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified, X-Stream-Resolution"
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

function text(v) {
  return String(v ?? "").trim();
}

async function fetchTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function upstreamJson(url, options = {}) {
  const response = await fetchTimeout(url, {
    ...options,
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(`Upstream returned ${response.status}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

function createToken(payload) {
  if (!SECRET) throw new Error("PLAYBACK_RESOLVER_SECRET is not configured");
  const body = Buffer.from(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  return body + "." + signature;
}

function verifyToken(token) {
  if (!SECRET || !token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    return payload.exp && Number(payload.exp) >= Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

function publicOrigin(req) {
  const forwardedProto = text(req.headers["x-forwarded-proto"]).split(",")[0];
  const proto = forwardedProto || "https";
  return `${proto}://${req.headers.host}`;
}

function normalizeItem(s) {
  return {
    name: s.title || s.name || "",
    poster_url: s.cover?.url || s.thumbnail || null,
    url: s.detailPath ? `${BASE_URL}/detail/${s.detailPath}` : null,
    slug: s.detailPath || null,
    badge: s.corner || null,
    blurhash: s.cover?.blurHash || null,
    year: s.releaseDate || null,
    rating: s.imdbRatingValue || null
  };
}

async function fetchHomeData() {
  const body = await upstreamJson(`${H5_API}/wefeed-h5api-bff/home?host=moviebox.ph`);
  const ops = body?.data?.operatingList || [];
  const sections = [];

  for (const op of ops) {
    const title = op.title || "";
    if (op.banner) {
      const items = (op.banner.items || [])
        .filter(i => i.title && !i.title.includes("Communities"))
        .map(i => ({
          name: i.title,
          poster_url: i.image?.url || i.subject?.cover?.url || null,
          url: i.detailPath ? `${BASE_URL}/detail/${i.detailPath}` : null,
          badge: i.subject?.corner || null,
          slug: i.detailPath || null
        }));
      sections.push({ section: "Banner", count: items.length, movies: items, more_url: null });
      continue;
    }
    const subs = op.subjects || [];
    if (!subs.length || !title) continue;
    sections.push({
      section: title,
      count: subs.length,
      movies: subs.map(normalizeItem),
      more_url: null
    });
  }
  return sections;
}

async function fetchCategoryData(category) {
  const typeMap = { movie: "movie", "tv-series": "tvSeries", "animated-series": "anime" };
  const filterType = typeMap[category] || category;
  const url = `${H5_API}/wefeed-h5api-bff/subject/filter?type=${encodeURIComponent(filterType)}&page=1&perPage=60`;
  const body = await upstreamJson(url);
  const items = body?.data?.items || [];
  const sectionName = category === "movie" ? "All Movies" : category === "tv-series" ? "All TV Series" : "All Animation";
  return [{ section: sectionName, more_url: null, count: items.length, movies: items.map(normalizeItem) }];
}

async function fetchRankingData() {
  const body = await upstreamJson(`${H5_API}/wefeed-h5api-bff/subject/rank-list`);
  const lists = body?.data || [];
  return (Array.isArray(lists) ? lists : [lists]).map(list => {
    const items = list.items || list.subjects || [];
    return {
      section: list.title || "Most Watched",
      more_url: null,
      count: items.length,
      movies: items.map((s, i) => ({ ...normalizeItem(s), rank: String(i + 1) }))
    };
  });
}

async function handleSearchSuggest(params) {
  const q = text(params.get("q"));
  if (!q) return { status: 400, body: { error: "q parameter required" } };
  const body = await upstreamJson(`${H5_API}/wefeed-h5api-bff/subject/search-suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword: q, perPage: 10 })
  });
  const items = body?.data?.items || [];
  return { body: { query: q, suggestions: items.map(i => i.word).filter(Boolean) } };
}

async function handleSearch(params) {
  const q = text(params.get("q"));
  if (!q) return { status: 400, body: { error: "q parameter required" } };
  const body = await upstreamJson(`${H5_API}/wefeed-h5api-bff/subject/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword: q, perPage: 30, page: 1 })
  });
  const items = body?.data?.items || [];
  const movies = items.map(normalizeItem);
  return { body: { query: q, count: movies.length, movies } };
}

async function handleDetail(slug) {
  const pageUrl = `${BASE_URL}/detail/${slug}`;
  const response = await fetchTimeout(pageUrl, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!response.ok) return { status: 404, body: { error: "Movie not found" } };
  const html = await response.text();
  const match = html.match(/<script[^>]+id="__NUXT_DATA__"[^>]*>([\\s\\S]*?)<\\/script>/);
  if (!match) return { status: 502, body: { error: "Could not find NUXT data" } };

  let nuxt;
  try { nuxt = JSON.parse(match[1]); } catch { return { status: 502, body: { error: "Failed to parse NUXT data" } }; }
  if (!Array.isArray(nuxt)) return { status: 502, body: { error: "Unexpected NUXT format" } };

  function resolve(index) {
    if (typeof index !== "number" || index < 0 || index >= nuxt.length) return index;
    const val = nuxt[index];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const out = {};
      for (const [k, v] of Object.entries(val)) out[k] = resolve(v);
      return out;
    }
    return Array.isArray(val) ? val.map(resolve) : val;
  }

  let metadata = null, seasons = [], topCast = [], reviews = [];
  for (let i = 0; i < nuxt.length; i++) {
    const resolved = resolve(i);
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) continue;
    if (resolved.subjectId && resolved.title && resolved.duration && !metadata) metadata = resolved;
    if (resolved.seasons) seasons = resolved.seasons;
    if (resolved.stars) topCast = resolved.stars;
    if (Array.isArray(resolved.items) && resolved.items.some(it => it && typeof it === "object" && it.content)) reviews = resolved.items;
  }
  if (!metadata) return { status: 404, body: { error: "Could not extract movie metadata" } };

  return {
    body: {
      slug,
      source: pageUrl,
      metadata: {
        id: metadata.subjectId,
        title: metadata.title,
        description: metadata.description,
        release_date: metadata.releaseDate,
        duration: metadata.duration,
        genre: metadata.genre,
        country: metadata.countryName,
        imdb_rating: metadata.imdbRatingValue,
        poster: metadata.cover?.url || null,
        badge: metadata.corner,
        dubs: metadata.dubs || [],
        top_cast: topCast,
        seasons,
        user_reviews: reviews.filter(r => r && typeof r === "object" && r.content).map(r => ({
          user: r.user?.nickname || null, content: r.content, created_at: r.createdAt || null
        }))
      }
    }
  };
}

async function handleEpisodes(slug) {
  const body = await upstreamJson(`${H5_API}/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(slug)}`);
  const data = body?.data || {};
  const resource = data.resource || {};
  const seasonsData = resource.seasons || [];
  const subjectId = data.subject?.subjectId || data.subjectId || resource.id || null;

  if (!seasonsData.length) return { body: { slug, message: "No seasons/episodes found. This might be a movie.", seasons: [] } };

  const seasons = seasonsData.map(s => {
    const epCount = Number(s.maxEp || 0);
    return {
      season: s.se,
      episode_count: epCount,
      episodes: Array.from({ length: epCount }, (_, i) => {
        const ep = i + 1;
        return {
          name: `Episode ${ep}`,
          ep,
          se: s.se,
          watch_url: subjectId ? `/watch/${subjectId}?detail_path=${encodeURIComponent(slug)}&se=${s.se}&ep=${ep}` : null,
          stream_api_url: subjectId ? `/api/stream/${subjectId}?detail_path=${encodeURIComponent(slug)}&se=${s.se}&ep=${ep}` : null
        };
      })
    };
  });
  return { body: { slug, subject_id: subjectId, total_seasons: seasons.length, seasons } };
}

async function discoverDomain() {
  try {
    const body = await upstreamJson(`${H5_API}/wefeed-h5api-bff/media-player/get-domain`, {
      headers: { "X-Client-Type": "h5" }
    });
    const value = typeof body?.data === "string" ? body.data : "";
    if (value) return value.replace(/\\/+$/, "");
  } catch {}
  return DEFAULT_DOMAIN;
}

async function fetchStreams(domain, subjectId, detailPath, se, ep) {
  const playUrl = `${domain}/wefeed-h5api-bff/subject/play?subjectId=${encodeURIComponent(subjectId)}&se=${encodeURIComponent(se)}&ep=${encodeURIComponent(ep)}&detailPath=${encodeURIComponent(detailPath)}`;
  const body = await upstreamJson(playUrl, {
    headers: {
      Referer: `${domain}/spa/videoPlayPage/movies/${detailPath}`,
      "X-Client-Info": '{"timezone":"Asia/Dhaka"}',
      cookie: "uuid=d8c3539e-2e46-4000-af20-7046a856e30a"
    }
  });
  return body?.data?.streams || [];
}

function normalizeSources(streams) {
  return streams.map((s, index) => {
    const url = text(s.url);
    let format = text(s.format).toLowerCase();
    if (!["mp4", "hls", "dash"].includes(format)) {
      if (/\\.m3u8(?:$|[?#])/i.test(url)) format = "hls";
      else if (/\\.mpd(?:$|[?#])/i.test(url)) format = "dash";
      else if (/\\.mp4(?:$|[?#])/i.test(url)) format = "mp4";
    }
    return {
      id: text(s.id) || `moviebox-${index}`,
      url,
      format,
      quality: s.resolutions ? `${s.resolutions}p` : "Auto",
      size_bytes: s.size || null
    };
  }).filter(s => s.url && s.format);
}

async function fetchSubtitles(subjectId, detailPath, streamId) {
  if (!streamId) return [];
  try {
    const body = await upstreamJson(`${H5_API}/wefeed-h5api-bff/subject/caption?subjectId=${subjectId}&id=${encodeURIComponent(streamId)}&detailPath=${encodeURIComponent(detailPath)}`, {
      headers: {
        "X-Client-Info": '{"timezone":"Asia/Dhaka"}',
        cookie: "uuid=d8c3539e-2e46-4000-af20-7046a856e30a"
      }
    });
    return (body?.data?.subtitles || []).filter(s => s.lan === "en" || text(s.lanName).toLowerCase().includes("english")).map(s => ({
      language: s.lanName || "English",
      url: s.url
    }));
  } catch { return []; }
}

async function resolveDirectStreams(req, payload) {
  const subjectId = text(payload?.subjectId);
  const detailPath = text(payload?.detailPath);
  if (!/^\\d+$/.test(subjectId) || !detailPath) return { success: false, error: "INVALID_SUBJECT_ID_OR_DETAIL_PATH" };

  const se = Math.max(0, Number(payload?.season || 0));
  const ep = Math.max(0, Number(payload?.episode || 0));
  const domain = await discoverDomain();
  const streams = normalizeSources(await fetchStreams(domain, subjectId, detailPath, se, ep));
  if (!streams.length) return { success: false, error: "NO_DIRECT_STREAMS" };

  streams.sort((a, b) => (Number(b.quality.replace(/\\D/g, "")) || 0) - (Number(a.quality.replace(/\\D/g, "")) || 0));
  const subtitles = await fetchSubtitles(subjectId, detailPath, streams[0]?.id);
  const origin = publicOrigin(req);

  const sources = streams.slice(0, 12).map(source => {
    const token = createToken({ subjectId, detailPath, season: se, episode: ep, resolution: source.quality.replace(/\\D/g, "") });
    return {
      id: source.id,
      provider: "MovieBox H5",
      name: `MovieBox • ${source.quality}`,
      url: `${origin}/stream?token=${encodeURIComponent(token)}`,
      direct_url: source.url,
      format: source.format,
      quality: source.quality,
      playable: true,
      status: "online"
    };
  });

  return {
    success: true,
    source: sources[0],
    sources,
    subtitles,
    diagnostics: { provider: "H5 direct from Render", upstreamSourceCount: streams.length, domain }
  };
}

async function streamDirect(req, res, payload) {
  const subjectId = text(payload.subjectId);
  const detailPath = text(payload.detailPath);
  if (!/^\\d+$/.test(subjectId) || !detailPath) return sendJson(res, { success: false, error: "INVALID_STREAM_TOKEN" }, 400);

  const se = Number(payload.season || 0);
  const ep = Number(payload.episode || 0);
  const domain = await discoverDomain();
  const streams = normalizeSources(await fetchStreams(domain, subjectId, detailPath, se, ep));
  if (!streams.length) return sendJson(res, { success: false, error: "NO_DIRECT_STREAMS" }, 404);

  let stream = streams[0];
  const requested = Number(payload.resolution || 0);
  if (requested > 0) stream = streams.find(s => Number(s.quality.replace(/\\D/g, "")) === requested) || stream;

  const headers = {
    Accept: "*/*",
    Referer: `${domain}/`,
    Origin: domain,
    "User-Agent": UA
  };
  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = await fetchTimeout(stream.url, { method: req.method, headers, redirect: "follow" });
  if (![200, 206].includes(upstream.status)) {
    const detail = (await upstream.text()).slice(0, 300);
    return sendJson(res, { success: false, error: "UPSTREAM_STREAM_ERROR", status: upstream.status, detail }, upstream.status);
  }

  const out = {
    ...corsHeaders,
    "Cache-Control": "no-store",
    "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
    "Content-Type": upstream.headers.get("content-type") || (stream.format === "mp4" ? "video/mp4" : stream.format === "hls" ? "application/vnd.apple.mpegurl" : "application/dash+xml"),
    "X-Stream-Resolution": stream.quality
  };
  for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) out[name.replace(/(^|-)(\\w)/g, (_, __, c) => c.toUpperCase())] = value;
  }

  res.writeHead(upstream.status, out);
  if (req.method === "HEAD" || !upstream.body) return res.end();

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise(resolve => res.once("drain", resolve));
    }
    res.end();
  } catch (error) {
    console.error("[Chachty stream]", error);
    res.destroy();
  }
}

async function route(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname.replace(/\\/+$/, "") || "/";

  if (p === "/health" && req.method === "GET") {
    return sendJson(res, {
      success: true,
      service: "chachty-stream-gateway",
      architecture: "render-direct-h5",
      h5Reachable: true,
      configured: Boolean(SECRET),
      playback: true,
      timestamp: new Date().toISOString()
    });
  }

  if (p === "/debug/h5" && req.method === "GET") {
    const response = await fetchTimeout(`${H5_API}/wefeed-h5api-bff/home?host=moviebox.ph`, { headers: { "User-Agent": UA, Accept: "application/json" } }, 20000);
    const body = await response.text();
    return sendJson(res, { ok: response.ok, status: response.status, contentType: response.headers.get("content-type"), bodyPreview: body.slice(0, 500) }, response.ok ? 200 : 502);
  }

  if (p === "/home" && req.method === "GET") { const sections = await fetchHomeData(); return sendJson(res, { source: `${H5_API}/wefeed-h5api-bff/home`, total_sections: sections.length, sections }); }
  if (p === "/home/sections" && req.method === "GET") {
    const sections = await fetchHomeData();
    return sendJson(res, { total: sections.length, sections: sections.map(s => ({ name: s.section, count: s.count, more_url: s.more_url })) });
  }
  if (p === "/home/banner" && req.method === "GET") {
    const sections = await fetchHomeData(); const banner = sections.find(s => s.section === "Banner");
    return sendJson(res, { count: banner?.count || 0, featured: banner?.movies || [] });
  }
  if (p === "/home/trending" && req.method === "GET" || p === "/home/hot" && req.method === "GET" || p === "/home/cinema" && req.method === "GET") {
    const sections = await fetchHomeData();
    const key = p.split("/").pop();
    const keywords = key === "trending" ? ["trending now", "popular movie"] : key === "hot" ? ["hot"] : ["cinema", "popular series"];
    const match = sections.find(s => keywords.some(k => s.section.toLowerCase().includes(k)));
    return match ? sendJson(res, match) : sendJson(res, { error: "Section not found" }, 404);
  }

  let m = p.match(/^\\/home\\/section\\/(.+)$/);
  if (m && req.method === "GET") {
    const name = decodeURIComponent(m[1]); const sections = await fetchHomeData();
    const matched = sections.filter(s => s.section.toLowerCase().includes(name.toLowerCase()));
    return matched.length ? sendJson(res, { results: matched }) : sendJson(res, { message: `No section matching '${name}'`, available: sections.map(s => s.section) }, 404);
  }

  if (p === "/movies" && req.method === "GET" || p === "/tv-series" && req.method === "GET" || p === "/animation" && req.method === "GET") {
    const category = p === "/movies" ? "movie" : p === "/tv-series" ? "tv-series" : "animated-series";
    const sections = await fetchCategoryData(category);
    return sendJson(res, { source: `${H5_API}/wefeed-h5api-bff/subject/filter`, total_sections: sections.length, sections });
  }

  m = p.match(/^\\/(movies|tv-series|animation)\\/sections$/);
  if (m && req.method === "GET") {
    const category = m[1] === "movies" ? "movie" : m[1] === "tv-series" ? "tv-series" : "animated-series";
    const sections = await fetchCategoryData(category);
    return sendJson(res, { total: sections.length, sections: sections.map(s => ({ name: s.section, count: s.count, more_url: s.more_url })) });
  }

  m = p.match(/^\\/(movies|tv-series|animation)\\/section\\/(.+)$/);
  if (m && req.method === "GET") {
    const category = m[1] === "movies" ? "movie" : m[1] === "tv-series" ? "tv-series" : "animated-series";
    const name = decodeURIComponent(m[2]); const sections = await fetchCategoryData(category);
    const matched = sections.filter(s => s.section.toLowerCase().includes(name.toLowerCase()));
    return matched.length ? sendJson(res, { results: matched }) : sendJson(res, { message: `No section matching '${name}'`, available: sections.map(s => s.section) }, 404);
  }

  if (p === "/ranking" && req.method === "GET") {
    const sections = await fetchRankingData();
    return sendJson(res, { source: `${H5_API}/wefeed-h5api-bff/subject/rank-list`, total_sections: sections.length, sections });
  }

  if (p === "/search/suggest" && req.method === "GET") {
    const result = await handleSearchSuggest(url.searchParams); return sendJson(res, result.body, result.status || 200);
  }
  if (p === "/search" && req.method === "GET") {
    const result = await handleSearch(url.searchParams); return sendJson(res, result.body, result.status || 200);
  }

  m = p.match(/^\\/detail\\/(.+)$/);
  if (m && req.method === "GET") {
    const result = await handleDetail(decodeURIComponent(m[1])); return sendJson(res, result.body, result.status || 200);
  }

  m = p.match(/^\\/episodes\\/(.+)$/);
  if (m && req.method === "GET") {
    const result = await handleEpisodes(decodeURIComponent(m[1])); return sendJson(res, result.body, result.status || 200);
  }

  m = p.match(/^\\/api\\/stream\\/(\\d+)$/);
  if (m && req.method === "GET") {
    const result = await resolveDirectStreams(req, {
      subjectId: m[1],
      detailPath: url.searchParams.get("detail_path"),
      season: url.searchParams.get("se") || 0,
      episode: url.searchParams.get("ep") || 0,
      resolution: url.searchParams.get("resolution") || 0
    });
    return sendJson(res, result, result.success ? 200 : 404);
  }

  m = p.match(/^\\/watch\\/(\\d+)$/);
  if (m && ["GET", "HEAD"].includes(req.method)) {
    return streamDirect(req, res, {
      subjectId: m[1],
      detailPath: url.searchParams.get("detail_path"),
      season: url.searchParams.get("se") || 0,
      episode: url.searchParams.get("ep") || 0,
      resolution: url.searchParams.get("resolution") || 0
    });
  }

  if (p === "/resolve" && req.method === "POST") {
    if (!SECRET) return sendJson(res, { success: false, error: "PLAYBACK_RESOLVER_SECRET_NOT_CONFIGURED" }, 503);
    if (req.headers.authorization !== `Bearer ${SECRET}`) return sendJson(res, { success: false, error: "UNAUTHORIZED" }, 401);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let payload; try { payload = JSON.parse(raw || "{}"); } catch { return sendJson(res, { success: false, error: "INVALID_JSON" }, 400); }
    return sendJson(res, await resolveDirectStreams(req, payload));
  }

  if (p === "/stream" && req.method === "GET") {
    const payload = verifyToken(url.searchParams.get("token") || "");
    if (!payload) return sendJson(res, { success: false, error: "INVALID_OR_EXPIRED_STREAM_TOKEN" }, 401);
    return streamDirect(req, res, payload);
  }

  if (p === "/" && req.method === "GET") {
    return sendJson(res, {
      service: "chachty-stream-gateway",
      architecture: "render-direct-h5",
      endpoints: ["/home", "/movies", "/tv-series", "/search", "/detail/{slug}", "/episodes/{slug}", "/api/stream/{id}", "/watch/{id}", "/resolve"]
    });
  }

  return sendJson(res, { success: false, error: "NOT_FOUND" }, 404);
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error("[Chachty Gateway]", error);
    if (!res.headersSent) sendJson(res, {
      success: false,
      error: "UPSTREAM_OR_INTERNAL_ERROR",
      detail: error?.message || "Unknown error",
      status: error?.status || 500
    }, error?.status >= 400 && error?.status < 600 ? error.status : 502);
    else res.destroy();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Chachty Gateway listening on ${PORT} (Render direct H5)`);
});
